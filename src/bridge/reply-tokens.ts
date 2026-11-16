import { randomBytes } from 'node:crypto';
import type { ReplyTarget } from '../shared/types.ts';

export const DEFAULT_REPLY_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface ReplyTokenEntry {
  token: string;
  target: ReplyTarget;
  createdAt: number;
  expiresAt: number;
}

export interface ReplyTokenRegistryOptions {
  ttlMs?: number;
  now?: () => number;
  generateToken?: () => string;
}

function defaultGenerateToken(): string {
  return randomBytes(24).toString('base64url');
}

function cloneTarget(target: ReplyTarget): ReplyTarget {
  return { ...target };
}

/**
 * 维护 `replyToken -> ReplyTarget` 映射及 TTL 过期控制。
 * 同一回合在 TTL 内允许多次回传，支持分段或后续补充回复。
 */
export class ReplyTokenRegistry {
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;
  private readonly entries: Map<string, ReplyTokenEntry>;

  constructor(options: ReplyTokenRegistryOptions = {}) {
    this.defaultTtlMs =
      typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs > 0
        ? options.ttlMs
        : DEFAULT_REPLY_TOKEN_TTL_MS;
    this.now = options.now ?? Date.now;
    this.generateToken = options.generateToken ?? defaultGenerateToken;
    this.entries = new Map<string, ReplyTokenEntry>();
  }

  get size(): number {
    return this.entries.size;
  }

  issue(target: ReplyTarget, ttlMs?: number): string {
    const currentNow = this.now();
    this.prune(currentNow);

    const effectiveTtlMs =
      typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : this.defaultTtlMs;

    let token = this.generateToken();
    while (this.entries.has(token)) {
      token = this.generateToken();
    }

    this.entries.set(token, {
      token,
      target: cloneTarget(target),
      createdAt: currentNow,
      expiresAt: currentNow + effectiveTtlMs,
    });

    return token;
  }

  resolve(token: string, atTime?: number): ReplyTarget | undefined {
    const key = token.trim();
    if (!key) {
      return undefined;
    }

    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    const currentNow = atTime ?? this.now();
    if (currentNow >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }

    return cloneTarget(entry.target);
  }

  revoke(token: string): boolean {
    const key = token.trim();
    if (!key) {
      return false;
    }
    return this.entries.delete(key);
  }

  prune(atTime?: number): number {
    const currentNow = atTime ?? this.now();
    let removed = 0;
    for (const [token, entry] of this.entries) {
      if (currentNow >= entry.expiresAt) {
        this.entries.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }
}
