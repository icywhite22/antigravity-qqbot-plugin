import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  DEFAULT_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  QQBOT_REPLY_TOOL_NAME,
  createMcpServer,
  formatQqbotReplyToolResult,
  getPlannedMcpTools,
  postCallbackReply,
} from '../src/mcp/index.ts';
import type { JsonRpcResponse } from '../src/mcp/index.ts';
import type { CallbackReplyRequest } from '../src/shared/types.ts';

function collectLines(stream: PassThrough): {
  lines: string[];
  waitForCount(count: number, timeoutMs?: number): Promise<string[]>;
} {
  const lines: string[] = [];
  let buffer = '';
  const waiters: Array<() => void> = [];

  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        lines.push(line);
      }
      idx = buffer.indexOf('\n');
    }
    for (const notify of waiters.splice(0)) {
      notify();
    }
  });

  return {
    lines,
    async waitForCount(count: number, timeoutMs = 3000): Promise<string[]> {
      const deadline = Date.now() + timeoutMs;
      while (lines.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} JSON-RPC lines (got ${lines.length})`);
        }
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, 20);
          waiters.push(() => {
            clearTimeout(timer);
            resolveWait();
          });
        });
      }
      return lines;
    },
  };
}

test('createMcpServer handles split UTF-8 chunks, falsy IDs, MCP lifecycle, tool calls, and JSON-RPC error codes', async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutCollector = collectLines(stdout);

  let stderrText = '';
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  const delivered: CallbackReplyRequest[] = [];
  const server = createMcpServer({
    stdin,
    stdout,
    stderr,
    debug: true,
    deliverReply: async (req) => {
      if (req.replyToken === 'boom') {
        throw new Error('unexpected transport crash');
      }
      delivered.push(req);
      return { ok: true, chunksSent: 1, deliveredAt: 1_700_000_000_000 };
    },
  });

  server.start();
  t.after(async () => {
    await server.stop();
  });

  assert.equal(server.isStarted(), true);
  assert.equal(server.isInitialized(), false);
  assert.equal(getPlannedMcpTools()[0]?.name, QQBOT_REPLY_TOOL_NAME);

  // 1. initialize with falsy numeric id=0
  stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })}\r\n`,
  );

  // 2. notifications/initialized (must NOT produce a stdout response)
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  // 3. ping with falsy string id=""
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: '', method: 'ping' })}\n`);

  // 4. tools/list
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list' })}\n`);

  // 5. tools/call split across mid-UTF-8 multi-byte codepoint boundaries
  const toolCallBytes = Buffer.from(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'qqbot_reply',
        arguments: { replyToken: 'tok-utf8', text: '你好🚀世界' },
      },
    })}\n`,
    'utf8',
  );
  const splitIdx = toolCallBytes.indexOf(Buffer.from('🚀', 'utf8')) + 2;
  stdin.write(toolCallBytes.subarray(0, splitIdx));
  stdin.write(toolCallBytes.subarray(splitIdx));

  // 6. Error codes: -32700 parse error, -32600 invalid request, -32601 method not found, -32602 invalid params
  stdin.write('{not valid json\n');
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'unknown/method' })}\n`);
  stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'qqbot_reply', arguments: { replyToken: '  ', text: 'hi' } },
    })}\n`,
  );

  // 7. Throwing deliverReply returns tool result with isError: true
  stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'qqbot_reply', arguments: { replyToken: 'boom', text: 'hi' } },
    })}\n`,
  );

  const rawLines = await stdoutCollector.waitForCount(9);
  const responses = rawLines.map((l) => JSON.parse(l) as JsonRpcResponse);

  // Check id=0 initialize
  const initRes = responses[0] as { id: unknown; result: { protocolVersion: string; serverInfo: { name: string; version: string } } };
  assert.equal(initRes.id, 0);
  assert.equal(initRes.result.protocolVersion, '2025-03-26');
  assert.equal(initRes.result.serverInfo.name, MCP_SERVER_NAME);
  assert.equal(initRes.result.serverInfo.version, MCP_SERVER_VERSION);
  assert.equal(server.isInitialized(), true);

  // Check id="" ping
  const pingRes = responses[1] as { id: unknown; result: Record<string, unknown> };
  assert.equal(pingRes.id, '');
  assert.deepEqual(pingRes.result, {});

  // Check tools/list
  const listRes = responses[2] as { id: unknown; result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } };
  assert.equal(listRes.id, 'list-1');
  assert.equal(listRes.result.tools[0]?.name, 'qqbot_reply');
  assert.deepEqual(listRes.result.tools[0]?.inputSchema.required, ['replyToken', 'text']);

  // Check tools/call UTF-8 preservation
  const callRes = responses[3] as { id: unknown; result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.equal(callRes.id, 5);
  assert.equal(callRes.result.isError, undefined);
  assert.match(callRes.result.content[0]?.text ?? '', /Reply delivered to QQ/);
  assert.deepEqual(delivered, [{ replyToken: 'tok-utf8', text: '你好🚀世界' }]);

  // Check JSON-RPC errors
  assert.equal((responses[4] as { error: { code: number } }).error.code, -32700);
  assert.equal((responses[5] as { error: { code: number } }).error.code, -32600);
  assert.equal((responses[6] as { error: { code: number } }).error.code, -32601);
  assert.equal((responses[7] as { error: { code: number } }).error.code, -32602);

  const boomRes = responses[8] as { result: { isError?: boolean; content: Array<{ text: string }> } };
  assert.equal(boomRes.result.isError, true);
  assert.match(boomRes.result.content[0]?.text ?? '', /unexpected transport crash/);

  // Diagnostics went to stderr only
  assert.match(stderrText, /\[antigravity-qqbot-mcp\]/);

  // Unsupported protocol version falls back to DEFAULT_PROTOCOL_VERSION
  const fallbackInit = (await server.handleMessage({
    jsonrpc: '2.0',
    id: 99,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })) as { result: { protocolVersion: string } };
  assert.equal(fallbackInit.result.protocolVersion, DEFAULT_PROTOCOL_VERSION);
});

test('postCallbackReply handles 200, 404, 500, ECONNREFUSED, and timeouts against real HTTP server', async (t) => {
  let mode: 'ok' | '404' | '500' | 'slow' | 'bad-json' = 'ok';
  const requests: CallbackReplyRequest[] = [];

  const httpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (mode === 'slow') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
        }, 300);
        return;
      }
      if (mode === 'bad-json') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not-json');
        return;
      }
      if (mode === '404') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unknown or expired replyToken' }));
        return;
      }
      if (mode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'QQ socket down' }));
        return;
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as CallbackReplyRequest);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chunksSent: 3, deliveredAt: 1_700_000_000_123 }));
    });
  });

  await new Promise<void>((resolveListen) => {
    httpServer.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(async () => {
    await new Promise<void>((resolveClose) => {
      httpServer.close(() => resolveClose());
      httpServer.closeAllConnections?.();
    });
  });

  const { port } = httpServer.address() as AddressInfo;

  // 200
  const okRes = await postCallbackReply(
    { replyToken: 'tok-1', text: 'hello' },
    { callbackHost: '127.0.0.1', callbackPort: port },
  );
  assert.equal(okRes.ok, true);
  assert.equal(okRes.chunksSent, 3);
  assert.equal(requests.length, 1);
  const okTool = formatQqbotReplyToolResult(okRes);
  assert.equal(okTool.isError, undefined);
  assert.match(okTool.content[0]?.text ?? '', /chunksSent=3/);

  // 404
  mode = '404';
  const res404 = await postCallbackReply(
    { replyToken: 'expired', text: 'hello' },
    { callbackHost: '127.0.0.1', callbackPort: port },
  );
  assert.equal(res404.ok, false);
  assert.equal(res404.statusCode, 404);
  const tool404 = formatQqbotReplyToolResult(res404);
  assert.equal(tool404.isError, true);
  assert.match(tool404.content[0]?.text ?? '', /replyToken/);

  // 500
  mode = '500';
  const res500 = await postCallbackReply(
    { replyToken: 'tok-1', text: 'hello' },
    { callbackHost: '127.0.0.1', callbackPort: port },
  );
  assert.equal(res500.ok, false);
  assert.equal(res500.statusCode, 500);
  assert.equal(formatQqbotReplyToolResult(res500).isError, true);

  // bad-json
  mode = 'bad-json';
  const resBad = await postCallbackReply(
    { replyToken: 'tok-1', text: 'hello' },
    { callbackHost: '127.0.0.1', callbackPort: port },
  );
  assert.equal(resBad.ok, false);
  assert.match(resBad.error ?? '', /invalid response/);

  // timeout
  mode = 'slow';
  const resTimeout = await postCallbackReply(
    { replyToken: 'tok-1', text: 'hello' },
    { callbackHost: '127.0.0.1', callbackPort: port, timeoutMs: 50 },
  );
  assert.equal(resTimeout.ok, false);
  assert.match(resTimeout.error ?? '', /Timed out/);

  // ECONNREFUSED on closed port
  const closedServer = createServer();
  await new Promise<void>((resolveListen) => closedServer.listen(0, '127.0.0.1', resolveListen));
  const closedPort = (closedServer.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => closedServer.close(() => resolveClose()));

  const resRefused = await postCallbackReply(
    { replyToken: 'tok-1', text: 'hello' },
    { callbackHost: '127.0.0.1', callbackPort: closedPort },
  );
  assert.equal(resRefused.ok, false);
  assert.match(resRefused.error ?? '', /Failed to reach/);
  assert.equal(formatQqbotReplyToolResult(resRefused).isError, true);
});

test('node src/mcp/cli.ts executes real stdio MCP round-trip and --help exits 0 with pure stdout', async (t) => {
  const cliPath = resolve(import.meta.dirname, '..', 'src', 'mcp', 'cli.ts');

  // 1. --help keeps stdout clean and exits 0
  const helpResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveProc) => {
      const child = spawn(process.execPath, [cliPath, '--help'], {
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
  assert.equal(helpResult.code, 0);
  assert.equal(helpResult.stdout, '');
  assert.match(helpResult.stderr, /Usage: node src\/mcp\/cli\.ts/);

  // 2. Real stdio round-trip against live local HTTP server
  const receivedCallbacks: CallbackReplyRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CallbackReplyRequest;
      receivedCallbacks.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chunksSent: 1, deliveredAt: 12345 }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections?.();
    });
  });
  const port = (server.address() as AddressInfo).port;

  const proc = spawn(
    process.execPath,
    [cliPath, '--host', '127.0.0.1', '--port', String(port)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
  });
  proc.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });

  const exitPromise = new Promise<number | null>((resolveExit) => {
    proc.once('close', (code) => resolveExit(code));
  });

  proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    })}\n`,
  );
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'qqbot_reply',
        arguments: { replyToken: 'cli-tok-9', text: 'Real CLI reply' },
      },
    })}\n`,
  );
  proc.stdin.end();

  const exitCode = await exitPromise;
  assert.equal(exitCode, 0, `stderr was: ${stderrBuf}`);

  const jsonLines = stdoutBuf
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  assert.equal(jsonLines.length, 3);
  assert.equal(jsonLines[0]?.id, 1);
  assert.equal(jsonLines[1]?.id, 2);
  assert.equal(jsonLines[2]?.id, 3);
  assert.deepEqual(receivedCallbacks, [{ replyToken: 'cli-tok-9', text: 'Real CLI reply' }]);
});
