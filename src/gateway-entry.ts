import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GatewayDisconnect } from '@tencent-connect/qqbot-nodejs';
import { createAntigravityBridge } from './bridge/index.ts';
import type { AntigravityBridge, CreateAntigravityBridgeOptions } from './bridge/index.ts';
import { createQqGateway } from './qq/index.ts';
import type {
  CreateQqGatewayOptions,
  QqGateway,
  ResolveQqCredentialsOptions,
} from './qq/index.ts';
import { loadEnvWithDotFiles, loadRuntimeConfig } from './shared/config.ts';
import type { AppLogger, InboundMessage, RuntimeConfig } from './shared/types.ts';

export interface GatewayCliArgs {
  help: boolean;
  forceRebind: boolean;
  debug: boolean;
}

export interface CreateGatewayRuntimeOptions {
  projectRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  config?: RuntimeConfig;
  forceRebind?: boolean;
  debug?: boolean;
  logger?: AppLogger;
  stdout?: Pick<NodeJS.WritableStream, 'write'>;
  stderr?: Pick<NodeJS.WritableStream, 'write'>;
  gatewayOptions?: Omit<CreateQqGatewayOptions, 'logger'>;
  bridgeOptions?: Omit<
    CreateAntigravityBridgeOptions,
    'config' | 'env' | 'onDeliverReply' | 'logger'
  >;
  createGateway?: (config: RuntimeConfig, options: CreateQqGatewayOptions) => QqGateway;
  createBridge?: (options: CreateAntigravityBridgeOptions) => AntigravityBridge;
  onError?: (error: Error) => void;
  onDisconnected?: (event: GatewayDisconnect) => void;
}

export interface GatewayRuntime {
  readonly projectRoot: string;
  readonly config: RuntimeConfig;
  readonly gateway: QqGateway;
  readonly bridge: AntigravityBridge;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  waitForStop(): Promise<void>;
  isRunning(): boolean;
  isStopped(): boolean;
  hasPermanentDisconnect(): boolean;
}

export interface RunGatewayEntryOptions extends CreateGatewayRuntimeOptions {
  signal?: AbortSignal;
  installSignalHandlers?: boolean;
}

function writeLine(stream: Pick<NodeJS.WritableStream, 'write'>, text: string): void {
  try {
    stream.write(`${text}\n`);
  } catch {
    // 忽略日志流关闭导致的写入错误
  }
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sanitizeErrorText(text: string, secrets: readonly string[]): string {
  let sanitized = text;
  for (const secret of secrets) {
    if (secret.length >= 8 && sanitized.includes(secret)) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
  }
  return sanitized;
}

function createGatewayLogger(
  debugEnabled: boolean,
  stdout: Pick<NodeJS.WritableStream, 'write'>,
  stderr: Pick<NodeJS.WritableStream, 'write'>,
): AppLogger {
  return {
    info: (msg: string) => writeLine(stdout, msg),
    warn: (msg: string) => writeLine(stderr, msg),
    error: (msg: string) => writeLine(stderr, msg),
    ...(debugEnabled ? { debug: (msg: string) => writeLine(stdout, msg) } : {}),
  };
}

function toCanonicalFileUrl(filePath: string): string {
  try {
    return pathToFileURL(realpathSync(filePath)).href;
  } catch {
    return pathToFileURL(resolve(filePath)).href;
  }
}

/**
 * 判断当前模块是否作为 CLI 入口被直接执行（被测试或其它模块导入时返回 false）。
 */
export function isDirectExecution(
  entryArg: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!entryArg) {
    return false;
  }

  try {
    const entryPath = entryArg.startsWith('file://') ? fileURLToPath(entryArg) : entryArg;
    const entryUrl = toCanonicalFileUrl(entryPath);
    const selfUrl = toCanonicalFileUrl(fileURLToPath(moduleUrl));
    if (process.platform === 'win32') {
      return entryUrl.toLowerCase() === selfUrl.toLowerCase();
    }
    return entryUrl === selfUrl;
  } catch {
    return false;
  }
}

/**
 * 返回网关入口 CLI 帮助文本。
 */
export function formatGatewayHelp(): string {
  return [
    'Usage: node src/gateway-entry.ts [options]',
    '',
    'Start the local QQ Bot WebSocket gateway and Antigravity bridge callback server.',
    '',
    'Options:',
    '  --rebind, --qr   Ignore cached credentials and .env, force QR code re-binding',
    '  --debug          Enable verbose debug logging',
    '  -h, --help       Show this help message',
    '',
    'Environment:',
    '  Loaded from .env, .env.local, and process.env (process.env takes precedence):',
    '    QQBOT_APPID, QQBOT_SECRET, QQBOT_CALLBACK_HOST, QQBOT_CALLBACK_PORT,',
    '    QQBOT_DATA_DIR, ANTIGRAVITY_AGENTAPI_EXE, QQBOT_DEBUG',
  ].join('\n');
}

/**
 * 解析网关入口命令行参数。
 */
export function parseGatewayCliArgs(argv: readonly string[]): GatewayCliArgs {
  const parsed: GatewayCliArgs = {
    help: false,
    forceRebind: false,
    debug: false,
  };

  for (const token of argv) {
    if (token === '--') {
      continue;
    }
    if (token === '-h' || token === '--help') {
      parsed.help = true;
      continue;
    }
    if (token === '--rebind' || token === '--qr') {
      parsed.forceRebind = true;
      continue;
    }
    if (token === '--debug') {
      parsed.debug = true;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return parsed;
}

/**
 * 组装并创建可测试的 QQ Bot 网关与 Antigravity 桥接运行时（创建时不产生 I/O 副作用）。
 */
export function createGatewayRuntime(
  options: CreateGatewayRuntimeOptions = {},
): GatewayRuntime {
  const projectRoot = resolve(options.projectRoot ?? resolve(import.meta.dirname, '..'));
  const env = options.env ?? loadEnvWithDotFiles(projectRoot, options.baseEnv ?? process.env);
  const loadedConfig = options.config ?? loadRuntimeConfig(env);
  const config: RuntimeConfig =
    options.debug === true && !loadedConfig.debug
      ? { ...loadedConfig, debug: true }
      : loadedConfig;

  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const logger = options.logger ?? createGatewayLogger(config.debug, stdout, stderr);
  const secretValues = [config.appSecret, env.QQBOT_SECRET ?? ''].filter(
    (value): value is string => Boolean(value),
  );
  const forceRebind = Boolean(options.forceRebind || options.gatewayOptions?.credentialOptions?.forceRebind);

  let running = false;
  let stopRequested = false;
  let permanentDisconnect = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let gatewayStopPromise: Promise<void> | null = null;
  let bridgeStopPromise: Promise<void> | null = null;
  let bridgeStarted = false;
  let unsubscribeInbound: (() => void) | null = null;

  let resolveStopped: () => void = () => {};
  const stoppedPromise = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });

  const gatewayFactory = options.createGateway ?? createQqGateway;
  const bridgeFactory = options.createBridge ?? createAntigravityBridge;

  let gateway!: QqGateway;
  let bridge!: AntigravityBridge;

  const stopGatewayOnce = (): Promise<void> => {
    if (!gatewayStopPromise) {
      gatewayStopPromise = Promise.resolve().then(() => gateway.stop());
    }
    return gatewayStopPromise;
  };

  const stopBridgeOnce = (): Promise<void> => {
    if (!bridgeStopPromise) {
      bridgeStopPromise = Promise.resolve().then(() => bridge.stop());
    }
    return bridgeStopPromise;
  };

  const stop = (reason?: string): Promise<void> => {
    stopRequested = true;
    running = false;

    if (stopPromise) {
      return stopPromise;
    }

    const runStop = async (): Promise<void> => {
      logger.info(
        reason
          ? `[gateway] Stopping QQ Bot Gateway runtime (${reason})...`
          : '[gateway] Stopping QQ Bot Gateway runtime...',
      );

      if (unsubscribeInbound) {
        try {
          unsubscribeInbound();
        } catch {
          // 忽略取消订阅异常
        }
        unsubscribeInbound = null;
      }

      let firstError: unknown;

      try {
        await stopGatewayOnce();
      } catch (err) {
        firstError = err;
        logger.error(
          `[gateway] Error stopping QQ gateway: ${sanitizeErrorText(formatErrorMessage(err), secretValues)}`,
        );
      }

      if (startPromise) {
        await startPromise.catch(() => {});
      }

      try {
        await stopBridgeOnce();
        bridgeStarted = false;
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
        }
        logger.error(
          `[gateway] Error stopping Antigravity bridge: ${sanitizeErrorText(formatErrorMessage(err), secretValues)}`,
        );
      }

      resolveStopped();
      if (firstError !== undefined) {
        throw firstError;
      }
      logger.info('[gateway] QQ Bot Gateway runtime stopped.');
    };

    stopPromise = runStop();
    return stopPromise;
  };

  const credentialOptions: ResolveQqCredentialsOptions = {
    ...(options.gatewayOptions?.credentialOptions ?? {}),
    projectRoot,
    ...(forceRebind ? { forceRebind: true } : {}),
  };

  gateway = gatewayFactory(config, {
    ...(options.gatewayOptions ?? {}),
    credentialOptions,
    logger,
    onError: (err: Error) => {
      logger.error(
        `[gateway] QQ gateway error: ${sanitizeErrorText(formatErrorMessage(err), secretValues)}`,
      );
      options.gatewayOptions?.onError?.(err);
      options.onError?.(err);
    },
    onDisconnected: (event: GatewayDisconnect) => {
      options.gatewayOptions?.onDisconnected?.(event);
      options.onDisconnected?.(event);
      if (!event.willReconnect && !stopRequested) {
        permanentDisconnect = true;
        const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
        logger.error(`[gateway] QQ gateway disconnected permanently (${detail}); shutting down.`);
        void stop(`permanent gateway disconnect: ${detail}`).catch(() => {});
      }
    },
  });

  bridge = bridgeFactory({
    ...(options.bridgeOptions ?? {}),
    config,
    env,
    onDeliverReply: async ({ target, text, replyToken }) => {
      await gateway.sendReply({ target, text, replyToken });
    },
    logger,
  });

  unsubscribeInbound = gateway.onInbound(async (message: InboundMessage) => {
    logger.info(
      `[gateway] Inbound ${message.scope} message received (peerId=${message.peerId}, senderId=${message.senderId}, messageId=${message.messageId}, chars=${message.text.length})`,
    );
    try {
      const session = await bridge.dispatchInbound(message);
      logger.info(
        `[gateway] Dispatched ${message.scope} message to Antigravity session (sessionKey=${session.sessionKey}, conversationId=${session.conversationId})`,
      );
    } catch (err) {
      logger.error(
        `[gateway] Failed to dispatch inbound message (${message.scope}:${message.peerId}, messageId=${message.messageId}): ${sanitizeErrorText(formatErrorMessage(err), secretValues)}`,
      );
    }
  });

  return {
    projectRoot,
    config,
    gateway,
    bridge,

    async start(): Promise<void> {
      if (stopRequested || stopPromise) {
        throw new Error('GatewayRuntime is already stopped');
      }
      if (running || startPromise) {
        throw new Error('GatewayRuntime is already started');
      }

      const doStart = async (): Promise<void> => {
        logger.info(`[gateway] Starting QQ Bot Gateway runtime (projectRoot=${projectRoot})`);

        await bridge.start();
        bridgeStarted = true;
        logger.info(`[gateway] Bridge callback server listening at ${bridge.getCallbackUrl()}`);

        if (stopRequested) {
          if (bridgeStarted) {
            await stopBridgeOnce().catch((stopErr) => {
              logger.warn(
                `[gateway] Failed to stop bridge during aborted startup: ${sanitizeErrorText(formatErrorMessage(stopErr), secretValues)}`,
              );
            });
            bridgeStarted = false;
          }
          return;
        }

        try {
          await gateway.start();
        } catch (err) {
          if (bridgeStarted) {
            await stopBridgeOnce().catch((stopErr) => {
              logger.warn(
                `[gateway] Failed to stop bridge after gateway start failure: ${sanitizeErrorText(formatErrorMessage(stopErr), secretValues)}`,
              );
            });
            bridgeStarted = false;
          }
          throw err;
        }

        if (!stopRequested) {
          running = true;
          logger.info(
            `[gateway] QQ Bot Gateway runtime is ready (callbackUrl=${bridge.getCallbackUrl()}, dataDir=${config.dataDir})`,
          );
        }
      };

      const currentStart = doStart();
      startPromise = currentStart;
      try {
        await currentStart;
      } finally {
        if (startPromise === currentStart) {
          startPromise = null;
        }
      }
    },

    stop,

    waitForStop(): Promise<void> {
      return stoppedPromise;
    },

    isRunning(): boolean {
      return running;
    },

    isStopped(): boolean {
      return stopPromise !== null;
    },

    hasPermanentDisconnect(): boolean {
      return permanentDisconnect;
    },
  };
}

/**
 * 执行网关 CLI 入口生命周期：解析参数、启动运行时并等待信号或永久断线后优雅退出。
 */
export async function runGatewayEntry(
  argv: readonly string[] = process.argv.slice(2),
  options: RunGatewayEntryOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  let cliArgs: GatewayCliArgs;
  try {
    cliArgs = parseGatewayCliArgs(argv);
  } catch (err) {
    writeLine(stderr, `[gateway] ${formatErrorMessage(err)}`);
    writeLine(stderr, '');
    writeLine(stderr, formatGatewayHelp());
    return 1;
  }

  if (cliArgs.help) {
    writeLine(stdout, formatGatewayHelp());
    return 0;
  }

  if (options.signal?.aborted) {
    return 0;
  }

  const runtime = createGatewayRuntime({
    ...options,
    forceRebind: Boolean(options.forceRebind || cliArgs.forceRebind),
    ...(options.debug !== undefined || cliArgs.debug
      ? { debug: Boolean(options.debug || cliArgs.debug) }
      : {}),
    stdout,
    stderr,
  });

  const logger =
    options.logger ?? createGatewayLogger(runtime.config.debug, stdout, stderr);
  const secretValues = runtime.config.appSecret ? [runtime.config.appSecret] : [];

  let shutdownRequestedBySignal = false;
  let shutdownSignalReason = '';
  let stopOutcomePromise: Promise<void> | null = null;

  const triggerSignalStop = (reason: string): void => {
    shutdownRequestedBySignal = true;
    if (!shutdownSignalReason) {
      shutdownSignalReason = reason;
    }
    if (!stopOutcomePromise) {
      stopOutcomePromise = runtime.stop(reason).catch((err) => {
        logger.error(
          `[gateway] Shutdown failed: ${sanitizeErrorText(formatErrorMessage(err), secretValues)}`,
        );
      });
    }
  };

  const onSigInt = (): void => triggerSignalStop('SIGINT');
  const onSigTerm = (): void => triggerSignalStop('SIGTERM');
  const onAbortSignal = (): void => triggerSignalStop('AbortSignal');

  const installSignals = options.installSignalHandlers ?? true;
  if (installSignals) {
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
  }
  options.signal?.addEventListener('abort', onAbortSignal, { once: true });

  try {
    let startSucceeded = false;
    try {
      await runtime.start();
      startSucceeded = true;
    } catch (err) {
      if (shutdownRequestedBySignal) {
        logger.info(`[gateway] Startup cancelled (${shutdownSignalReason}); exiting.`);
      } else {
        logger.error(
          `[gateway] Failed to start runtime: ${sanitizeErrorText(formatErrorMessage(err), secretValues)}`,
        );
      }
    }

    if (!startSucceeded) {
      if (stopOutcomePromise) {
        await stopOutcomePromise;
      } else {
        await runtime.stop(
          shutdownRequestedBySignal ? shutdownSignalReason : 'startup-failure',
        ).catch(() => {});
      }
      return shutdownRequestedBySignal && !runtime.hasPermanentDisconnect() ? 0 : 1;
    }

    if (!shutdownRequestedBySignal && !runtime.isStopped()) {
      await runtime.waitForStop();
    } else if (stopOutcomePromise) {
      await stopOutcomePromise;
    } else {
      await runtime.waitForStop();
    }

    if (runtime.hasPermanentDisconnect() && !shutdownRequestedBySignal) {
      return 1;
    }
    return 0;
  } finally {
    if (installSignals) {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    }
    options.signal?.removeEventListener('abort', onAbortSignal);
  }
}

if (isDirectExecution()) {
  void runGatewayEntry(process.argv.slice(2))
    .then((exitCode) => {
      if (exitCode !== 0 && process.exitCode === undefined) {
        process.exitCode = exitCode;
      }
    })
    .catch((err) => {
      writeLine(process.stderr, `[gateway] Fatal error: ${formatErrorMessage(err)}`);
      process.exitCode = 1;
    });
}
