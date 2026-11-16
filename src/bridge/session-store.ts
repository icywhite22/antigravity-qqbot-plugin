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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppLogger, BridgeSession, ChatScope } from '../shared/types.ts';

export interface SessionStoreOptions {
  dataDir?: string;
  filePath?: string;
  logger?: AppLogger;
}

export interface SessionUpsertInput {
  scope: ChatScope;
  peerId: string;
  botId?: string;
  conversationId: string;
  workspaceDir?: string;
  lastActiveAt?: number;
}

interface PersistedSessionsFile {
  version: number;
  sessions: Record<string, BridgeSession>;
}

/**
 * 构造稳定的会话键：未传 `botId` 时为 `${scope}:${peerId}`；多机器人场景下为 `${botId}:${scope}:${peerId}`。
 */
export function makeSessionKey(scope: ChatScope, peerId: string, botId?: string): string {
  const normalizedBotId = botId?.trim();
  return normalizedBotId ? `${normalizedBotId}:${scope}:${peerId}` : `${scope}:${peerId}`;
}

function isChatScope(value: unknown): value is ChatScope {
  return value === 'c2c' || value === 'group';
}

function parseSessionCandidate(raw: unknown): BridgeSession | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (!isChatScope(obj.scope)) {
    return undefined;
  }
  if (typeof obj.peerId !== 'string' || !obj.peerId.trim()) {
    return undefined;
  }
  if (typeof obj.conversationId !== 'string' || !obj.conversationId.trim()) {
    return undefined;
  }
  const botId =
    typeof obj.botId === 'string' && obj.botId.trim() ? obj.botId.trim() : undefined;
  const workspaceDir =
    typeof obj.workspaceDir === 'string' && obj.workspaceDir.trim()
      ? obj.workspaceDir.trim()
      : undefined;
  const lastActiveAt =
    typeof obj.lastActiveAt === 'number' && Number.isFinite(obj.lastActiveAt) ? obj.lastActiveAt : 0;

  return {
    sessionKey: makeSessionKey(obj.scope, obj.peerId, botId),
    conversationId: obj.conversationId.trim(),
    scope: obj.scope,
    peerId: obj.peerId,
    ...(botId ? { botId } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    lastActiveAt,
  };
}

function cloneSession(session: BridgeSession): BridgeSession {
  return { ...session };
}

/**
 * 将 QQ Peer（`scope:peerId`）到 Antigravity `conversationId` 的映射持久化到 `<dataDir>/sessions.json`。
 */
export class SessionStore {
  readonly filePath: string;
  private readonly logger: AppLogger | undefined;
  private readonly sessions: Map<string, BridgeSession>;

  constructor(options: SessionStoreOptions = {}) {
    const resolvedDir = options.dataDir?.trim() || join(homedir(), '.antigravity-qqbot');
    this.filePath = options.filePath?.trim() || join(resolvedDir, 'sessions.json');
    this.logger = options.logger;
    this.sessions = new Map<string, BridgeSession>();
    this.reload();
  }

  get(scope: ChatScope, peerId: string, botId?: string): BridgeSession | undefined {
    const found = this.sessions.get(makeSessionKey(scope, peerId, botId));
    return found ? cloneSession(found) : undefined;
  }

  getByKey(sessionKey: string): BridgeSession | undefined {
    const found = this.sessions.get(sessionKey);
    return found ? cloneSession(found) : undefined;
  }

  list(): BridgeSession[] {
    return Array.from(this.sessions.values(), cloneSession);
  }

  upsert(input: SessionUpsertInput): BridgeSession {
    if (!input.peerId) {
      throw new Error('SessionStore.upsert requires a non-empty peerId');
    }
    const conversationId = input.conversationId.trim();
    if (!conversationId) {
      throw new Error('SessionStore.upsert requires a non-empty conversationId');
    }

    const botId = input.botId?.trim() || undefined;
    const workspaceDir = input.workspaceDir?.trim() || undefined;
    const sessionKey = makeSessionKey(input.scope, input.peerId, botId);
    const previous = this.sessions.get(sessionKey);
    const next: BridgeSession = {
      sessionKey,
      conversationId,
      scope: input.scope,
      peerId: input.peerId,
      ...(botId ? { botId } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
      lastActiveAt: input.lastActiveAt ?? Date.now(),
    };

    this.sessions.set(sessionKey, next);
    try {
      this.saveToDisk();
    } catch (err) {
      if (previous) {
        this.sessions.set(sessionKey, previous);
      } else {
        this.sessions.delete(sessionKey);
      }
      throw err;
    }

    return cloneSession(next);
  }

  touch(
    scope: ChatScope,
    peerId: string,
    lastActiveAt: number = Date.now(),
    botId?: string,
  ): BridgeSession | undefined {
    const sessionKey = makeSessionKey(scope, peerId, botId);
    const existing = this.sessions.get(sessionKey);
    if (!existing) {
      return undefined;
    }
    const next: BridgeSession = {
      ...existing,
      lastActiveAt,
    };
    this.sessions.set(sessionKey, next);
    try {
      this.saveToDisk();
    } catch (err) {
      this.sessions.set(sessionKey, existing);
      throw err;
    }
    return cloneSession(next);
  }

  delete(scope: ChatScope, peerId: string, botId?: string): boolean {
    const sessionKey = makeSessionKey(scope, peerId, botId);
    const existing = this.sessions.get(sessionKey);
    if (!existing) {
      return false;
    }
    this.sessions.delete(sessionKey);
    try {
      this.saveToDisk();
    } catch (err) {
      this.sessions.set(sessionKey, existing);
      throw err;
    }
    return true;
  }

  clear(): void {
    if (this.sessions.size === 0 && !existsSync(this.filePath)) {
      return;
    }
    const snapshot = new Map(this.sessions);
    this.sessions.clear();
    try {
      this.saveToDisk();
    } catch (err) {
      for (const [k, v] of snapshot) {
        this.sessions.set(k, v);
      }
      throw err;
    }
  }

  reload(): void {
    this.sessions.clear();
    if (!existsSync(this.filePath)) {
      return;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf8').trim();
      if (!raw) {
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      let entries: unknown[];
      if (Array.isArray(parsed)) {
        entries = parsed;
      } else {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.sessions)) {
          entries = record.sessions;
        } else if (record.sessions && typeof record.sessions === 'object') {
          entries = Object.values(record.sessions as Record<string, unknown>);
        } else {
          entries = Object.values(record);
        }
      }

      for (const entry of entries) {
        const session = parseSessionCandidate(entry);
        if (session) {
          this.sessions.set(session.sessionKey, session);
        }
      }
    } catch (err) {
      this.logger?.warn(
        `[bridge:sessions] failed to load ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private saveToDisk(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });

    const ordered: Record<string, BridgeSession> = {};
    const keys = Array.from(this.sessions.keys()).sort();
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (session) {
        ordered[key] = cloneSession(session);
      }
    }

    const payloadObj: PersistedSessionsFile = {
      version: 1,
      sessions: ordered,
    };
    const json = `${JSON.stringify(payloadObj, null, 2)}\n`;
    const tmpPath = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

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
        // Windows NTFS ignores POSIX chmod
      }
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore temp cleanup failure
      }
      throw err;
    }
  }
}
