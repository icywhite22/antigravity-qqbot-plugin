import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { GatewayDisconnect } from '@tencent-connect/qqbot-nodejs';
import { createAntigravityBridge } from '../src/bridge/index.ts';
import {
  createGatewayRuntime,
  formatGatewayHelp,
  isDirectExecution,
  parseGatewayCliArgs,
  runGatewayEntry,
} from '../src/gateway-entry.ts';
import { postCallbackReply } from '../src/mcp/index.ts';
import { createQqGateway } from '../src/qq/index.ts';
import type { QqGateway } from '../src/qq/index.ts';
import type { InboundMessage, OutboundReply } from '../src/shared/types.ts';

function makeTempDir(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function captureStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    text += chunk;
  });
  return {
    stream,
    read: () => text,
  };
}

test('isDirectExecution, parseGatewayCliArgs, and CLI --help behave safely', async () => {
  const entryPath = resolve(import.meta.dirname, '..', 'src', 'gateway-entry.ts');
  const entryUrl = pathToFileURL(entryPath).href;

  assert.equal(isDirectExecution(undefined, entryUrl), false);
  assert.equal(isDirectExecution(import.meta.filename, entryUrl), false);
  assert.equal(isDirectExecution(entryPath, entryUrl), true);
  assert.equal(isDirectExecution(entryUrl, entryUrl), true);

  assert.deepEqual(parseGatewayCliArgs([]), {
    help: false,
    forceRebind: false,
    debug: false,
  });
  assert.deepEqual(parseGatewayCliArgs(['--', '--rebind', '--debug', '-h']), {
    help: true,
    forceRebind: true,
    debug: true,
  });
  assert.deepEqual(parseGatewayCliArgs(['--qr']), {
    help: false,
    forceRebind: true,
    debug: false,
  });
  assert.throws(() => parseGatewayCliArgs(['--bogus']), /Unknown option/);
  assert.match(formatGatewayHelp(), /Usage: node src\/gateway-entry\.ts/);

  // Real subprocess --help
  const helpProc = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveProc) => {
      const child = spawn(process.execPath, [entryPath, '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString('utf8');
      });
      child.once('close', (code) => resolveProc({ code, stdout: out, stderr: err }));
    },
  );
  assert.equal(helpProc.code, 0);
  assert.match(helpProc.stdout, /--rebind, --qr/);
  assert.equal(helpProc.stderr, '');
});

test('createGatewayRuntime enforces startup order, rollback, secret redaction, and full E2E QQ <-> Bridge <-> MCP callback flow', async (t) => {
  const dir = makeTempDir(t, 'qqbot-entry-e2e-');
  const dataDir = join(dir, 'data');
  const secretValue = 'super-secret-token-12345';

  writeFileSync(
    join(dir, '.env'),
    [
      'QQBOT_APPID=env-app-id',
      `QQBOT_SECRET=${secretValue}`,
      'QQBOT_CALLBACK_HOST=127.0.0.1',
      'QQBOT_CALLBACK_PORT=0',
      `QQBOT_DATA_DIR=${dataDir}`,
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, '.env.local'), 'QQBOT_APPID=local-app-id\n', 'utf8');

  // 1. Rollback test: if gateway.start() fails after bridge.start(), bridge.stop() is called
  const lifecycleEvents: string[] = [];
  const rollbackOut = captureStream();
  const rollbackErr = captureStream();

  const rollbackRuntime = createGatewayRuntime({
    projectRoot: dir,
    baseEnv: {},
    stdout: rollbackOut.stream,
    stderr: rollbackErr.stream,
    createBridge: () => ({
      start: async () => {
        lifecycleEvents.push('bridge:start');
      },
      stop: async () => {
        lifecycleEvents.push('bridge:stop');
      },
      dispatchInbound: async () => {
        throw new Error('unused');
      },
      getSession: () => undefined,
      getCallbackUrl: () => 'http://127.0.0.1:39871',
    }),
    createGateway: (): QqGateway => ({
      start: async () => {
        lifecycleEvents.push('gateway:start');
        throw new Error(`gateway failed with ${secretValue}`);
      },
      stop: async () => {
        lifecycleEvents.push('gateway:stop');
      },
      sendReply: async () => {},
      onInbound: () => () => {},
    }),
  });

  await assert.rejects(() => rollbackRuntime.start(), new RegExp(secretValue));
  assert.deepEqual(lifecycleEvents, ['bridge:start', 'gateway:start', 'bridge:stop']);

  // Verify runGatewayEntry redacts secret in stderr and returns exit code 1 on startup failure
  const failedOut = captureStream();
  const failedErr = captureStream();
  const failCode = await runGatewayEntry([], {
    projectRoot: dir,
    baseEnv: {},
    installSignalHandlers: false,
    stdout: failedOut.stream,
    stderr: failedErr.stream,
    createBridge: () => ({
      start: async () => {},
      stop: async () => {},
      dispatchInbound: async () => {
        throw new Error('unused');
      },
      getSession: () => undefined,
      getCallbackUrl: () => 'http://127.0.0.1:39871',
    }),
    createGateway: () => ({
      start: async () => {
        throw new Error(`auth error using ${secretValue}`);
      },
      stop: async () => {},
      sendReply: async () => {},
      onInbound: () => () => {},
    }),
  });
  assert.equal(failCode, 1);
  assert.equal(failedErr.read().includes(secretValue), false);
  assert.match(failedErr.read(), /\[REDACTED\]/);

  // 2. Full end-to-end runtime wiring: real createQqGateway + real createAntigravityBridge + real HTTP CallbackServer + postCallbackReply
  const sentToQq: Array<{ method: string; target: unknown; content: string }> = [];
  let triggerInbound!: (msg: unknown) => Promise<void>;
  const stdoutCap = captureStream();
  const stderrCap = captureStream();

  const runtime = createGatewayRuntime({
    projectRoot: dir,
    baseEnv: { QQBOT_APPID: 'override-app-id' },
    stdout: stdoutCap.stream,
    stderr: stderrCap.stream,
    createGateway: (cfg, gwOpts) =>
      createQqGateway(cfg, {
        ...gwOpts,
        botFactory: () => {
          const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
          return {
            appId: cfg.appId,
            use: () => {},
            on: (evt, handler) => {
              const list = listeners.get(String(evt)) ?? [];
              list.push(handler as (...args: unknown[]) => unknown);
              listeners.set(String(evt), list);
              if (evt === 'message') {
                triggerInbound = async (msg: unknown) => {
                  for (const h of list) {
                    await h({ receivedAt: Date.now() }, msg);
                  }
                };
              }
            },
            start: (signal) =>
              new Promise<void>((resolveStart) => {
                queueMicrotask(() => {
                  for (const h of listeners.get('ready') ?? []) {
                    h({ session_id: 'e2e-session' });
                  }
                });
                if (signal?.aborted) {
                  resolveStart();
                  return;
                }
                signal?.addEventListener('abort', () => resolveStart(), { once: true });
              }),
            stop: () => {},
            send: async (opts) => {
              sentToQq.push({ method: 'send', target: opts.target, content: opts.content ?? '' });
              return { id: 'out-1', timestamp: '' };
            },
            sendText: async (target, content) => {
              sentToQq.push({ method: 'sendText', target, content });
              return { id: 'out-1', timestamp: '' };
            },
            sendMarkdown: async (target, content) => {
              sentToQq.push({ method: 'sendMarkdown', target, content });
              return { id: 'out-1', timestamp: '' };
            },
          };
        },
      }),
    createBridge: (bridgeOpts) =>
      createAntigravityBridge({
        ...bridgeOpts,
        runner: async (req) => {
          const sepIdx = req.args.indexOf('--');
          const prompt = req.args[sepIdx + 1] ?? '';
          const tokenMatch = /replyToken:\s*(\S+)/.exec(prompt);
          assert.ok(tokenMatch?.[1], 'prompt must include replyToken');

          if (prompt.includes('fail-turn')) {
            return { exitCode: 1, stdout: '', stderr: `agentapi error ${secretValue}` };
          }

          const url = new URL(runtime.bridge.getCallbackUrl());
          const cbRes = await postCallbackReply(
            { replyToken: tokenMatch[1], text: 'E2E reply via MCP client' },
            { callbackHost: url.hostname, callbackPort: Number(url.port) },
          );
          assert.equal(cbRes.ok, true);
          return { exitCode: 0, stdout: '{"conversationId":"conv-e2e-1"}', stderr: '' };
        },
      }),
  });

  assert.equal(runtime.config.appId, 'override-app-id'); // baseEnv > .env.local > .env
  assert.equal(runtime.config.appSecret, secretValue);

  await runtime.start();
  t.after(async () => {
    if (!runtime.isStopped()) {
      await runtime.stop('test-cleanup');
    }
  });

  assert.equal(runtime.isRunning(), true);
  assert.match(stdoutCap.read(), /Bridge callback server listening at http:\/\/127\.0\.0\.1:/);

  await triggerInbound({
    kind: 'c2c',
    messageId: 'qq-msg-99',
    senderId: 'user-e2e',
    senderName: 'Bob',
    content: 'ping e2e',
    replyTarget: { scope: 'c2c', targetId: 'user-e2e', msgId: 'qq-msg-99' },
  });

  assert.equal(sentToQq.length, 1);
  assert.equal(sentToQq[0]?.method, 'sendText');
  assert.deepEqual(sentToQq[0]?.target, {
    scope: 'c2c',
    targetId: 'user-e2e',
    msgId: 'qq-msg-99',
  });
  assert.equal(sentToQq[0]?.content, 'E2E reply via MCP client');

  // Failed inbound dispatch does not crash gateway and redacts secret in stderr
  await triggerInbound({
    kind: 'c2c',
    messageId: 'qq-msg-100',
    senderId: 'user-err',
    content: 'fail-turn',
    replyTarget: { scope: 'c2c', targetId: 'user-err', msgId: 'qq-msg-100' },
  });
  assert.equal(stderrCap.read().includes(secretValue), false);
  assert.match(stderrCap.read(), /\[REDACTED\]/);

  await runtime.stop('done');
  assert.equal(runtime.isStopped(), true);
  assert.equal(runtime.isRunning(), false);
});

test('runGatewayEntry exits 0 on AbortSignal and exits 1 on permanent gateway disconnect', async (t) => {
  const dir = makeTempDir(t, 'qqbot-entry-lifecycle-');
  const ac = new AbortController();
  const stopOrder: string[] = [];

  const signalExitPromise = runGatewayEntry([], {
    projectRoot: dir,
    baseEnv: { QQBOT_APPID: 'a', QQBOT_SECRET: 'b', QQBOT_CALLBACK_PORT: '0' },
    signal: ac.signal,
    installSignalHandlers: false,
    stdout: captureStream().stream,
    stderr: captureStream().stream,
    createBridge: () => ({
      start: async () => {},
      stop: async () => {
        stopOrder.push('bridge');
      },
      dispatchInbound: async () => ({
        sessionKey: 'c2c:1',
        conversationId: 'c1',
        scope: 'c2c',
        peerId: '1',
        lastActiveAt: 1,
      }),
      getSession: () => undefined,
      getCallbackUrl: () => 'http://127.0.0.1:39871',
    }),
    createGateway: () => ({
      start: async () => {
        setTimeout(() => ac.abort(), 15);
      },
      stop: async () => {
        stopOrder.push('gateway');
      },
      sendReply: async (_r: OutboundReply) => {},
      onInbound: () => () => {},
    }),
  });

  assert.equal(await signalExitPromise, 0);
  assert.deepEqual(stopOrder, ['gateway', 'bridge']);

  // Permanent disconnect returns 1
  const disconnectExit = await runGatewayEntry([], {
    projectRoot: dir,
    baseEnv: { QQBOT_APPID: 'a', QQBOT_SECRET: 'b', QQBOT_CALLBACK_PORT: '0' },
    installSignalHandlers: false,
    stdout: captureStream().stream,
    stderr: captureStream().stream,
    createBridge: () => ({
      start: async () => {},
      stop: async () => {},
      dispatchInbound: async () => ({
        sessionKey: 'c2c:1',
        conversationId: 'c1',
        scope: 'c2c',
        peerId: '1',
        lastActiveAt: 1,
      }),
      getSession: () => undefined,
      getCallbackUrl: () => 'http://127.0.0.1:39871',
    }),
    createGateway: (_cfg, gwOpts) => ({
      start: async () => {
        setTimeout(() => {
          const evt: GatewayDisconnect = { code: 4004, reason: 'invalid token', willReconnect: false };
          gwOpts.onDisconnected?.(evt);
        }, 15);
      },
      stop: async () => {},
      sendReply: async () => {},
      onInbound: () => () => {},
    }),
  });
  assert.equal(disconnectExit, 1);

  // Invalid CLI flag returns 1
  const badFlagExit = await runGatewayEntry(['--invalid-flag'], {
    projectRoot: dir,
    installSignalHandlers: false,
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  });
  assert.equal(badFlagExit, 1);
});

// Keep InboundMessage type used cleanly
const _typeCheck: InboundMessage | null = null;
assert.equal(_typeCheck, null);
