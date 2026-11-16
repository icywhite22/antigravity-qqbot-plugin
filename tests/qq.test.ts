import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  GatewayDisconnect,
  InteractionEvent,
  Middleware,
  QQBotEventMap,
  QQBotInboundMessage,
  QQBotOptions,
  ReplyTarget as SdkReplyTarget,
  SendMessageOptions,
} from '@tencent-connect/qqbot-nodejs';
import {
  C2C_MSG_ID_TTL_MS,
  DEFAULT_MAX_MSG_IDS_PER_TARGET,
  DEFAULT_PASSIVE_REPLY_LIMIT,
  DEFAULT_REPLY_LIMIT_TTL_MS,
  DEFAULT_TEXT_CHUNK_LIMIT,
  GROUP_MSG_ID_TTL_MS,
  MsgIdCache,
  ReplyLimiter,
  buildQqUserAgent,
  chunkMarkdownText,
  chunkText,
  createQqGateway,
  getFallbackCredentialsPath,
  getPrimaryCredentialsPath,
  loadCachedQqCredentials,
  mapInboundMessage,
  resolveQqCredentials,
  saveQqCredentials,
} from '../src/qq/index.ts';
import type { QqBotClient, QrConnectStarter } from '../src/qq/index.ts';
import type { InboundMessage, RuntimeConfig } from '../src/shared/types.ts';

function makeTempDir(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}, dataDir = tmpdir()): RuntimeConfig {
  return {
    appId: '',
    appSecret: '',
    callbackHost: '127.0.0.1',
    callbackPort: 39871,
    dataDir,
    workspaceRoot: join(dataDir, 'workspace'),
    apiBaseUrl: 'https://api.bot.qq.com',
    tokenBaseUrl: 'https://bots.qq.com',
    markdownSupport: false,
    requireMentionInGroup: true,
    textChunkLimit: DEFAULT_TEXT_CHUNK_LIMIT,
    passiveReplyLimit: DEFAULT_PASSIVE_REPLY_LIMIT,
    debug: false,
    ...overrides,
  };
}

interface RecordedSdkSend {
  method: 'sendText' | 'sendMarkdown' | 'send';
  target: SdkReplyTarget;
  content: string;
  extra?: Record<string, unknown>;
}

class FakeQqBot implements QqBotClient {
  readonly appId: string;
  readonly options: QQBotOptions;
  readonly middlewares: Middleware[] = [];
  readonly sends: RecordedSdkSend[] = [];
  startCount = 0;
  stopCount = 0;
  lastSignal: AbortSignal | undefined;
  autoEmitReady = true;
  startError: Error | null = null;
  sendHandler: ((entry: RecordedSdkSend) => Promise<void> | void) | null = null;

  private readonly listeners = new Map<keyof QQBotEventMap, Set<(...args: unknown[]) => unknown>>();
  private resolveStartWait: (() => void) | null = null;
  private rejectStartWait: ((err: Error) => void) | null = null;

  constructor(options: QQBotOptions) {
    this.appId = options.appId;
    this.options = options;
  }

  use(...middleware: Middleware[]): this {
    this.middlewares.push(...middleware);
    return this;
  }

  on<K extends keyof QQBotEventMap>(event: K, handler: QQBotEventMap[K]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (...args: unknown[]) => unknown);
    return this;
  }

  async emitEvent<K extends keyof QQBotEventMap>(
    event: K,
    ...args: Parameters<QQBotEventMap[K]>
  ): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      await handler(...args);
    }
  }

  start(externalSignal?: AbortSignal): Promise<void> {
    this.startCount += 1;
    this.lastSignal = externalSignal;
    if (this.startError) {
      return Promise.reject(this.startError);
    }

    return new Promise<void>((resolvePromise, rejectPromise) => {
      this.resolveStartWait = resolvePromise;
      this.rejectStartWait = rejectPromise;

      const onAbort = (): void => {
        this.finishStart();
      };
      if (externalSignal) {
        if (externalSignal.aborted) {
          onAbort();
          return;
        }
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }

      if (this.autoEmitReady) {
        queueMicrotask(() => {
          void this.emitEvent('ready', { session_id: 'fake-session' });
        });
      }
    });
  }

  stop(): void {
    this.stopCount += 1;
    this.finishStart();
  }

  finishStart(): void {
    const done = this.resolveStartWait;
    this.resolveStartWait = null;
    this.rejectStartWait = null;
    done?.();
  }

  failStart(err: Error): void {
    const fail = this.rejectStartWait;
    this.resolveStartWait = null;
    this.rejectStartWait = null;
    fail?.(err);
  }

  async send(opts: SendMessageOptions): Promise<{ id: string; timestamp: string }> {
    const content = opts.markdown?.content ?? opts.content ?? '';
    const entry: RecordedSdkSend = {
      method: 'send',
      target: { ...opts.target },
      content,
      ...(opts.extra ? { extra: { ...opts.extra } } : {}),
    };
    this.sends.push(entry);
    if (this.sendHandler) {
      await this.sendHandler(entry);
    }
    return { id: `out-${this.sends.length}`, timestamp: new Date().toISOString() };
  }

  async sendText(target: SdkReplyTarget, content: string): Promise<{ id: string; timestamp: string }> {
    const entry: RecordedSdkSend = {
      method: 'sendText',
      target: { ...target },
      content,
    };
    this.sends.push(entry);
    if (this.sendHandler) {
      await this.sendHandler(entry);
    }
    return { id: `out-${this.sends.length}`, timestamp: new Date().toISOString() };
  }

  async sendMarkdown(
    target: SdkReplyTarget,
    content: string,
  ): Promise<{ id: string; timestamp: string }> {
    const entry: RecordedSdkSend = {
      method: 'sendMarkdown',
      target: { ...target },
      content,
    };
    this.sends.push(entry);
    if (this.sendHandler) {
      await this.sendHandler(entry);
    }
    return { id: `out-${this.sends.length}`, timestamp: new Date().toISOString() };
  }
}

test('MsgIdCache enforces C2C 30min / Group 5min TTLs, max 10 entries, and eventId tracking', () => {
  let now = 1_000_000;
  const cache = new MsgIdCache({ now: () => now });

  assert.equal(C2C_MSG_ID_TTL_MS, 30 * 60 * 1000);
  assert.equal(GROUP_MSG_ID_TTL_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_MAX_MSG_IDS_PER_TARGET, 10);

  // Empty refs are ignored
  assert.equal(cache.record('c2c', 'u1', { msgId: '   ' }), undefined);

  // Record 12 entries for c2c -> keeps latest 10
  for (let i = 1; i <= 12; i++) {
    now += 100;
    cache.record('c2c', 'u1', { msgId: `c2c-${i}`, eventId: `evt-${i}` });
  }
  const c2cEntries = cache.getValidEntries('c2c', 'u1');
  assert.equal(c2cEntries.length, 10);
  assert.equal(c2cEntries[0]?.msgId, 'c2c-12');
  assert.equal(c2cEntries[9]?.msgId, 'c2c-3');

  // Re-recording an existing msgId deduplicates and promotes to latest
  now += 100;
  cache.record('c2c', 'u1', { msgId: 'c2c-5' });
  assert.equal(cache.getLatest('c2c', 'u1')?.msgId, 'c2c-5');
  assert.equal(cache.size('c2c', 'u1'), 10);

  // Group TTL (5 min) vs C2C TTL (30 min)
  const groupRecordedAt = now;
  cache.record('group', 'g1', { msgId: 'grp-1', eventId: 'grp-evt-1' });
  assert.equal(cache.isMsgIdExpired('group', 'g1', 'grp-1'), false);
  assert.equal(cache.isEventIdExpired('group', 'g1', 'grp-evt-1'), false);

  // Advance just before 5 min -> still valid
  now = groupRecordedAt + GROUP_MSG_ID_TTL_MS - 1;
  assert.equal(cache.getLatest('group', 'g1')?.msgId, 'grp-1');
  assert.equal(cache.isMsgIdExpired('group', 'g1', 'grp-1'), false);

  // Advance to exact 5 min boundary -> group expired, c2c-5 still valid
  now = groupRecordedAt + GROUP_MSG_ID_TTL_MS;
  assert.equal(cache.getLatest('group', 'g1'), undefined);
  assert.equal(cache.isMsgIdExpired('group', 'g1', 'grp-1'), true);
  assert.equal(cache.isEventIdExpired('group', 'g1', 'grp-evt-1'), true);
  assert.equal(cache.isMsgIdExpired('c2c', 'u1', 'c2c-5'), false);

  // Unknown ids report false for isMsgIdExpired/isEventIdExpired
  assert.equal(cache.isMsgIdExpired('c2c', 'u1', 'never-seen'), false);

  // Advance past C2C 30 min -> c2c-5 expires
  now += C2C_MSG_ID_TTL_MS;
  assert.equal(cache.isMsgIdExpired('c2c', 'u1', 'c2c-5'), true);
  assert.equal(cache.size(), 0);

  cache.record('c2c', 'u2', { msgId: 'keep-1' });
  cache.record('c2c', 'u3', { msgId: 'keep-2' });
  cache.clear('c2c', 'u2');
  assert.equal(cache.size('c2c', 'u2'), 0);
  assert.equal(cache.size('c2c', 'u3'), 1);
  cache.clear();
  assert.equal(cache.size(), 0);
});

test('ReplyLimiter tracks limit, TTL window, zero limit, and fallback reasons', () => {
  let now = 500_000;
  const limiter = new ReplyLimiter({ limit: 3, ttlMs: 10_000, now: () => now });
  assert.deepEqual(limiter.getConfig(), { limit: 3, ttlMs: 10_000 });
  assert.equal(DEFAULT_REPLY_LIMIT_TTL_MS, 60 * 60 * 1000);

  // Missing messageId falls back as expired
  const missing = limiter.checkLimit('  ');
  assert.equal(missing.allowed, false);
  assert.equal(missing.shouldFallbackToProactive, true);
  assert.equal(missing.fallbackReason, 'expired');

  // 3 replies allowed
  for (let i = 0; i < 3; i++) {
    const check = limiter.checkLimit('msg-1');
    assert.equal(check.allowed, true);
    assert.equal(check.remaining, 3 - i);
    limiter.record('msg-1');
  }
  assert.deepEqual(limiter.getStats(), { trackedMessages: 1, totalReplies: 3 });

  // 4th hits limit_exceeded
  const exceeded = limiter.checkLimit('msg-1');
  assert.equal(exceeded.allowed, false);
  assert.equal(exceeded.remaining, 0);
  assert.equal(exceeded.shouldFallbackToProactive, true);
  assert.equal(exceeded.fallbackReason, 'limit_exceeded');

  // After TTL expires, checkLimit returns expired; recording resets window
  now += 10_000;
  const expired = limiter.checkLimit('msg-1');
  assert.equal(expired.allowed, false);
  assert.equal(expired.fallbackReason, 'expired');

  limiter.record('msg-1');
  const resetCheck = limiter.checkLimit('msg-1');
  assert.equal(resetCheck.allowed, true);
  assert.equal(resetCheck.remaining, 2);

  // Limit 0 blocks immediately
  const zeroLimiter = new ReplyLimiter({ limit: 0 });
  const zeroRes = zeroLimiter.checkLimit('msg-any');
  assert.equal(zeroRes.allowed, false);
  assert.equal(zeroRes.fallbackReason, 'limit_exceeded');
});

test('chunkText and chunkMarkdownText preserve code fences, GFM tables, surrogate pairs, and limit invariants', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkMarkdownText(''), []);
  assert.deepEqual(chunkText('hello\r\nworld', 50), ['hello\nworld']);

  // Prose line splitting prefers whitespace and preserves UTF-16 surrogate pairs
  const emojis = '😀'.repeat(12); // 24 UTF-16 code units
  const emojiChunks = chunkText(emojis, 5);
  assert.ok(emojiChunks.length >= 6);
  for (const chunk of emojiChunks) {
    assert.ok(chunk.length <= 5);
    assert.equal(chunk.length % 2, 0, 'must not split surrogate pair');
  }
  assert.equal(emojiChunks.join(''), emojis);

  // Fence preservation when fence fits
  const mdWithFence = [
    'Intro paragraph line.',
    '```ts',
    'const a = 1;',
    'const b = 2;',
    '```',
    'Outro line.',
  ].join('\n');
  const fenceChunks = chunkMarkdownText(mdWithFence, 45);
  assert.equal(fenceChunks.length, 3);
  assert.equal(fenceChunks[1], '```ts\nconst a = 1;\nconst b = 2;\n```');

  // Inline triple backticks do not start a fenced block
  const inlineCode = 'Use ```inline``` here.\nNext line of text.';
  const inlineChunks = chunkMarkdownText(inlineCode, 25);
  assert.equal(inlineChunks.length, 2);

  // Oversized fence splits cleanly with balanced open/close fences
  const bigFence = ['```js', 'line one', 'line two', 'linethreeextra', '```'].join('\n');
  const splitFence = chunkMarkdownText(bigFence, 20);
  assert.ok(splitFence.length >= 3);
  for (const chunk of splitFence) {
    assert.ok(chunk.length <= 20, `chunk exceeded limit: ${chunk}`);
    assert.ok(chunk.startsWith('```js\n'), `missing open fence: ${chunk}`);
    assert.ok(chunk.endsWith('\n```'), `missing close fence: ${chunk}`);
  }

  // GFM table preservation and oversized table row splitting with repeated headers
  const tableMd = [
    'Before table',
    '| Name | Role |',
    '| --- | --- |',
    '| Alice | Eng |',
    '| Bob | Ops |',
    '| Carol | QA |',
  ].join('\n');
  // Table alone is 74 chars; with "Before table\n" total is 87 chars, so limit 80 keeps table intact as chunk 2
  const keptTable = chunkMarkdownText(tableMd, 80);
  assert.equal(keptTable.length, 2);
  assert.equal(keptTable[0], 'Before table');
  assert.ok(keptTable[1]?.includes('| Carol | QA |'));

  const splitTable = chunkMarkdownText(tableMd.replace('Before table\n', ''), 50);
  assert.ok(splitTable.length >= 2);
  for (const chunk of splitTable) {
    assert.ok(chunk.length <= 50, `table chunk exceeded limit: ${chunk}`);
    assert.ok(chunk.includes('| Name | Role |'), `missing repeated header: ${chunk}`);
    assert.ok(chunk.includes('| --- | --- |'), `missing repeated separator: ${chunk}`);
  }
});

test('resolveQqCredentials follows env -> primary cache -> fallback .qqbot-data -> QR save precedence and abort', async (t) => {
  const dir = makeTempDir(t, 'qqbot-creds-');
  const dataDir = join(dir, 'data');
  const projectRoot = join(dir, 'project');
  const primaryPath = getPrimaryCredentialsPath(dataDir);
  const fallbackPath = getFallbackCredentialsPath(projectRoot);

  // 1. Explicit env wins when forceRebind is false
  const fromEnv = await resolveQqCredentials(
    makeConfig({ appId: 'env-app', appSecret: 'env-sec' }, dataDir),
    { projectRoot, allowQr: false },
  );
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.appId, 'env-app');
  assert.equal(fromEnv.appSecret, 'env-sec');

  // 2. Fallback .qqbot-data/credentials.json works when primary cache is absent
  saveQqCredentials(fallbackPath, { appId: 'fb-app', appSecret: 'fb-sec', userOpenid: 'u-fb' });
  const fromFallback = await resolveQqCredentials(makeConfig({}, dataDir), {
    projectRoot,
    allowQr: false,
  });
  assert.equal(fromFallback.source, 'cache');
  assert.equal(fromFallback.appId, 'fb-app');
  assert.equal(fromFallback.userOpenid, 'u-fb');
  assert.equal(fromFallback.cachePath, fallbackPath);

  // 3. Primary cache takes precedence over fallback cache
  saveQqCredentials(primaryPath, { appId: 'pri-app', appSecret: 'pri-sec' });
  const fromPrimary = await resolveQqCredentials(makeConfig({}, dataDir), {
    projectRoot,
    allowQr: false,
  });
  assert.equal(fromPrimary.source, 'cache');
  assert.equal(fromPrimary.appId, 'pri-app');
  assert.equal(fromPrimary.cachePath, primaryPath);

  // Malformed primary cache logs warning and falls back cleanly
  const badCachePath = join(dir, 'bad-creds.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(badCachePath, '{broken json', 'utf8');
  const warnings: string[] = [];
  assert.equal(
    loadCachedQqCredentials(badCachePath, {
      info: () => {},
      warn: (m) => warnings.push(m),
      error: () => {},
    }),
    null,
  );
  assert.equal(warnings.length, 1);

  // 4. forceRebind ignores env/cache and persists QR credentials atomically
  let qrUrls: string[] = [];
  const qrStarter: QrConnectStarter = (callbacks) => {
    callbacks.onQrDisplayed?.('https://q.qq.com/qr-demo');
    queueMicrotask(() => {
      callbacks.onSuccess([
        { appId: ' qr-app ', appSecret: ' qr-sec ', userOpenid: ' u-qr ' },
      ]);
    });
    return () => {};
  };

  const fromQr = await resolveQqCredentials(
    makeConfig({ appId: 'env-app', appSecret: 'env-sec', qrSource: 'test-src' }, dataDir),
    {
      projectRoot,
      forceRebind: true,
      qrConnectFn: qrStarter,
      onQrUrl: (u) => qrUrls.push(u),
    },
  );
  assert.equal(fromQr.source, 'qr');
  assert.equal(fromQr.appId, 'qr-app');
  assert.equal(fromQr.appSecret, 'qr-sec');
  assert.equal(fromQr.userOpenid, 'u-qr');
  assert.deepEqual(qrUrls, ['https://q.qq.com/qr-demo']);
  assert.ok(existsSync(primaryPath));
  const saved = JSON.parse(readFileSync(primaryPath, 'utf8')) as { appId: string; savedAt: string };
  assert.equal(saved.appId, 'qr-app');
  assert.ok(saved.savedAt);

  // 5. allowQr: false throws when unconfigured
  const emptyDir = join(dir, 'empty-data');
  await assert.rejects(
    () =>
      resolveQqCredentials(makeConfig({}, emptyDir), {
        projectRoot: join(dir, 'empty-proj'),
        allowQr: false,
      }),
    /not configured/,
  );

  // 6. AbortSignal aborts QR binding and invokes dispose()
  const ac = new AbortController();
  let disposed = false;
  const hangingQr: QrConnectStarter = () => {
    setTimeout(() => ac.abort(), 10);
    return () => {
      disposed = true;
    };
  };
  await assert.rejects(
    () =>
      resolveQqCredentials(makeConfig({}, emptyDir), {
        projectRoot: join(dir, 'empty-proj'),
        signal: ac.signal,
        qrConnectFn: hangingQr,
      }),
    /aborted/,
  );
  assert.equal(disposed, true);
});

test('createQqGateway handles SDK config, c2c/group inbound, fallback send paths, and concurrency', async (t) => {
  const dir = makeTempDir(t, 'qqbot-gw-');
  let now = 10_000;
  const msgIdCache = new MsgIdCache({ now: () => now });
  const replyLimiter = new ReplyLimiter({ limit: 2, now: () => now });
  const fakeBots: FakeQqBot[] = [];

  const cfg = makeConfig(
    {
      appId: 'app-123',
      appSecret: 'secret-xyz',
      markdownSupport: false,
      requireMentionInGroup: true,
      textChunkLimit: 12,
      passiveReplyLimit: 2,
    },
    dir,
  );

  const errors: Error[] = [];
  const gw = createQqGateway(cfg, {
    msgIdCache,
    replyLimiter,
    credentialOptions: { projectRoot: dir },
    userAgent: buildQqUserAgent(),
    botFactory: (opts) => {
      const bot = new FakeQqBot(opts);
      fakeBots.push(bot);
      return bot;
    },
    onError: (err) => errors.push(err),
  });

  // Calling sendReply before start rejects
  await assert.rejects(
    () => gw.sendReply({ target: { scope: 'c2c', targetId: 'u1' }, text: 'hi' }),
    /not started/,
  );

  await gw.start();
  const bot = fakeBots[0];
  assert.ok(bot);
  assert.equal(bot.options.transport, 'websocket');
  assert.equal(bot.options.appId, 'app-123');
  assert.equal(bot.options.baseUrl, cfg.apiBaseUrl);
  assert.equal(bot.options.tokenBaseUrl, cfg.tokenBaseUrl);
  assert.equal(bot.options.markdownSupport, false);
  assert.ok(bot.options.userAgent?.includes('antigravity-qqbot/'));
  // messageFilter, mentionGate, contentSanitizer
  assert.equal(bot.middlewares.length, 3);

  const received: InboundMessage[] = [];
  const off = gw.onInbound((msg) => {
    received.push(msg);
  });
  gw.onInbound(() => {
    throw new Error('secondary handler failure');
  });

  // C2C and Group inbound mapping
  const c2cInbound: QQBotInboundMessage = {
    kind: 'c2c',
    messageId: 'm-c2c-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'hello private',
    timestamp: '2026-01-01T00:00:00.000Z',
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'm-c2c-1' },
  } as unknown as QQBotInboundMessage;

  const groupInbound: QQBotInboundMessage = {
    kind: 'group',
    messageId: 'm-grp-1',
    senderId: 'member-2',
    groupOpenid: 'grp-100',
    content: 'hello group',
    timestamp: '2026-01-01T00:00:05.000Z',
    replyTarget: { scope: 'group', targetId: 'grp-100', msgId: 'm-grp-1' },
  } as unknown as QQBotInboundMessage;

  await bot.emitEvent('message', { receivedAt: now } as never, c2cInbound);
  await bot.emitEvent('message', { receivedAt: now } as never, groupInbound);

  assert.equal(received.length, 2);
  assert.equal(received[0]?.scope, 'c2c');
  assert.equal(received[0]?.peerId, 'user-1');
  assert.equal(received[0]?.senderName, 'Alice');
  assert.equal(received[0]?.botId, 'app-123');
  assert.equal(received[1]?.scope, 'group');
  assert.equal(received[1]?.peerId, 'grp-100');
  assert.equal(received[1]?.botId, 'app-123');
  assert.equal(errors.length, 2); // secondary handler failures isolated

  // Interaction event caches eventId
  const interactionEvt: InteractionEvent = {
    id: 'evt-grp-1',
    group_openid: 'grp-100',
    data: { resolved: { message_id: 'm-grp-2' } },
  } as unknown as InteractionEvent;
  await bot.emitEvent('interaction', {} as never, interactionEvt);

  // Passive reply -> cached msgId fallback -> proactive push across chunks
  // Seed an older unexpired msgId for c2c user-1 so fallback uses it before proactive
  now += 500;
  msgIdCache.record('c2c', 'user-1', { msgId: 'm-c2c-backup' });
  // Ensure m-c2c-1 is attempted first via reply.target.msgId (limit=2):
  // Chunk 1 -> m-c2c-1 (count=1)
  // Chunk 2 -> m-c2c-1 (count=2)
  // Chunk 3 -> m-c2c-1 exceeded -> fallback to cached m-c2c-backup (count=1)
  // Chunk 4 -> m-c2c-backup (count=2)
  // Chunk 5 -> all passive exhausted -> proactive (msgId: undefined)
  await gw.sendReply({
    target: { scope: 'c2c', targetId: 'user-1', msgId: 'm-c2c-1' },
    text: '1111111111\n2222222222\n3333333333\n4444444444\n5555555555',
  });

  assert.equal(bot.sends.length, 5);
  assert.equal(bot.sends[0]?.method, 'sendText');
  assert.equal(bot.sends[0]?.target.msgId, 'm-c2c-1');
  assert.equal(bot.sends[1]?.target.msgId, 'm-c2c-1');
  assert.equal(bot.sends[2]?.target.msgId, 'm-c2c-backup');
  assert.equal(bot.sends[3]?.target.msgId, 'm-c2c-backup');
  assert.equal(bot.sends[4]?.target.msgId, undefined);

  // Explicit eventId sends via bot.send with extra.event_id
  await gw.sendReply({
    target: { scope: 'group', targetId: 'grp-100', eventId: 'evt-direct' },
    text: 'via event',
  });
  assert.equal(bot.sends[5]?.method, 'send');
  assert.deepEqual(bot.sends[5]?.extra, { event_id: 'evt-direct' });

  // forceProactive skips msgId
  await gw.sendReply({
    target: { scope: 'group', targetId: 'grp-100', msgId: 'm-grp-1', forceProactive: true },
    text: 'proactive',
  });
  assert.equal(bot.sends[6]?.target.msgId, undefined);

  // Concurrent sends to the same peer serialize in call order
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => {
    releaseFirst = resolveGate;
  });
  bot.sendHandler = async (entry) => {
    order.push(`start:${entry.content}`);
    if (entry.content === 'first') {
      await firstGate;
    }
    order.push(`end:${entry.content}`);
  };
  const p1 = gw.sendReply({
    target: { scope: 'c2c', targetId: 'user-serial', forceProactive: true },
    text: 'first',
  });
  const p2 = gw.sendReply({
    target: { scope: 'c2c', targetId: 'user-serial', forceProactive: true },
    text: 'second',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(order, ['start:first']);
  releaseFirst();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);

  off();
  await gw.stop();
  assert.equal(bot.stopCount, 1);

  // Also check markdownSupport: true uses sendMarkdown and send(MARKDOWN) for eventId
  const mdBots: FakeQqBot[] = [];
  const mdGw = createQqGateway(
    makeConfig({ appId: 'md-app', appSecret: 'md-sec', markdownSupport: true }, dir),
    {
      credentialOptions: { projectRoot: dir },
      botFactory: (opts) => {
        const b = new FakeQqBot(opts);
        mdBots.push(b);
        return b;
      },
    },
  );
  await mdGw.start();
  await mdGw.sendReply({
    target: { scope: 'c2c', targetId: 'u-md', forceProactive: true },
    text: '# Hello **QQ**',
  });
  await mdGw.sendReply({
    target: { scope: 'c2c', targetId: 'u-md', eventId: 'evt-md' },
    text: '## Event MD',
  });
  assert.equal(mdBots[0]?.sends[0]?.method, 'sendMarkdown');
  assert.equal(mdBots[0]?.sends[1]?.method, 'send');
  assert.deepEqual(mdBots[0]?.sends[1]?.extra, { event_id: 'evt-md' });
  await mdGw.stop();
});

test('mapInboundMessage returns null when peerId or scope is invalid', () => {
  const invalid = mapInboundMessage({
    kind: 'guild',
    messageId: 'm1',
    senderId: 's1',
    content: 'hi',
  } as unknown as QQBotInboundMessage);
  assert.equal(invalid, null);

  const missingGroup = mapInboundMessage({
    kind: 'group',
    messageId: 'm2',
    senderId: 's1',
    content: 'hi',
  } as unknown as QQBotInboundMessage);
  assert.equal(missingGroup, null);
});

test('createQqGateway forwards disconnect events and cleans up on start failure', async (t) => {
  const dir = makeTempDir(t, 'qqbot-gw-err-');
  const disconnects: GatewayDisconnect[] = [];
  const gw = createQqGateway(
    makeConfig({ appId: 'a', appSecret: 'b' }, dir),
    {
      credentialOptions: { projectRoot: dir },
      botFactory: (opts) => {
        const b = new FakeQqBot(opts);
        b.autoEmitReady = false;
        const origStart = b.start.bind(b);
        b.start = (sig?: AbortSignal) => {
          const p = origStart(sig);
          queueMicrotask(() => {
            void b.emitEvent('disconnected', { code: 4004, reason: 'bad token', willReconnect: false });
            b.failStart(new Error('auth failed'));
          });
          return p;
        };
        return b;
      },
      onDisconnected: (ev) => disconnects.push(ev),
    },
  );

  await assert.rejects(() => gw.start(), /auth failed/);
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0]?.willReconnect, false);
});
