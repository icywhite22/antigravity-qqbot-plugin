/**
 * 验证 1：QQ 扫码绑定与私聊回显最小验证脚本。
 *
 * 参考 tencent-connect/dsh-qqbot 的 src/setup/binding-service.ts 与
 * src/gateway/bootstrap.ts 实现：
 *   1. 优先读取 .qqbot-data/credentials.json 本地缓存凭据（或 .env / 环境变量）
 *   2. 若尚无凭据（或传入 --rebind），调用 startQrConnect 在终端输出扫码二维码
 *   3. 扫码成功后将凭据原子写入 .qqbot-data/credentials.json（已被 .gitignore 忽略）
 *   4. 若扫码接口受限报错，如实输出错误并支持回退读取 .env 中的 QQBOT_APPID / QQBOT_SECRET
 *   5. 初始化 QQBot WebSocket 网关，收到私聊（C2C）消息时原样回复 "收到: <消息内容>"
 *
 * 用法：
 *   npm run verify:qq
 *   npm run verify:qq -- --rebind   # 忽略本地缓存，强制重新扫码
 */

import { startQrConnect } from '@tencent-connect/qqbot-connector';
import type { QrConnectCallbacks, QrConnectCredentials, QrConnectOptions } from '@tencent-connect/qqbot-connector';
import { QQBot, messageFilter } from '@tencent-connect/qqbot-nodejs';
import type {
  GatewayDisconnect,
  Logger,
  MiddlewareContext,
  QQBotInboundMessage,
} from '@tencent-connect/qqbot-nodejs';
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
import { platform } from 'node:os';
import { dirname, resolve } from 'node:path';

interface SavedCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
  savedAt: string;
}

interface ResolvedCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
  source: 'cache' | 'env' | 'qr';
}

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = resolve(PROJECT_ROOT, '.qqbot-data');
const CREDENTIALS_PATH = resolve(DATA_DIR, 'credentials.json');
const DEFAULT_API_BASE_URL = 'https://api.bot.qq.com';

function printHelp(): void {
  console.log('用法: npm run verify:qq [-- --rebind]');
  console.log('');
  console.log('选项:');
  console.log('  --rebind, --qr   忽略本地 .qqbot-data/ 缓存与 .env，强制发起扫码绑定');
  console.log('  -h, --help       显示帮助信息');
}

function readPackageVersion(): string {
  try {
    const pkgPath = resolve(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function buildUserAgent(): string {
  return `antigravity-qqbot/${readPackageVersion()} (Node/${process.versions.node}; ${platform()})`;
}

function formatErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const parts: string[] = [err.message];
  const record = err as unknown as Record<string, unknown>;
  if (typeof record.httpStatus === 'number' && record.httpStatus > 0) {
    parts.push(`httpStatus=${record.httpStatus}`);
  }
  if (record.bizCode !== undefined) {
    parts.push(`bizCode=${String(record.bizCode)}`);
  }
  if (typeof record.bizMessage === 'string' && record.bizMessage) {
    parts.push(`bizMessage=${record.bizMessage}`);
  }
  if (err.cause instanceof Error && err.cause.message !== err.message) {
    parts.push(`cause=${err.cause.message}`);
  }
  return parts.join(' | ');
}

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  const result: Record<string, string> = {};
  const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    let value = normalized.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.search(/\s+#/);
      if (commentIdx >= 0) {
        value = value.slice(0, commentIdx).trim();
      }
    }
    result[key] = value;
  }
  return result;
}

function loadMergedEnv(): Record<string, string | undefined> {
  const baseEnv = parseDotEnvFile(resolve(PROJECT_ROOT, '.env'));
  const localEnv = parseDotEnvFile(resolve(PROJECT_ROOT, '.env.local'));
  const merged: Record<string, string | undefined> = { ...baseEnv, ...localEnv };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function readEnvCredentials(env: Record<string, string | undefined>): ResolvedCredentials | null {
  const appId = env.QQBOT_APPID?.trim() ?? '';
  const appSecret = env.QQBOT_SECRET?.trim() ?? '';
  if (!appId || !appSecret) {
    return null;
  }
  return { appId, appSecret, source: 'env' };
}

function loadCachedCredentials(): ResolvedCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as Partial<SavedCredentials>;
    const appId = typeof parsed.appId === 'string' ? parsed.appId.trim() : '';
    const appSecret = typeof parsed.appSecret === 'string' ? parsed.appSecret.trim() : '';
    if (!appId || !appSecret) {
      console.warn(`[verify-qq-echo] 本地缓存文件字段不完整，将忽略: ${CREDENTIALS_PATH}`);
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
    };
  } catch (err) {
    console.warn(`[verify-qq-echo] 读取本地缓存凭据失败，将忽略: ${formatErrorDetail(err)}`);
    return null;
  }
}

function saveCachedCredentials(creds: QrConnectCredentials): void {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  const payload: SavedCredentials = {
    appId: creds.appId,
    appSecret: creds.appSecret,
    ...(creds.userOpenid ? { userOpenid: creds.userOpenid } : {}),
    savedAt: new Date().toISOString(),
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const tmpPath = `${CREDENTIALS_PATH}.tmp`;
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
      // Windows NTFS 忽略 POSIX chmod
    }
    renameSync(tmpPath, CREDENTIALS_PATH);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // 忽略临时文件清理失败
    }
    throw err;
  }
}

function runQrConnect(
  signal: AbortSignal,
  source?: string,
): Promise<QrConnectCredentials | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const callbacks: QrConnectCallbacks = {
      onSuccess(credentials: QrConnectCredentials[]) {
        const cred = credentials[0];
        if (!cred || !cred.appId || !cred.appSecret) {
          rejectPromise(new Error('扫码成功但未返回有效的 AppID / AppSecret'));
          return;
        }
        resolvePromise(cred);
      },
      onFailure(error: Error) {
        if (signal.aborted) {
          resolvePromise(null);
          return;
        }
        rejectPromise(error);
      },
      onQrDisplayed(url: string) {
        console.log('二维码显示异常？可复制或点击下方链接在浏览器中打开完成扫码:');
        console.log(`  ${url}\n`);
      },
      onQrExpired() {
        console.log('[verify-qq-echo] 二维码已过期，正在刷新…\n');
      },
    };

    const options: QrConnectOptions = {
      displayQrCodeToConsole: true,
      signal,
      ...(source ? { source } : {}),
    };

    startQrConnect(callbacks, options);
  });
}

function createBotLogger(debugEnabled: boolean): Logger {
  return {
    info: (msg: string) => console.log(`[qqbot] ${msg}`),
    warn: (msg: string) => console.warn(`[qqbot] ${msg}`),
    error: (msg: string) => console.error(`[qqbot] ${msg}`),
    ...(debugEnabled ? { debug: (msg: string) => console.debug(`[qqbot:debug] ${msg}`) } : {}),
  };
}

function printEnvFallbackHelp(): void {
  console.error('\n[verify-qq-echo] 可按以下步骤退回使用 .env 凭据：');
  console.error('  1. 复制 .env.example 为 .env');
  console.error('  2. 在 .env 中填入 QQBOT_APPID 与 QQBOT_SECRET');
  console.error('  3. 重新运行: npm run verify:qq');
}

async function resolveCredentials(
  env: Record<string, string | undefined>,
  forceRebind: boolean,
  signal: AbortSignal,
): Promise<ResolvedCredentials | null> {
  if (!forceRebind) {
    const cached = loadCachedCredentials();
    if (cached) {
      console.log(`[verify-qq-echo] 已加载本地缓存凭据: ${CREDENTIALS_PATH} (appId=${cached.appId})`);
      return cached;
    }

    const fromEnv = readEnvCredentials(env);
    if (fromEnv) {
      console.log(`[verify-qq-echo] 已从环境变量/.env 读取凭据 (appId=${fromEnv.appId})`);
      return fromEnv;
    }
  } else {
    console.log('[verify-qq-echo] 检测到 --rebind/--qr，准备重新发起扫码绑定...');
  }

  console.log('[verify-qq-echo] 正在请求 QQ 扫码绑定二维码...');
  const qrSource = env.QQBOT_QR_SOURCE?.trim() || undefined;
  try {
    const scanned = await runQrConnect(signal, qrSource);
    if (!scanned) {
      return null;
    }
    console.log(`\n✔ 扫码绑定成功! appId=${scanned.appId}`);
    if (scanned.userOpenid) {
      console.log(`  扫码用户 openid=${scanned.userOpenid}`);
    }
    saveCachedCredentials(scanned);
    console.log(`[verify-qq-echo] 凭据已保存到本地缓存: ${CREDENTIALS_PATH}`);
    return {
      appId: scanned.appId,
      appSecret: scanned.appSecret,
      ...(scanned.userOpenid ? { userOpenid: scanned.userOpenid } : {}),
      source: 'qr',
    };
  } catch (err) {
    console.error(`[verify-qq-echo] 扫码接口报错: ${formatErrorDetail(err)}`);
    const fallback = readEnvCredentials(env);
    if (fallback) {
      console.warn(`[verify-qq-echo] 已自动回退至 .env / 环境变量凭据 (appId=${fallback.appId})`);
      return fallback;
    }
    printEnvFallbackHelp();
    process.exitCode = 1;
    return null;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printHelp();
    return;
  }
  const forceRebind = args.has('--rebind') || args.has('--qr');

  const shutdownController = new AbortController();
  let bot: QQBot | null = null;
  const requestShutdown = (sigName: string): void => {
    if (shutdownController.signal.aborted) {
      return;
    }
    console.log(`\n[verify-qq-echo] 收到 ${sigName}，正在停止…`);
    shutdownController.abort();
    bot?.stop();
  };

  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  const env = loadMergedEnv();
  const credentials = await resolveCredentials(env, forceRebind, shutdownController.signal);
  if (!credentials) {
    if (shutdownController.signal.aborted) {
      console.log('[verify-qq-echo] 已取消扫码，退出。');
    }
    return;
  }

  const userAgent = buildUserAgent();
  const baseUrl = env.QQBOT_BASE_URL?.trim().replace(/\/+$/, '') || DEFAULT_API_BASE_URL;
  const tokenBaseUrl = env.QQBOT_TOKEN_BASE_URL?.trim().replace(/\/+$/, '') || DEFAULT_API_BASE_URL;
  const debugEnabled = env.QQBOT_DEBUG === '1' || env.QQBOT_DEBUG === 'true';

  const client = new QQBot({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    transport: 'websocket',
    baseUrl,
    tokenBaseUrl,
    userAgent,
    logger: createBotLogger(debugEnabled),
  });
  bot = client;

  console.log(`[verify-qq-echo] QQBot 实例已初始化 (appId=${credentials.appId}, UA=${userAgent})`);

  client.use(messageFilter({ skipSelfEcho: true }));

  client.on('ready', () => {
    console.log(`[verify-qq-echo] ✔ WebSocket 网关已就绪 (appId=${credentials.appId})`);
    console.log('[verify-qq-echo] 请用手机 QQ 向机器人发送私聊消息，预期原样回复 "收到: <消息内容>"（按 Ctrl+C 退出）。');
  });

  client.on('resumed', () => {
    console.log('[verify-qq-echo] WebSocket 网关会话已恢复 (RESUMED)');
  });

  client.on('disconnected', (event: GatewayDisconnect) => {
    const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
    if (event.willReconnect) {
      console.warn(`[verify-qq-echo] 网关断开 (${detail})，正在重连…`);
    } else {
      console.error(`[verify-qq-echo] 网关已永久断开 (${detail})`);
    }
  });

  client.on('error', (err: Error) => {
    console.error(`[verify-qq-echo] 网关错误: ${formatErrorDetail(err)}`);
  });

  client.on('message', async (_ctx: MiddlewareContext, msg: QQBotInboundMessage) => {
    if (msg.replyTarget.scope !== 'c2c') {
      console.log(
        `[verify-qq-echo] 忽略非私聊消息 (kind=${msg.kind}, scope=${msg.replyTarget.scope}, senderId=${msg.senderId})`,
      );
      return;
    }

    console.log(
      `[verify-qq-echo] ← 收到私聊消息 (senderId=${msg.senderId}, messageId=${msg.messageId}): ${msg.content}`,
    );

    const replyText = `收到: ${msg.content}`;
    try {
      const sent = await client.sendText(msg.replyTarget, replyText);
      console.log(`[verify-qq-echo] → 已回复 (replyId=${sent.id}): ${replyText}`);
    } catch (err) {
      console.error(`[verify-qq-echo] 回复消息失败: ${formatErrorDetail(err)}`);
    }
  });

  try {
    await client.start(shutdownController.signal);
    console.log('[verify-qq-echo] 网关已停止。');
  } catch (err) {
    console.error(`[verify-qq-echo] 网关运行失败: ${formatErrorDetail(err)}`);
    if (credentials.source === 'cache') {
      console.error('[verify-qq-echo] 若本地缓存凭据已失效，可运行 `npm run verify:qq -- --rebind` 重新扫码，或在 .env 中配置 QQBOT_APPID / QQBOT_SECRET。');
    }
    process.exitCode = 1;
  }
}

void main();
