export const DEFAULT_PASSIVE_REPLY_LIMIT = 4;
export const DEFAULT_REPLY_LIMIT_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_TRACKED_MESSAGES = 10_000;

export type ReplyLimitFallbackReason = 'expired' | 'limit_exceeded';

export interface ReplyLimiterConfig {
  limit?: number;
  ttlMs?: number;
  maxTrackedMessages?: number;
  now?: () => number;
}

export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  shouldFallbackToProactive: boolean;
  fallbackReason?: ReplyLimitFallbackReason;
  message?: string;
}

interface ReplyRecord {
  count: number;
  firstReplyAt: number;
}

/**
 * Passive reply rate limiter tracking replies per `msgId` / `eventId` within a TTL window.
 */
export class ReplyLimiter {
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly maxTracked: number;
  private readonly now: () => number;
  private readonly tracker = new Map<string, ReplyRecord>();

  constructor(config: ReplyLimiterConfig = {}) {
    const rawLimit = config.limit ?? DEFAULT_PASSIVE_REPLY_LIMIT;
    this.limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : DEFAULT_PASSIVE_REPLY_LIMIT;
    this.ttlMs = config.ttlMs ?? DEFAULT_REPLY_LIMIT_TTL_MS;
    this.maxTracked = Math.max(1, config.maxTrackedMessages ?? DEFAULT_MAX_TRACKED_MESSAGES);
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Check whether a passive reply is still permitted for `messageId`.
   */
  checkLimit(messageId: string): ReplyLimitResult {
    const id = messageId.trim();
    if (!id) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'expired',
        message: 'Missing msgId; falling back to proactive reply',
      };
    }

    if (this.limit <= 0) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'limit_exceeded',
        message: 'Passive reply limit is 0; sending proactively instead',
      };
    }

    const currentNow = this.now();
    this.evictIfNeeded(currentNow);

    const record = this.tracker.get(id);
    if (!record) {
      return {
        allowed: true,
        remaining: this.limit,
        shouldFallbackToProactive: false,
      };
    }

    if (currentNow - record.firstReplyAt >= this.ttlMs) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'expired',
        message: `Passive reply window (${this.ttlMs}ms) expired; falling back to proactive reply`,
      };
    }

    const remaining = this.limit - record.count;
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'limit_exceeded',
        message: `Passive reply limit (${this.limit}) exceeded; falling back to proactive reply`,
      };
    }

    return {
      allowed: true,
      remaining,
      shouldFallbackToProactive: false,
    };
  }

  /**
   * Record one passive reply sent against `messageId`.
   */
  record(messageId: string): void {
    const id = messageId.trim();
    if (!id) {
      return;
    }

    const currentNow = this.now();
    this.evictIfNeeded(currentNow);

    const existing = this.tracker.get(id);
    if (!existing || currentNow - existing.firstReplyAt >= this.ttlMs) {
      this.tracker.set(id, { count: 1, firstReplyAt: currentNow });
      return;
    }

    existing.count += 1;
  }

  getStats(): { trackedMessages: number; totalReplies: number } {
    let totalReplies = 0;
    for (const record of this.tracker.values()) {
      totalReplies += record.count;
    }
    return { trackedMessages: this.tracker.size, totalReplies };
  }

  getConfig(): { limit: number; ttlMs: number } {
    return { limit: this.limit, ttlMs: this.ttlMs };
  }

  clear(): void {
    this.tracker.clear();
  }

  private evictIfNeeded(currentNow: number): void {
    if (this.tracker.size < this.maxTracked) {
      return;
    }

    for (const [id, rec] of this.tracker) {
      if (currentNow - rec.firstReplyAt >= this.ttlMs) {
        this.tracker.delete(id);
      }
    }

    while (this.tracker.size >= this.maxTracked) {
      const oldestKey = this.tracker.keys().next().value;
      if (oldestKey === undefined) break;
      this.tracker.delete(oldestKey);
    }
  }
}
