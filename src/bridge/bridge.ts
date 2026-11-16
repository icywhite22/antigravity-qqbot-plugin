import { mkdirSync } from 'node:fs';
import { loadRuntimeConfig } from '../shared/config.ts';
import type { AppLogger, BridgeSession, ChatScope, InboundMessage, RuntimeConfig } from '../shared/types.ts';
import { AgentApiClient } from './agentapi-client.ts';
import type { AgentApiInvocation, AgentApiRunner } from './agentapi-client.ts';
import { CallbackServer } from './callback-server.ts';
import type { DeliverReplyHandler } from './callback-server.ts';
import { ReplyTokenRegistry } from './reply-tokens.ts';
import { SessionStore, makeSessionKey } from './session-store.ts';
import { ensureSessionWorkspace } from './workspace.ts';

export interface AntigravityBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  dispatchInbound(message: InboundMessage): Promise<BridgeSession>;
  getSession(scope: ChatScope, peerId: string, botId?: string): BridgeSession | undefined;
  getCallbackUrl(): string;
}

export interface CreateAntigravityBridgeOptions {
  config?: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  workspaceRoot?: string;
  callbackHost?: string;
  callbackPort?: number;
  maxBodyBytes?: number;
  agentModel?: string;
  agentProfile?: string;
  commandTimeoutMs?: number;
  replyTokenTtlMs?: number;
  fallbackToNewConversationOnSendError?: boolean;
  sessionStore?: SessionStore;
  agentApi?: AgentApiClient;
  invocation?: AgentApiInvocation;
  runner?: AgentApiRunner;
  replyTokens?: ReplyTokenRegistry;
  callbackServer?: CallbackServer;
  onDeliverReply?: DeliverReplyHandler;
  formatTitle?: (message: InboundMessage) => string | undefined;
  now?: () => number;
  logger?: AppLogger;
}

/**
 * 构造发送给 Antigravity 会话的格式化提示词上下文。
 */
export function formatBridgePrompt(
  message: InboundMessage,
  replyToken: string,
  workspaceDir?: string,
): string {
  const sender = message.senderName ? `${message.senderName} (${message.senderId})` : message.senderId;
  const headerLines = [
    `[QQ ${message.scope} message]`,
    ...(message.botId ? [`botId: ${message.botId}`] : []),
    `peerId: ${message.peerId}`,
    `sender: ${sender}`,
    `replyToken: ${replyToken}`,
    ...(workspaceDir ? [`workspace: ${workspaceDir}`] : []),
    '',
    message.text,
  ];
  return headerLines.join('\n');
}

function defaultFormatTitle(message: InboundMessage): string {
  const label = (message.senderName?.trim() || message.peerId).replace(/[\r\n]+/g, ' ').trim();
  const title = `QQ ${message.scope}: ${label}`;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

/**
 * 组合 `SessionStore`、`AgentApiClient`、`ReplyTokenRegistry` 与 `CallbackServer`，
 * 构建完整的 QQ <-> Antigravity 桥接服务。
 */
export function createAntigravityBridge(
  options: CreateAntigravityBridgeOptions = {},
): AntigravityBridge {
  const env = options.env ?? process.env;
  const config = options.config ?? loadRuntimeConfig(env);
  const now = options.now ?? Date.now;
  const logger = options.logger;

  const dataDir = options.dataDir ?? config.dataDir;
  const workspaceRoot =
    options.workspaceRoot?.trim() ||
    (options.dataDir ? `${options.dataDir.replace(/[\\/]+$/, '')}/workspace` : config.workspaceRoot);
  const callbackHost = options.callbackHost ?? config.callbackHost;
  const callbackPort =
    options.callbackPort !== undefined ? options.callbackPort : config.callbackPort;
  const agentModel = options.agentModel ?? config.agentModel;
  const agentProfile = options.agentProfile ?? config.agentProfile;
  const fallbackOnSendError = options.fallbackToNewConversationOnSendError ?? true;

  const sessionStore = options.sessionStore ?? new SessionStore({ dataDir, logger });
  const replyTokens =
    options.replyTokens ??
    new ReplyTokenRegistry({
      ttlMs: options.replyTokenTtlMs,
      now,
    });
  const agentApi =
    options.agentApi ??
    new AgentApiClient({
      invocation: options.invocation,
      runner: options.runner,
      env,
      timeoutMs: options.commandTimeoutMs,
      defaultModel: agentModel,
      defaultProfile: agentProfile,
      logger,
    });
  const callbackServer =
    options.callbackServer ??
    new CallbackServer({
      host: callbackHost,
      port: callbackPort,
      maxBodyBytes: options.maxBodyBytes,
      replyTokens,
      onDeliverReply: options.onDeliverReply,
      now,
      logger,
    });

  const dispatchQueues = new Map<string, Promise<unknown>>();

  function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = dispatchQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.catch(() => undefined);
    dispatchQueues.set(key, tail);
    void tail.finally(() => {
      if (dispatchQueues.get(key) === tail) {
        dispatchQueues.delete(key);
      }
    });
    return current;
  }

  return {
    async start(): Promise<void> {
      mkdirSync(workspaceRoot, { recursive: true });
      await callbackServer.start();
    },

    stop(): Promise<void> {
      return callbackServer.stop();
    },

    getSession(scope: ChatScope, peerId: string, botId?: string): BridgeSession | undefined {
      return sessionStore.get(scope, peerId, botId ?? (config.appId.trim() || undefined));
    },

    getCallbackUrl(): string {
      return callbackServer.getUrl();
    },

    dispatchInbound(message: InboundMessage): Promise<BridgeSession> {
      const botId = message.botId?.trim() || config.appId.trim() || undefined;
      const sessionKey = makeSessionKey(message.scope, message.peerId, botId);
      return runSerialized(sessionKey, async () => {
        const { sessionDir } = ensureSessionWorkspace({
          workspaceRoot,
          scope: message.scope,
          peerId: message.peerId,
          ...(botId ? { botId } : {}),
        });
        const replyToken = replyTokens.issue(message.replyTarget);
        const prompt = formatBridgePrompt(message, replyToken, sessionDir);
        const title = (options.formatTitle ? options.formatTitle(message) : defaultFormatTitle(message))?.trim();
        const existing = sessionStore.get(message.scope, message.peerId, botId);

        let conversationId: string;
        if (existing) {
          try {
            await agentApi.sendMessage(existing.conversationId, prompt, { cwd: sessionDir });
            conversationId = existing.conversationId;
          } catch (sendErr) {
            if (!fallbackOnSendError) {
              replyTokens.revoke(replyToken);
              throw sendErr;
            }
            logger?.warn(
              `[bridge] sendMessage failed for ${sessionKey} (${existing.conversationId}), falling back to newConversation: ${
                sendErr instanceof Error ? sendErr.message : String(sendErr)
              }`,
            );
            try {
              conversationId = await agentApi.newConversation(prompt, {
                ...(title ? { title } : {}),
                cwd: sessionDir,
              });
            } catch (newErr) {
              replyTokens.revoke(replyToken);
              throw newErr;
            }
          }
        } else {
          try {
            conversationId = await agentApi.newConversation(prompt, {
              ...(title ? { title } : {}),
              cwd: sessionDir,
            });
          } catch (newErr) {
            replyTokens.revoke(replyToken);
            throw newErr;
          }
        }

        return sessionStore.upsert({
          scope: message.scope,
          peerId: message.peerId,
          ...(botId ? { botId } : {}),
          conversationId,
          workspaceDir: sessionDir,
          lastActiveAt: now(),
        });
      });
    },
  };
}
