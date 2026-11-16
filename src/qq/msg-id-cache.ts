import type { ChatScope } from '../shared/types.ts';

export const C2C_MSG_ID_TTL_MS = 30 * 60 * 1000;
export const GROUP_MSG_ID_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_MSG_IDS_PER_TARGET = 10;
const MAX_KNOWN_EXPIRY_RECORDS = 10_000;

export interface MsgIdCacheOptions {
  c2cTtlMs?: number;
  groupTtlMs?: number;
  maxPerTarget?: number;
  now?: () => number;
}

export interface MsgIdRefInput {
  msgId?: string;
  eventId?: string;
}

export interface CachedMsgIdEntry {
  scope: ChatScope;
  targetId: string;
  msgId?: string;
  eventId?: string;
  recordedAt: number;
  expiresAt: number;
}

function buildTargetKey(scope: ChatScope, targetId: string): string {
  return `${scope}:${targetId}`;
}

function buildIdKey(scope: ChatScope, targetId: string, id: string): string {
  return `${scope}:${targetId}:${id}`;
}

function trackBoundedExpiry(map: Map<string, number>, key: string, expiresAt: number): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, expiresAt);
  while (map.size > MAX_KNOWN_EXPIRY_RECORDS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

/**
 * Per-target cache for inbound `msgId` and interaction `eventId` passive reply tokens.
 *
 * Defaults follow QQ Open Platform windows (30min C2C, 5min Group, max 10 entries per target).
 */
export class MsgIdCache {
  private readonly c2cTtlMs: number;
  private readonly groupTtlMs: number;
  private readonly maxPerTarget: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, CachedMsgIdEntry[]>();
  private readonly knownMsgExpiries = new Map<string, number>();
  private readonly knownEventExpiries = new Map<string, number>();

  constructor(options: MsgIdCacheOptions = {}) {
    this.c2cTtlMs = options.c2cTtlMs ?? C2C_MSG_ID_TTL_MS;
    this.groupTtlMs = options.groupTtlMs ?? GROUP_MSG_ID_TTL_MS;
    this.maxPerTarget = Math.max(1, options.maxPerTarget ?? DEFAULT_MAX_MSG_IDS_PER_TARGET);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Record a `msgId` and/or `eventId` for a target peer, pruning expired entries
   * and evicting oldest entries beyond `maxPerTarget`.
   */
  record(
    scope: ChatScope,
    targetId: string,
    ref: MsgIdRefInput,
  ): CachedMsgIdEntry | undefined {
    const msgId = ref.msgId?.trim() || undefined;
    const eventId = ref.eventId?.trim() || undefined;
    if (!msgId && !eventId) {
      return undefined;
    }

    const currentNow = this.now();
    const ttlMs = scope === 'c2c' ? this.c2cTtlMs : this.groupTtlMs;
    const expiresAt = currentNow + ttlMs;
    const key = buildTargetKey(scope, targetId);

    const existing = this.pruneBucket(key, currentNow);
    const filtered = existing.filter((entry) => {
      if (msgId && entry.msgId === msgId) return false;
      if (!msgId && eventId && entry.eventId === eventId) return false;
      return true;
    });

    const entry: CachedMsgIdEntry = {
      scope,
      targetId,
      ...(msgId ? { msgId } : {}),
      ...(eventId ? { eventId } : {}),
      recordedAt: currentNow,
      expiresAt,
    };

    filtered.push(entry);
    while (filtered.length > this.maxPerTarget) {
      filtered.shift();
    }
    this.buckets.set(key, filtered);

    if (msgId) {
      trackBoundedExpiry(this.knownMsgExpiries, buildIdKey(scope, targetId, msgId), expiresAt);
    }
    if (eventId) {
      trackBoundedExpiry(this.knownEventExpiries, buildIdKey(scope, targetId, eventId), expiresAt);
    }

    return entry;
  }

  /**
   * Return all unexpired entries for a target ordered newest-first.
   */
  getValidEntries(scope: ChatScope, targetId: string): CachedMsgIdEntry[] {
    const key = buildTargetKey(scope, targetId);
    const active = this.pruneBucket(key, this.now());
    return [...active].reverse();
  }

  /**
   * Return the most recently recorded unexpired entry for a target.
   */
  getLatest(scope: ChatScope, targetId: string): CachedMsgIdEntry | undefined {
    return this.getValidEntries(scope, targetId)[0];
  }

  /**
   * Return true if the given `msgId` was previously recorded for this target and is now expired.
   */
  isMsgIdExpired(scope: ChatScope, targetId: string, msgId: string): boolean {
    const id = msgId.trim();
    if (!id) return false;
    const expiresAt = this.knownMsgExpiries.get(buildIdKey(scope, targetId, id));
    if (expiresAt === undefined) return false;
    return this.now() >= expiresAt;
  }

  /**
   * Return true if the given `eventId` was previously recorded for this target and is now expired.
   */
  isEventIdExpired(scope: ChatScope, targetId: string, eventId: string): boolean {
    const id = eventId.trim();
    if (!id) return false;
    const expiresAt = this.knownEventExpiries.get(buildIdKey(scope, targetId, id));
    if (expiresAt === undefined) return false;
    return this.now() >= expiresAt;
  }

  /**
   * Prune expired entries across all buckets and return the number of removed entries.
   */
  prune(): number {
    const currentNow = this.now();
    let removed = 0;
    for (const [key, list] of this.buckets) {
      const before = list.length;
      const active = this.pruneBucket(key, currentNow);
      removed += before - active.length;
    }
    return removed;
  }

  /**
   * Return the count of unexpired entries for a specific target or across the whole cache.
   */
  size(scope?: ChatScope, targetId?: string): number {
    const currentNow = this.now();
    if (scope && targetId) {
      return this.pruneBucket(buildTargetKey(scope, targetId), currentNow).length;
    }
    let total = 0;
    for (const key of [...this.buckets.keys()]) {
      total += this.pruneBucket(key, currentNow).length;
    }
    return total;
  }

  clear(scope?: ChatScope, targetId?: string): void {
    if (scope && targetId) {
      this.buckets.delete(buildTargetKey(scope, targetId));
      const prefix = `${scope}:${targetId}:`;
      for (const k of this.knownMsgExpiries.keys()) {
        if (k.startsWith(prefix)) this.knownMsgExpiries.delete(k);
      }
      for (const k of this.knownEventExpiries.keys()) {
        if (k.startsWith(prefix)) this.knownEventExpiries.delete(k);
      }
      return;
    }
    this.buckets.clear();
    this.knownMsgExpiries.clear();
    this.knownEventExpiries.clear();
  }

  private pruneBucket(key: string, currentNow: number): CachedMsgIdEntry[] {
    const list = this.buckets.get(key);
    if (!list || list.length === 0) {
      return [];
    }
    const active = list.filter((entry) => currentNow < entry.expiresAt);
    if (active.length === 0) {
      this.buckets.delete(key);
      return [];
    }
    if (active.length !== list.length) {
      this.buckets.set(key, active);
    }
    return active;
  }
}
