import { startQrConnect } from '@tencent-connect/qqbot-connector';
import type {
  QrConnectCallbacks,
  QrConnectCredentials,
  QrConnectOptions,
} from '@tencent-connect/qqbot-connector';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AppLogger, RuntimeConfig } from '../shared/types.ts';

export type QqCredentialSource = 'env' | 'cache' | 'qr';

export interface SavedQqCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
  savedAt: string;
}

export interface ResolvedQqCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
  source: QqCredentialSource;
  cachePath?: string;
}

export type QrConnectStarter = (
  callbacks: QrConnectCallbacks,
  options?: QrConnectOptions,
) => () => void;

export interface ResolveQqCredentialsOptions {
  forceRebind?: boolean;
  allowQr?: boolean;
  displayQrCodeToConsole?: boolean;
  signal?: AbortSignal;
  logger?: AppLogger;
  projectRoot?: string;
  fallbackCachePaths?: readonly string[];
  qrConnectFn?: QrConnectStarter;
  onQrUrl?: (url: string) => void;
}

const DEFAULT_PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

export function getPrimaryCredentialsPath(dataDir: string): string {
  return join(dataDir, 'credentials.json');
}

export function getFallbackCredentialsPath(projectRoot: string = DEFAULT_PROJECT_ROOT): string {
  return resolve(projectRoot, '.qqbot-data', 'credentials.json');
}

/**
 * Load cached QQ Bot credentials from disk, returning null if missing or invalid.
 */
export function loadCachedQqCredentials(
  filePath: string,
  logger?: AppLogger,
): ResolvedQqCredentials | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SavedQqCredentials>;
    const appId = typeof parsed.appId === 'string' ? parsed.appId.trim() : '';
    const appSecret = typeof parsed.appSecret === 'string' ? parsed.appSecret.trim() : '';
    if (!appId || !appSecret) {
      logger?.warn(`[qq:credentials] Incomplete cached credentials ignored: ${filePath}`);
      return null;
    }

    const userOpenid =
      typeof parsed.userOpenid === 'string' && parsed.userOpenid.trim()
        ? parsed.userOpenid.trim()
        : undefined;

    return {
      appId,
      appSecret,
      ...(userOpenid ? { userOpenid } : {}),
      source: 'cache',
      cachePath: filePath,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger?.warn(`[qq:credentials] Failed to read cached credentials (${filePath}): ${detail}`);
    return null;
  }
}

/**
 * Atomically persist QQ Bot credentials with private directory/file permissions.
 */
export function saveQqCredentials(filePath: string, creds: QrConnectCredentials): void {
  const appId = creds.appId.trim();
  const appSecret = creds.appSecret.trim();
  if (!appId || !appSecret) {
    throw new Error('Cannot persist empty QQ AppID or AppSecret');
  }
  const userOpenid = creds.userOpenid?.trim();

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const payload: SavedQqCredentials = {
    appId,
    appSecret,
    ...(userOpenid ? { userOpenid } : {}),
    savedAt: new Date().toISOString(),
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

  try {
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeFileSync(fd, json, 'utf8');
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Windows NTFS ignores POSIX file modes
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failures
    }
    throw err;
  }
}

function runQrBinding(
  qrSource: string | undefined,
  options: ResolveQqCredentialsOptions,
): Promise<QrConnectCredentials> {
  const signal = options.signal;
  if (signal?.aborted) {
    return Promise.reject(new Error('QQ QR code binding aborted'));
  }

  const starter = options.qrConnectFn ?? startQrConnect;
  const displayQrCodeToConsole = options.displayQrCodeToConsole ?? true;

  return new Promise<QrConnectCredentials>((resolvePromise, rejectPromise) => {
    let settled = false;
    let dispose: (() => void) | undefined;

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    const settleResolve = (cred: QrConnectCredentials): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(cred);
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    const onAbort = (): void => {
      try {
        dispose?.();
      } catch {
        // Ignore dispose errors on abort
      }
      settleReject(new Error('QQ QR code binding aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const callbacks: QrConnectCallbacks = {
      onSuccess(credentials: QrConnectCredentials[]) {
        const first = credentials[0];
        const appId = first?.appId?.trim() ?? '';
        const appSecret = first?.appSecret?.trim() ?? '';
        const userOpenid = first?.userOpenid?.trim();
        if (!appId || !appSecret) {
          settleReject(new Error('QR binding succeeded without valid AppID / AppSecret'));
          return;
        }
        settleResolve({
          appId,
          appSecret,
          ...(userOpenid ? { userOpenid } : {}),
        });
      },
      onFailure(error: Error) {
        if (signal?.aborted) {
          settleReject(new Error('QQ QR code binding aborted', { cause: error }));
          return;
        }
        settleReject(error);
      },
      onQrDisplayed(url: string) {
        options.onQrUrl?.(url);
        options.logger?.info(`[qq:credentials] Scan QR code or open URL to bind QQ Bot: ${url}`);
      },
      onQrExpired() {
        options.logger?.info('[qq:credentials] QR code expired, refreshing...');
      },
    };

    const qrOptions: QrConnectOptions = {
      displayQrCodeToConsole,
      ...(signal ? { signal } : {}),
      ...(qrSource ? { source: qrSource } : {}),
    };

    try {
      dispose = starter(callbacks, qrOptions);
    } catch (err) {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Resolve QQ Bot credentials in order:
 * 1. Explicit env/config (`config.appId` + `config.appSecret`), unless `forceRebind` is set
 * 2. Primary cache in `<dataDir>/credentials.json`
 * 3. Read fallback cache in `<projectRoot>/.qqbot-data/credentials.json`
 * 4. Interactive QR binding via `startQrConnect` (persisted atomically to `<dataDir>/credentials.json`)
 */
export async function resolveQqCredentials(
  config: Pick<RuntimeConfig, 'appId' | 'appSecret' | 'dataDir' | 'qrSource'>,
  options: ResolveQqCredentialsOptions = {},
): Promise<ResolvedQqCredentials> {
  const logger = options.logger;
  const primaryCachePath = getPrimaryCredentialsPath(config.dataDir);

  if (!options.forceRebind) {
    const appId = config.appId.trim();
    const appSecret = config.appSecret.trim();
    if (appId && appSecret) {
      return { appId, appSecret, source: 'env' };
    }

    const primaryCached = loadCachedQqCredentials(primaryCachePath, logger);
    if (primaryCached) {
      logger?.info(`[qq:credentials] Loaded cached credentials from ${primaryCachePath}`);
      return primaryCached;
    }

    const fallbackPaths = options.fallbackCachePaths ?? [
      getFallbackCredentialsPath(options.projectRoot),
    ];
    const seen = new Set<string>([resolve(primaryCachePath)]);
    for (const candidate of fallbackPaths) {
      const resolvedCandidate = resolve(candidate);
      if (seen.has(resolvedCandidate)) {
        continue;
      }
      seen.add(resolvedCandidate);
      const fallbackCached = loadCachedQqCredentials(resolvedCandidate, logger);
      if (fallbackCached) {
        logger?.info(
          `[qq:credentials] Loaded fallback cached credentials from ${resolvedCandidate}`,
        );
        return fallbackCached;
      }
    }
  }

  if (options.allowQr === false) {
    throw new Error(
      'QQ Bot credentials are not configured (set QQBOT_APPID/QQBOT_SECRET or allow QR binding)',
    );
  }

  logger?.info('[qq:credentials] Starting QR code binding for QQ Bot credentials...');
  const scanned = await runQrBinding(config.qrSource, options);
  saveQqCredentials(primaryCachePath, scanned);
  logger?.info(`[qq:credentials] Saved QR credentials to ${primaryCachePath}`);

  return {
    appId: scanned.appId,
    appSecret: scanned.appSecret,
    ...(scanned.userOpenid ? { userOpenid: scanned.userOpenid } : {}),
    source: 'qr',
    cachePath: primaryCachePath,
  };
}
