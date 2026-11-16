import {
  MsgType,
  QQBot,
  contentSanitizer,
  mentionGate,
  messageFilter,
} from '@tencent-connect/qqbot-nodejs';
import type {
  GatewayDisconnect,
  InlineKeyboard,
  InteractionEvent,
  Logger,
  Middleware,
  QQBotEventMap,
  QQBotInboundMessage,
  QQBotOptions,
  ReconnectPolicy,
  ReplyTarget as SdkReplyTarget,
  SendMessageOptions,
  MessageResponse,
} from '@tencent-connect/qqbot-nodejs';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import type {
  AppLogger,
  ChatScope,
  InboundMessage,
  OutboundReply,
  ReplyTarget,
  RuntimeConfig,
} from '../shared/types.ts';
import { resolveQqCredentials } from './credentials.ts';
import type { ResolveQqCredentialsOptions, ResolvedQqCredentials } from './credentials.ts';
import { MsgIdCache } from './msg-id-cache.ts';
import { ReplyLimiter } from './reply-limiter.ts';
import { chunkMarkdownText, chunkText } from './text-chunk.ts';

export type InboundHandler = (message: InboundMessage) => Promise<void> | void;

export interface QqGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(reply: OutboundReply): Promise<void>;
  onInbound(handler: InboundHandler): () => void;
}

export interface QqBotClient {
  readonly appId: string;
  use(...middleware: Middleware[]): unknown;
  on<K extends keyof QQBotEventMap>(event: K, handler: QQBotEventMap[K]): unknown;
  start(externalSignal?: AbortSignal): Promise<void>;
  stop(): void;
  send(opts: SendMessageOptions): Promise<MessageResponse>;
  sendText(target: SdkReplyTarget, content: string): Promise<MessageResponse>;
  sendMarkdown(
    target: SdkReplyTarget,
    content: string,
    opts?: { keyboard?: InlineKeyboard },
  ): Promise<MessageResponse>;
}

export interface CreateQqGatewayOptions {
  logger?: AppLogger;
  credentials?: ResolvedQqCredentials;
  credentialOptions?: ResolveQqCredentialsOptions;
  msgIdCache?: MsgIdCache;
  replyLimiter?: ReplyLimiter;
  userAgent?: string;
  botFactory?: (options: QQBotOptions) => QqBotClient;
  intents?: number;
  reconnect?: Partial<ReconnectPolicy>;
  sessionPersistence?: QQBotOptions['sessionPersistence'];
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
  onDisconnected?: (event: GatewayDisconnect) => void;
  onError?: (error: Error) => void;
  onInteraction?: (event: InteractionEvent) => Promise<void> | void;
}

interface ResolvedSendRef {
  msgId?: string;
  eventId?: string;
  limiterKey?: string;
  fallbackReason?: string;
}

const DEFAULT_PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

function readPackageVersion(projectRoot: string = DEFAULT_PROJECT_ROOT): string {
  try {
    const pkgPath = resolve(projectRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export function buildQqUserAgent(projectRoot?: string): string {
  return `antigravity-qqbot/${readPackageVersion(projectRoot)} (Node/${process.versions.node}; ${platform()})`;
}

function createConsoleLogger(debugEnabled: boolean): AppLogger {
  return {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
    ...(debugEnabled ? { debug: (msg: string) => console.debug(msg) } : {}),
  };
}

function toSdkLogger(logger: AppLogger, debugEnabled: boolean): Logger {
  return {
    info: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warn(msg),
    error: (msg: string) => logger.error(msg),
    ...(debugEnabled
      ? {
          debug: (msg: string) => {
            if (logger.debug) {
              logger.debug(msg);
            } else {
              logger.info(msg);
            }
          },
        }
      : {}),
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Map a `@tencent-connect/qqbot-nodejs` inbound C2C or Group message into the shared `InboundMessage`.
 */
export function mapInboundMessage(
  msg: QQBotInboundMessage,
  fallbackReceivedAt: number = Date.now(),
  botId?: string,
): InboundMessage | null {
  const rawScope = msg.replyTarget?.scope ?? (msg.kind === 'c2c' || msg.kind === 'group' ? msg.kind : undefined);
  if (rawScope !== 'c2c' && rawScope !== 'group') {
    return null;
  }

  const peerId =
    rawScope === 'c2c'
      ? msg.replyTarget?.targetId || msg.senderId
      : msg.replyTarget?.targetId || msg.groupOpenid || '';
  if (!peerId) {
    return null;
  }

  const parsedTs = msg.timestamp ? Date.parse(msg.timestamp) : Number.NaN;
  const receivedAt = Number.isFinite(parsedTs) ? parsedTs : fallbackReceivedAt;
  const replyMsgId = msg.replyTarget?.msgId || msg.messageId || undefined;
  const senderName = msg.senderName?.trim() || undefined;
  const normalizedBotId = botId?.trim() || undefined;

  return {
    messageId: msg.messageId,
    scope: rawScope,
    peerId,
    senderId: msg.senderId,
    ...(senderName ? { senderName } : {}),
    ...(normalizedBotId ? { botId: normalizedBotId } : {}),
    text: msg.content,
    receivedAt,
    replyTarget: {
      scope: rawScope,
      targetId: peerId,
      ...(replyMsgId ? { msgId: replyMsgId } : {}),
    },
  };
}

function mapInteractionRef(event: InteractionEvent): {
  scope: ChatScope;
  targetId: string;
  eventId: string;
  msgId?: string;
} | null {
  const eventId = event.id?.trim();
  if (!eventId) {
    return null;
  }

  const msgId = event.data?.resolved?.message_id?.trim() || undefined;
  if (event.group_openid) {
    return {
      scope: 'group',
      targetId: event.group_openid,
      eventId,
      ...(msgId ? { msgId } : {}),
    };
  }
  if (event.user_openid) {
    return {
      scope: 'c2c',
      targetId: event.user_openid,
      eventId,
      ...(msgId ? { msgId } : {}),
    };
  }
  return null;
}

/**
 * Create a reusable QQ WebSocket gateway integrating credential resolution,
 * SDK middlewares, passive `msgId`/`eventId` caching, rate-limit fallback, and chunked sending.
 */
export function createQqGateway(
  config: RuntimeConfig,
  options: CreateQqGatewayOptions = {},
): QqGateway {
  const logger = options.logger ?? createConsoleLogger(config.debug);
  const sdkLogger = toSdkLogger(logger, config.debug);
  const msgIdCache = options.msgIdCache ?? new MsgIdCache();
  const replyLimiter = options.replyLimiter ?? new ReplyLimiter({ limit: config.passiveReplyLimit });
  const userAgent = options.userAgent ?? buildQqUserAgent(options.credentialOptions?.projectRoot);

  const inboundHandlers = new Set<InboundHandler>();
  const sendQueues = new Map<string, Promise<void>>();

  let activeBot: QqBotClient | null = null;
  let abortController: AbortController | null = null;
  let runPromise: Promise<void> | null = null;
  let startingPromise: Promise<void> | null = null;
  let stopRequested = false;
  let onStopHook: (() => void) | null = null;

  const enqueueForTarget = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prev = sendQueues.get(key) ?? Promise.resolve();
    const current = prev.then(task, task);
    const cleanup = current.then(
      () => {
        if (sendQueues.get(key) === cleanup) {
          sendQueues.delete(key);
        }
      },
      () => {
        if (sendQueues.get(key) === cleanup) {
          sendQueues.delete(key);
        }
      },
    );
    sendQueues.set(key, cleanup);
    return current;
  };

  const resolveSendTarget = (target: ReplyTarget): ResolvedSendRef => {
    if (target.forceProactive) {
      return { fallbackReason: 'force_proactive' };
    }

    let fallbackReason: string | undefined;

    if (target.msgId) {
      if (msgIdCache.isMsgIdExpired(target.scope, target.targetId, target.msgId)) {
        fallbackReason = 'expired';
      } else {
        const check = replyLimiter.checkLimit(target.msgId);
        if (check.allowed) {
          return { msgId: target.msgId, limiterKey: target.msgId };
        }
        fallbackReason = check.fallbackReason;
      }
    }

    if (target.eventId) {
      if (msgIdCache.isEventIdExpired(target.scope, target.targetId, target.eventId)) {
        fallbackReason = fallbackReason ?? 'expired';
      } else {
        const eventKey = `event:${target.eventId}`;
        const check = replyLimiter.checkLimit(eventKey);
        if (check.allowed) {
          return {
            eventId: target.eventId,
            limiterKey: eventKey,
            ...(fallbackReason ? { fallbackReason } : {}),
          };
        }
        fallbackReason = fallbackReason ?? check.fallbackReason;
      }
    }

    const cachedEntries = msgIdCache.getValidEntries(target.scope, target.targetId);
    for (const entry of cachedEntries) {
      if (entry.msgId) {
        const check = replyLimiter.checkLimit(entry.msgId);
        if (check.allowed) {
          return {
            msgId: entry.msgId,
            limiterKey: entry.msgId,
            ...(fallbackReason ? { fallbackReason } : {}),
          };
        }
        fallbackReason = fallbackReason ?? check.fallbackReason;
      }

      if (entry.eventId) {
        const eventKey = `event:${entry.eventId}`;
        const check = replyLimiter.checkLimit(eventKey);
        if (check.allowed) {
          return {
            eventId: entry.eventId,
            limiterKey: eventKey,
            ...(fallbackReason ? { fallbackReason } : {}),
          };
        }
        fallbackReason = fallbackReason ?? check.fallbackReason;
      }
    }

    return {
      fallbackReason: fallbackReason ?? 'no_cached_msg_id',
    };
  };

  const dispatchInbound = async (mapped: InboundMessage): Promise<void> => {
    for (const handler of [...inboundHandlers]) {
      try {
        await handler(mapped);
      } catch (err) {
        const error = toError(err);
        logger.error(`[qq:gateway] inbound handler failed: ${error.message}`);
        options.onError?.(error);
      }
    }
  };

  return {
    async start(): Promise<void> {
      if (activeBot || startingPromise) {
        throw new Error('QqGateway is already started');
      }

      stopRequested = false;
      const controller = new AbortController();
      abortController = controller;

      const startWork = (async (): Promise<void> => {
        try {
          const creds =
            options.credentials ??
            (await resolveQqCredentials(config, {
              ...options.credentialOptions,
              signal: options.credentialOptions?.signal ?? controller.signal,
              logger,
            }));

          if (stopRequested || controller.signal.aborted) {
            return;
          }

          const botOptions: QQBotOptions = {
            appId: creds.appId,
            appSecret: creds.appSecret,
            transport: 'websocket',
            baseUrl: config.apiBaseUrl,
            tokenBaseUrl: config.tokenBaseUrl,
            markdownSupport: config.markdownSupport,
            userAgent,
            logger: sdkLogger,
            ...(options.intents !== undefined ? { intents: options.intents } : {}),
            ...(options.reconnect ? { reconnect: options.reconnect } : {}),
            ...(options.sessionPersistence ? { sessionPersistence: options.sessionPersistence } : {}),
          };

          const createBot = options.botFactory ?? ((opts: QQBotOptions) => new QQBot(opts));
          const bot = createBot(botOptions);

          bot.use(messageFilter({ skipSelfEcho: true }));
          bot.use(mentionGate({ requireMentionInGroup: config.requireMentionInGroup }));
          bot.use(contentSanitizer({ parseFaceTags: true }));

          let markReady = (): void => {};

          bot.on('ready', (data) => {
            logger.info(`[qq:gateway] WebSocket gateway READY (appId=${creds.appId})`);
            markReady();
            options.onReady?.(data);
          });

          bot.on('resumed', (data) => {
            logger.info(`[qq:gateway] WebSocket gateway RESUMED (appId=${creds.appId})`);
            markReady();
            options.onResumed?.(data);
          });

          bot.on('disconnected', (event) => {
            const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
            if (event.willReconnect) {
              logger.warn(`[qq:gateway] Disconnected (${detail}), reconnecting...`);
            } else {
              logger.error(`[qq:gateway] Permanently disconnected (${detail})`);
            }
            options.onDisconnected?.(event);
          });

          bot.on('error', (err) => {
            logger.error(`[qq:gateway] Gateway error: ${err.message}`);
            options.onError?.(err);
          });

          bot.on('interaction', async (_ctx, event) => {
            const ref = mapInteractionRef(event);
            if (ref) {
              msgIdCache.record(ref.scope, ref.targetId, {
                eventId: ref.eventId,
                ...(ref.msgId ? { msgId: ref.msgId } : {}),
              });
            }
            if (options.onInteraction) {
              try {
                await options.onInteraction(event);
              } catch (err) {
                const error = toError(err);
                logger.error(`[qq:gateway] interaction handler failed: ${error.message}`);
                options.onError?.(error);
              }
            }
          });

          bot.on('message', async (ctx, msg) => {
            const mapped = mapInboundMessage(msg, ctx?.receivedAt, creds.appId);
            if (!mapped) {
              logger.debug?.(`[qq:gateway] Ignoring unsupported inbound message kind=${msg.kind}`);
              return;
            }

            msgIdCache.record(mapped.scope, mapped.peerId, {
              msgId: mapped.replyTarget.msgId ?? mapped.messageId,
            });
            await dispatchInbound(mapped);
          });

          activeBot = bot;

          await new Promise<void>((resolveReady, rejectReady) => {
            let settled = false;
            const finishReady = (): void => {
              if (settled) return;
              settled = true;
              onStopHook = null;
              resolveReady();
            };
            const failReady = (err: unknown): void => {
              if (settled) return;
              settled = true;
              onStopHook = null;
              rejectReady(toError(err));
            };

            markReady = finishReady;
            onStopHook = finishReady;

            const run = Promise.resolve().then(() => bot.start(controller.signal));
            runPromise = run;
            run.then(
              () => {
                if (stopRequested) {
                  if (activeBot === bot) activeBot = null;
                  if (abortController === controller) abortController = null;
                  if (runPromise === run) runPromise = null;
                }
                finishReady();
              },
              (err: unknown) => {
                const error = toError(err);
                if (activeBot === bot) activeBot = null;
                if (abortController === controller) abortController = null;
                if (runPromise === run) runPromise = null;

                if (!settled) {
                  failReady(error);
                } else if (!stopRequested) {
                  logger.error(`[qq:gateway] Gateway stopped with error: ${error.message}`);
                  options.onError?.(error);
                }
              },
            );
          });
        } catch (err) {
          if (abortController === controller) {
            abortController = null;
          }
          activeBot = null;
          runPromise = null;
          throw err;
        }
      })();

      startingPromise = startWork;
      try {
        await startWork;
      } finally {
        if (startingPromise === startWork) {
          startingPromise = null;
        }
      }
    },

    async stop(): Promise<void> {
      stopRequested = true;
      const bot = activeBot;
      const controller = abortController;
      const run = runPromise;
      const pendingStart = startingPromise;

      onStopHook?.();

      if (controller && !controller.signal.aborted) {
        controller.abort();
      }

      if (bot) {
        try {
          bot.stop();
        } catch (err) {
          logger.warn(`[qq:gateway] bot.stop() threw: ${toError(err).message}`);
        }
      }

      if (pendingStart) {
        await pendingStart.catch(() => {});
      }

      if (run) {
        await run.catch(() => {});
      }

      if (activeBot === bot) {
        activeBot = null;
      }
      if (abortController === controller) {
        abortController = null;
      }
      if (runPromise === run) {
        runPromise = null;
      }
    },

    async sendReply(reply: OutboundReply): Promise<void> {
      if (!activeBot) {
        throw new Error('QqGateway is not started; call start() before sendReply()');
      }

      if (!reply.text || !reply.text.trim()) {
        logger.warn(
          `[qq:gateway] Skipping empty reply for ${reply.target.scope}:${reply.target.targetId}`,
        );
        return;
      }

      const queueKey = `${reply.target.scope}:${reply.target.targetId}`;
      await enqueueForTarget(queueKey, async () => {
        const bot = activeBot;
        if (!bot) {
          throw new Error('QqGateway stopped while sending reply');
        }

        const chunks = config.markdownSupport
          ? chunkMarkdownText(reply.text, config.textChunkLimit)
          : chunkText(reply.text, config.textChunkLimit);

        for (const chunk of chunks) {
          if (!chunk.trim()) {
            continue;
          }

          const resolved = resolveSendTarget(reply.target);
          if (resolved.fallbackReason) {
            logger.debug?.(
              `[qq:gateway] Reply target fallback for ${queueKey} (${resolved.fallbackReason}): using ${resolved.msgId ? `msgId=${resolved.msgId}` : resolved.eventId ? `eventId=${resolved.eventId}` : 'proactive'}`,
            );
          }

          const sdkTarget: SdkReplyTarget = {
            scope: reply.target.scope,
            targetId: reply.target.targetId,
            ...(resolved.msgId ? { msgId: resolved.msgId } : {}),
          };

          if (resolved.eventId) {
            await bot.send(
              config.markdownSupport
                ? {
                    target: sdkTarget,
                    msgType: MsgType.MARKDOWN,
                    markdown: { content: chunk },
                    extra: { event_id: resolved.eventId },
                  }
                : {
                    target: sdkTarget,
                    msgType: MsgType.TEXT,
                    content: chunk,
                    extra: { event_id: resolved.eventId },
                  },
            );
          } else if (config.markdownSupport) {
            await bot.sendMarkdown(sdkTarget, chunk);
          } else {
            await bot.sendText(sdkTarget, chunk);
          }

          if (resolved.limiterKey) {
            replyLimiter.record(resolved.limiterKey);
          }
        }
      });
    },

    onInbound(handler: InboundHandler): () => void {
      inboundHandlers.add(handler);
      return () => {
        inboundHandlers.delete(handler);
      };
    },
  };
}
