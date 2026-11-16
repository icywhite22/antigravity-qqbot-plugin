import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeConfig } from './types.ts';

const DEFAULT_CALLBACK_HOST = '127.0.0.1';
const DEFAULT_CALLBACK_PORT = 39871;
const DEFAULT_API_BASE_URL = 'https://api.bot.qq.com';
const DEFAULT_TEXT_CHUNK_LIMIT = 4500;
const DEFAULT_PASSIVE_REPLY_LIMIT = 4;

function parseCallbackPort(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return fallback;
  return parsed;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  if (max !== undefined && parsed > max) return fallback;
  return parsed;
}

function parseBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return fallback;
  if (trimmed === '1' || trimmed === 'true' || trimmed === 'yes') return true;
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'no') return false;
  return fallback;
}

/**
 * 解析 `.env` 文件文本为键值对。
 */
export function parseDotEnvContent(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const normalizedRaw = raw.replace(/^\uFEFF/, '');
  for (const rawLine of normalizedRaw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = normalized.slice(0, eqIndex).trim();
    if (!key) continue;
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

/**
 * 读取指定目录下的 `.env` 与 `.env.local`，并与进程环境变量合并（进程环境变量优先）。
 */
export function loadEnvWithDotFiles(
  rootDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const fileName of ['.env', '.env.local']) {
    const filePath = resolve(rootDir, fileName);
    if (!existsSync(filePath)) continue;
    const parsed = parseDotEnvContent(readFileSync(filePath, 'utf8'));
    Object.assign(merged, parsed);
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * 从环境变量读取运行时配置，并给出安全默认值。
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const callbackPort = parseCallbackPort(env.QQBOT_CALLBACK_PORT, DEFAULT_CALLBACK_PORT);
  const dataDir = env.QQBOT_DATA_DIR?.trim() || join(homedir(), '.antigravity-qqbot');
  const workspaceRoot = resolve(env.QQBOT_WORKSPACE_DIR?.trim() || join(dataDir, 'workspace'));
  const projectId = env.ANTIGRAVITY_PROJECT_ID?.trim();
  const qrSource = env.QQBOT_QR_SOURCE?.trim();
  const agentModel = env.QQBOT_AGENT_MODEL?.trim();
  const agentProfile = env.QQBOT_AGENT_PROFILE?.trim();

  return {
    appId: env.QQBOT_APPID?.trim() ?? '',
    appSecret: env.QQBOT_SECRET?.trim() ?? '',
    callbackHost: env.QQBOT_CALLBACK_HOST?.trim() || DEFAULT_CALLBACK_HOST,
    callbackPort,
    dataDir,
    workspaceRoot,
    ...(projectId ? { projectId } : {}),
    apiBaseUrl: env.QQBOT_BASE_URL?.trim().replace(/\/+$/, '') || DEFAULT_API_BASE_URL,
    tokenBaseUrl: env.QQBOT_TOKEN_BASE_URL?.trim().replace(/\/+$/, '') || DEFAULT_API_BASE_URL,
    markdownSupport: parseBooleanFlag(env.QQBOT_MARKDOWN_SUPPORT, false),
    requireMentionInGroup: parseBooleanFlag(env.QQBOT_REQUIRE_MENTION, true),
    textChunkLimit: parsePositiveInt(env.QQBOT_TEXT_CHUNK_LIMIT, DEFAULT_TEXT_CHUNK_LIMIT),
    passiveReplyLimit: parsePositiveInt(env.QQBOT_PASSIVE_REPLY_LIMIT, DEFAULT_PASSIVE_REPLY_LIMIT),
    debug: parseBooleanFlag(env.QQBOT_DEBUG, false),
    ...(qrSource ? { qrSource } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(agentProfile ? { agentProfile } : {}),
  };
}
