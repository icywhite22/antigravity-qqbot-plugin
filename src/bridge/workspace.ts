import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ChatScope } from '../shared/types.ts';

export interface ResolveSessionWorkspaceOptions {
  workspaceRoot: string;
  scope: ChatScope;
  peerId: string;
  botId?: string;
}

export interface SessionWorkspacePaths {
  workspaceRoot: string;
  botDir: string;
  sessionDir: string;
}

const MAX_SEGMENT_BASE_LENGTH = 48;

function isStrictlyInside(parentDir: string, childDir: string): boolean {
  const rel = relative(parentDir, childDir);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 将任意标识（如 appId、user_openid、group_openid）规范化为跨平台安全目录片段。
 *
 * - 替换 Windows/POSIX 非法字符（如 `:`、`/`、`\`）为 `_`
 * - 发生替换、截断或为空时追加 8 位 SHA-256 指纹，避免不同原始 ID 发生目录碰撞
 */
export function sanitizeWorkspaceSegment(raw: string, fallback: string = 'item'): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  let cleaned = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');

  const truncated = cleaned.length > MAX_SEGMENT_BASE_LENGTH;
  if (truncated) {
    cleaned = cleaned.slice(0, MAX_SEGMENT_BASE_LENGTH).replace(/[._-]+$/g, '');
  }

  const changed = truncated || cleaned !== trimmed;
  if (!changed && cleaned) {
    return cleaned;
  }

  const digest = createHash('sha256').update(trimmed).digest('hex').slice(0, 8);
  return cleaned ? `${cleaned}-${digest}` : `${fallback}-${digest}`;
}

/**
 * 解析 `<workspaceRoot>/bot-<botId>/<scope>-<peerId>` 三层隔离工作区路径并校验路径包含关系。
 */
export function resolveSessionWorkspaceDir(
  options: ResolveSessionWorkspaceOptions,
): SessionWorkspacePaths {
  const rootRaw = options.workspaceRoot.trim();
  if (!rootRaw) {
    throw new Error('resolveSessionWorkspaceDir requires a non-empty workspaceRoot');
  }
  if (!options.peerId.trim()) {
    throw new Error('resolveSessionWorkspaceDir requires a non-empty peerId');
  }

  const workspaceRoot = resolve(rootRaw);
  const botFolder = `bot-${sanitizeWorkspaceSegment(options.botId?.trim() || 'default', 'default')}`;
  const sessionFolder = `${options.scope}-${sanitizeWorkspaceSegment(options.peerId, 'peer')}`;

  const botDir = resolve(workspaceRoot, botFolder);
  if (!isStrictlyInside(workspaceRoot, botDir)) {
    throw new Error(`Resolved bot workspace escapes workspaceRoot: ${botDir}`);
  }

  const sessionDir = resolve(botDir, sessionFolder);
  if (!isStrictlyInside(botDir, sessionDir)) {
    throw new Error(`Resolved session workspace escapes botDir: ${sessionDir}`);
  }

  return {
    workspaceRoot,
    botDir,
    sessionDir,
  };
}

/**
 * 解析并确保机器人与会话级隔离工作区目录在磁盘上已创建。
 */
export function ensureSessionWorkspace(
  options: ResolveSessionWorkspaceOptions,
): SessionWorkspacePaths {
  const paths = resolveSessionWorkspaceDir(options);
  mkdirSync(paths.sessionDir, { recursive: true });
  return paths;
}
