import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AgentApiClient,
  CallbackServer,
  DEFAULT_REPLY_TOKEN_TTL_MS,
  ReplyTokenRegistry,
  SessionStore,
  createAntigravityBridge,
  defaultAgentApiRunner,
  ensureSessionWorkspace,
  makeSessionKey,
  parseConversationId,
  resolveAgentApiCommand,
  resolveSessionWorkspaceDir,
  sanitizeWorkspaceSegment,
} from '../src/bridge/index.ts';
import type { AgentApiRunRequest, DeliverReplyParams } from '../src/bridge/index.ts';
import type { InboundMessage } from '../src/shared/types.ts';

function makeTempDir(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    scope: 'c2c',
    peerId: 'openid-1',
    senderId: 'openid-1',
    senderName: 'Alice',
    text: 'hello bridge',
    receivedAt: 1_700_000_000_000,
    replyTarget: { scope: 'c2c', targetId: 'openid-1', msgId: 'msg-1' },
    ...overrides,
  };
}

test('SessionStore persists atomically, reloads from disk, and handles touch/delete/clear', (t) => {
  const dir = makeTempDir(t, 'qqbot-sessions-');
  const store = new SessionStore({ dataDir: dir });

  assert.equal(makeSessionKey('c2c', 'u1'), 'c2c:u1');
  assert.equal(store.get('c2c', 'u1'), undefined);

  const s1 = store.upsert({
    scope: 'c2c',
    peerId: 'u1',
    conversationId: ' conv-1 ',
    lastActiveAt: 1000,
  });
  assert.equal(s1.conversationId, 'conv-1');
  assert.equal(s1.sessionKey, 'c2c:u1');
  assert.ok(existsSync(store.filePath));

  // Mutating returned snapshot does not mutate internal state
  s1.conversationId = 'tampered';
  assert.equal(store.getByKey('c2c:u1')?.conversationId, 'conv-1');

  const touched = store.touch('c2c', 'u1', 2000);
  assert.equal(touched?.lastActiveAt, 2000);

  store.upsert({ scope: 'group', peerId: 'g1', conversationId: 'conv-g1', lastActiveAt: 3000 });
  assert.equal(store.list().length, 2);

  // Reload in a fresh instance
  const reloaded = new SessionStore({ dataDir: dir });
  assert.equal(reloaded.get('c2c', 'u1')?.conversationId, 'conv-1');
  assert.equal(reloaded.get('c2c', 'u1')?.lastActiveAt, 2000);
  assert.equal(reloaded.get('group', 'g1')?.conversationId, 'conv-g1');

  assert.equal(reloaded.delete('c2c', 'u1'), true);
  assert.equal(reloaded.delete('c2c', 'u1'), false);
  assert.equal(reloaded.list().length, 1);

  reloaded.clear();
  assert.equal(reloaded.list().length, 0);

  // Corrupted sessions.json logs warning and initializes empty map
  const warnings: string[] = [];
  writeFileSync(store.filePath, '{not-valid-json', 'utf8');
  const corruptStore = new SessionStore({
    dataDir: dir,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
  });
  assert.equal(corruptStore.list().length, 0);
  assert.equal(warnings.length, 1);

  assert.throws(() => store.upsert({ scope: 'c2c', peerId: '', conversationId: 'c1' }), /peerId/);
  assert.throws(() => store.upsert({ scope: 'c2c', peerId: 'u1', conversationId: '  ' }), /conversationId/);
});

test('AgentApiClient resolves command, separates args with --, and parses conversation IDs', async () => {
  const winCmd = resolveAgentApiCommand({
    ANTIGRAVITY_AGENTAPI_EXE: 'C:\\Users\\中文名\\AppData\\language_server.exe',
  });
  assert.equal(winCmd.executable, 'C:\\Users\\中文名\\AppData\\language_server.exe');
  assert.deepEqual(winCmd.prefixArgs, ['agentapi']);

  const calls: AgentApiRunRequest[] = [];
  const client = new AgentApiClient({
    invocation: winCmd,
    defaultModel: 'gemini-pro',
    defaultProfile: 'qq-bot',
    runner: async (req) => {
      calls.push(req);
      if (req.args.includes('new-conversation')) {
        return { exitCode: 0, stdout: '{"response":{"conversationId":"conv-abc"}}', stderr: '' };
      }
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    },
  });

  const trickyPrompt = '--help && echo "hi" $PATH\nline2; rm -rf /';
  const convId = await client.newConversation(trickyPrompt, { title: 'QQ c2c: Alice' });
  assert.equal(convId, 'conv-abc');
  assert.deepEqual(calls[0]?.args, [
    'agentapi',
    'new-conversation',
    '--model=gemini-pro',
    '--title=QQ c2c: Alice',
    '--profile=qq-bot',
    '--',
    trickyPrompt,
  ]);

  await client.sendMessage('conv-abc', '--flag-looking-content', { title: 'turn-2' });
  assert.deepEqual(calls[1]?.args, [
    'agentapi',
    'send-message',
    '--title=turn-2',
    '--',
    'conv-abc',
    '--flag-looking-content',
  ]);

  // Real defaultAgentApiRunner spawn with special chars & non-shell execution
  const specialArg = 'hello "world" & $(whoami) %PATH%\n--not-a-flag 中文';
  const realRes = await defaultAgentApiRunner({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', specialArg],
  });
  assert.equal(realRes.exitCode, 0);
  assert.deepEqual(JSON.parse(realRes.stdout), [specialArg]);

  // defaultAgentApiRunner timeout handling
  await assert.rejects(
    () =>
      defaultAgentApiRunner({
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        timeoutMs: 60,
      }),
    /timed out/,
  );

  // parseConversationId variants
  assert.equal(parseConversationId('{"conversationId":"id-1"}'), 'id-1');
  assert.equal(parseConversationId('{"conversation_id":"id-2"}'), 'id-2');
  assert.equal(parseConversationId('{"data":{"cascadeId":"id-3"}}'), 'id-3');
  assert.equal(parseConversationId('{"cascade_id":"id-4"}'), 'id-4');
  assert.equal(parseConversationId('{"response":"id-5"}'), 'id-5');
  assert.equal(parseConversationId('{"result":{"id":"id-6"}}'), 'id-6');
  assert.equal(
    parseConversationId('Starting...\n{"conversationMetadata":{"conversationId":"id-7"}}\n'),
    'id-7',
  );
  assert.equal(
    parseConversationId('Created cascade 123e4567-e89b-12d3-a456-426614174000 successfully'),
    '123e4567-e89b-12d3-a456-426614174000',
  );
  assert.throws(() => parseConversationId(''), /empty stdout/);
  assert.throws(() => parseConversationId('{"error":"quota exceeded"}'), /quota exceeded/);
  assert.throws(() => parseConversationId('not-a-uuid-or-json'), /Unable to parse/);
});

test('ReplyTokenRegistry supports TTL expiration, reuse within TTL, prune, and revoke', () => {
  let now = 10_000;
  const registry = new ReplyTokenRegistry({ ttlMs: 5_000, now: () => now });
  assert.equal(DEFAULT_REPLY_TOKEN_TTL_MS, 30 * 60 * 1000);

  const tok = registry.issue({ scope: 'group', targetId: 'g1', msgId: 'm1' });
  assert.equal(registry.size, 1);

  // Reusable multiple times before expiry, returns defensive copy
  const r1 = registry.resolve(tok);
  assert.deepEqual(r1, { scope: 'group', targetId: 'g1', msgId: 'm1' });
  if (r1) r1.targetId = 'mutated';
  const r2 = registry.resolve(tok);
  assert.equal(r2?.targetId, 'g1');

  // Expiry boundary
  now += 5_000;
  assert.equal(registry.resolve(tok), undefined);
  assert.equal(registry.size, 0);

  // Revoke & prune
  const tokA = registry.issue({ scope: 'c2c', targetId: 'u1' }, 100);
  const tokB = registry.issue({ scope: 'c2c', targetId: 'u2' }, 10_000);
  assert.equal(registry.revoke(tokB), true);
  assert.equal(registry.revoke(tokB), false);
  now += 200;
  assert.equal(registry.prune(), 1);
  assert.equal(registry.resolve(tokA), undefined);
});

test('CallbackServer enforces loopback routes, body size limits, token resolution, and delivery errors', async (t) => {
  let now = 1_000;
  const registry = new ReplyTokenRegistry({ ttlMs: 60_000, now: () => now });
  const validToken = registry.issue({ scope: 'c2c', targetId: 'u1', msgId: 'm1' });
  const delivered: DeliverReplyParams[] = [];
  let shouldThrow = false;

  const server = new CallbackServer({
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 128,
    replyTokens: registry,
    now: () => now,
    onDeliverReply: async (params) => {
      if (shouldThrow) {
        throw new Error('gateway offline');
      }
      delivered.push(params);
      return { chunksSent: 2, deliveredAt: 9999 };
    },
  });

  await server.start();
  t.after(async () => {
    await server.stop();
  });

  assert.equal(server.isListening(), true);
  const baseUrl = server.getUrl();
  assert.ok(baseUrl.startsWith('http://127.0.0.1:'));

  now = 2_500;
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), { ok: true, uptimeMs: 1500 });

  const healthPost = await fetch(`${baseUrl}/health`, { method: 'POST' });
  assert.equal(healthPost.status, 405);
  assert.equal(healthPost.headers.get('allow'), 'GET');

  const replyGet = await fetch(`${baseUrl}/reply`);
  assert.equal(replyGet.status, 405);
  assert.equal(replyGet.headers.get('allow'), 'POST');

  const notFound = await fetch(`${baseUrl}/unknown`);
  assert.equal(notFound.status, 404);

  // 400 validation errors
  const badJson = await fetch(`${baseUrl}/reply`, { method: 'POST', body: '{bad' });
  assert.equal(badJson.status, 400);

  const blankText = await fetch(`${baseUrl}/reply`, {
    method: 'POST',
    body: JSON.stringify({ replyToken: validToken, text: '   ' }),
  });
  assert.equal(blankText.status, 400);

  // 404 unknown token
  const unknownTok = await fetch(`${baseUrl}/reply`, {
    method: 'POST',
    body: JSON.stringify({ replyToken: 'missing-tok', text: 'hi' }),
  });
  assert.equal(unknownTok.status, 404);

  // 413 oversized payload
  const hugeRes = await fetch(`${baseUrl}/reply`, {
    method: 'POST',
    body: JSON.stringify({ replyToken: validToken, text: 'x'.repeat(300) }),
  });
  assert.equal(hugeRes.status, 413);

  // 200 successful delivery
  const okRes = await fetch(`${baseUrl}/reply`, {
    method: 'POST',
    body: JSON.stringify({ replyToken: validToken, text: 'hello qq' }),
  });
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { ok: true, deliveredAt: 9999, chunksSent: 2 });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.text, 'hello qq');
  assert.equal(delivered[0]?.target.targetId, 'u1');

  // 500 handler exception
  shouldThrow = true;
  const errRes = await fetch(`${baseUrl}/reply`, {
    method: 'POST',
    body: JSON.stringify({ replyToken: validToken, text: 'retry' }),
  });
  assert.equal(errRes.status, 500);
  const errJson = (await errRes.json()) as { ok: boolean; error: string };
  assert.equal(errJson.ok, false);
  assert.match(errJson.error, /gateway offline/);
});

test('createAntigravityBridge serializes per sessionKey, falls back on sendMessage error, and serves HTTP callback', async (t) => {
  const dir = makeTempDir(t, 'qqbot-bridge-');
  const delivered: DeliverReplyParams[] = [];
  const runnerLog: string[] = [];
  let releaseFirstNewConv!: () => void;
  const firstConvGate = new Promise<void>((resolveGate) => {
    releaseFirstNewConv = resolveGate;
  });
  let newConvCounter = 0;
  let failSendOnce = true;

  const bridge = createAntigravityBridge({
    dataDir: dir,
    callbackHost: '127.0.0.1',
    callbackPort: 0,
    onDeliverReply: async (params) => {
      delivered.push(params);
      return { chunksSent: 1 };
    },
    runner: async (req) => {
      if (req.args.includes('new-conversation')) {
        newConvCounter += 1;
        const id = `conv-${newConvCounter}`;
        runnerLog.push(`new:${id}`);
        if (newConvCounter === 1) {
          await firstConvGate;
        }
        return { exitCode: 0, stdout: JSON.stringify({ conversationId: id }), stderr: '' };
      }
      const sepIdx = req.args.indexOf('--');
      const convId = req.args[sepIdx + 1] ?? '';
      const prompt = req.args[sepIdx + 2] ?? '';
      runnerLog.push(`send:${convId}`);
      if (failSendOnce) {
        failSendOnce = false;
        return { exitCode: 1, stdout: '', stderr: 'conversation archived' };
      }
      const tokenMatch = /replyToken:\s*(\S+)/.exec(prompt);
      if (tokenMatch?.[1]) {
        // Trigger real HTTP callback while bridge is running
        const res = await fetch(`${bridge.getCallbackUrl()}/reply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replyToken: tokenMatch[1], text: 'pong from agent' }),
        });
        assert.equal(res.status, 200);
      }
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    },
  });

  await bridge.start();
  t.after(async () => {
    await bridge.stop();
  });

  // Two concurrent dispatches to the same peer must serialize:
  // 1st creates conv-1, 2nd sees existing conv-1, fails sendMessage once, falls back to newConversation -> conv-2
  const p1 = bridge.dispatchInbound(makeInbound({ messageId: 'm1', text: 'turn 1' }));
  const p2 = bridge.dispatchInbound(makeInbound({ messageId: 'm2', text: 'turn 2' }));

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(runnerLog, ['new:conv-1']);
  releaseFirstNewConv();

  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1.conversationId, 'conv-1');
  assert.equal(s2.conversationId, 'conv-2');
  assert.deepEqual(runnerLog, ['new:conv-1', 'send:conv-1', 'new:conv-2']);

  // 3rd dispatch uses conv-2 and invokes HTTP callback
  const s3 = await bridge.dispatchInbound(
    makeInbound({
      messageId: 'm3',
      text: 'turn 3',
      replyTarget: { scope: 'c2c', targetId: 'openid-1', msgId: 'm3' },
    }),
  );
  assert.equal(s3.conversationId, 'conv-2');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.text, 'pong from agent');
  assert.equal(delivered[0]?.target.msgId, 'm3');

  // Verify persisted on disk
  const persisted = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as {
    sessions: Record<string, { conversationId: string; workspaceDir?: string }>;
  };
  assert.equal(persisted.sessions['c2c:openid-1']?.conversationId, 'conv-2');
  assert.ok(persisted.sessions['c2c:openid-1']?.workspaceDir);
  assert.ok(existsSync(persisted.sessions['c2c:openid-1']!.workspaceDir!));
});

test('workspace isolation creates distinct per-bot and per-session folders safely', async (t) => {
  const dir = makeTempDir(t, 'qqbot-ws-iso-');
  const workspaceRoot = join(dir, 'qq-bot-workspaces-中文');

  assert.equal(sanitizeWorkspaceSegment('1020304050'), '1020304050');
  assert.notEqual(
    sanitizeWorkspaceSegment('../../etc/passwd'),
    sanitizeWorkspaceSegment('etc_passwd'),
  );
  assert.equal(sanitizeWorkspaceSegment('a:b/c\\d').includes(':'), false);

  const pBot1User1 = resolveSessionWorkspaceDir({
    workspaceRoot,
    botId: 'bot-A',
    scope: 'c2c',
    peerId: 'user-1',
  });
  const pBot1User2 = resolveSessionWorkspaceDir({
    workspaceRoot,
    botId: 'bot-A',
    scope: 'c2c',
    peerId: 'user-2',
  });
  const pBot1Group1 = resolveSessionWorkspaceDir({
    workspaceRoot,
    botId: 'bot-A',
    scope: 'group',
    peerId: 'grp-1',
  });
  const pBot2User1 = resolveSessionWorkspaceDir({
    workspaceRoot,
    botId: 'bot-B',
    scope: 'c2c',
    peerId: 'user-1',
  });

  assert.equal(pBot1User1.botDir, pBot1User2.botDir);
  assert.equal(pBot1User1.botDir, pBot1Group1.botDir);
  assert.notEqual(pBot1User1.botDir, pBot2User1.botDir);
  assert.notEqual(pBot1User1.sessionDir, pBot1User2.sessionDir);
  assert.notEqual(pBot1User1.sessionDir, pBot1Group1.sessionDir);
  assert.notEqual(pBot1User1.sessionDir, pBot2User1.sessionDir);

  const created = ensureSessionWorkspace({
    workspaceRoot,
    botId: '1020304050',
    scope: 'c2c',
    peerId: 'USEROPENID0001ABCDEF1234567890AB',
  });
  assert.ok(existsSync(created.sessionDir));

  // Verify createAntigravityBridge passes per-session cwd and prompt workspace header and separates sessions by botId
  const runnerCwds: Array<string | undefined> = [];
  const runnerPrompts: string[] = [];
  let seq = 0;

  const bridge = createAntigravityBridge({
    dataDir: join(dir, 'data'),
    workspaceRoot,
    callbackPort: 0,
    runner: async (req) => {
      runnerCwds.push(req.cwd);
      const sepIdx = req.args.indexOf('--');
      runnerPrompts.push(req.args[sepIdx + 1] ?? '');
      seq += 1;
      return { exitCode: 0, stdout: JSON.stringify({ conversationId: `conv-${seq}` }), stderr: '' };
    },
  });

  await bridge.start();
  t.after(async () => {
    await bridge.stop();
  });

  const sA1 = await bridge.dispatchInbound(
    makeInbound({ botId: 'bot-111', scope: 'c2c', peerId: 'peer-same', messageId: 'm1' }),
  );
  const sB1 = await bridge.dispatchInbound(
    makeInbound({ botId: 'bot-222', scope: 'c2c', peerId: 'peer-same', messageId: 'm2' }),
  );
  const sAGrp = await bridge.dispatchInbound(
    makeInbound({ botId: 'bot-111', scope: 'group', peerId: 'grp-9', messageId: 'm3' }),
  );

  assert.equal(sA1.conversationId, 'conv-1');
  assert.equal(sB1.conversationId, 'conv-2');
  assert.equal(sAGrp.conversationId, 'conv-3');
  assert.ok(sA1.workspaceDir && existsSync(sA1.workspaceDir));
  assert.ok(sB1.workspaceDir && existsSync(sB1.workspaceDir));
  assert.ok(sAGrp.workspaceDir && existsSync(sAGrp.workspaceDir));
  assert.notEqual(sA1.workspaceDir, sB1.workspaceDir);
  assert.notEqual(sA1.workspaceDir, sAGrp.workspaceDir);
  assert.equal(runnerCwds[0], sA1.workspaceDir);
  assert.equal(runnerCwds[1], sB1.workspaceDir);
  assert.equal(runnerCwds[2], sAGrp.workspaceDir);
  assert.match(runnerPrompts[0] ?? '', new RegExp(`workspace:\\s*${sA1.workspaceDir!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(runnerPrompts[0] ?? '', /botId:\s*bot-111/);
});
