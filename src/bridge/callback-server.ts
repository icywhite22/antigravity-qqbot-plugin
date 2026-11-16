import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type {
  AppLogger,
  CallbackHealthResponse,
  CallbackReplyRequest,
  CallbackReplyResponse,
  ReplyTarget,
} from '../shared/types.ts';
import type { ReplyTokenRegistry } from './reply-tokens.ts';

export const DEFAULT_CALLBACK_HOST = '127.0.0.1';
export const DEFAULT_CALLBACK_PORT = 39871;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface DeliverReplyParams {
  target: ReplyTarget;
  text: string;
  replyToken: string;
}

export interface DeliverReplyResult {
  chunksSent?: number;
  deliveredAt?: number;
}

export type DeliverReplyHandler = (
  params: DeliverReplyParams,
) => Promise<void | number | DeliverReplyResult> | void | number | DeliverReplyResult;

export interface CallbackServerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  replyTokens?: Pick<ReplyTokenRegistry, 'resolve'>;
  resolveReplyToken?: (replyToken: string) => ReplyTarget | undefined;
  onDeliverReply?: DeliverReplyHandler;
  now?: () => number;
  logger?: AppLogger;
}

export interface CallbackServerAddress {
  host: string;
  port: number;
}

class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body exceeds ${limitBytes} byte limit`);
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: CallbackHealthResponse | CallbackReplyResponse | { ok: false; error: string },
  extraHeaders?: Record<string, string>,
  onFinished?: () => void,
): void {
  if (res.writableEnded) {
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body, onFinished);
}

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

function readJsonBodyWithLimit(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const contentLengthHeader = req.headers['content-length'];
    if (typeof contentLengthHeader === 'string') {
      const parsedLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
        rejectPromise(new PayloadTooLargeError(maxBodyBytes));
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBodyBytes) {
        settled = true;
        cleanup();
        req.pause();
        rejectPromise(new PayloadTooLargeError(maxBodyBytes));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    const onAborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error('Request aborted by client'));
    };

    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function parseReplyPayload(rawBody: string): CallbackReplyRequest | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { error: 'Invalid JSON request body' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Request body must be a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const replyToken = typeof record.replyToken === 'string' ? record.replyToken.trim() : '';
  if (!replyToken) {
    return { error: 'Missing or invalid replyToken' };
  }

  if (typeof record.text !== 'string' || !record.text.trim()) {
    return { error: 'Missing or empty text' };
  }

  return {
    replyToken,
    text: record.text,
  };
}

/**
 * 本地 HTTP 回调服务，严格绑定在回环/配置地址上接收来自 MCP Server 的 `qqbot_reply` 投递。
 */
export class CallbackServer {
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly maxBodyBytes: number;
  private readonly resolveTokenFn: (replyToken: string) => ReplyTarget | undefined;
  private readonly onDeliverReply: DeliverReplyHandler | undefined;
  private readonly now: () => number;
  private readonly logger: AppLogger | undefined;

  private server: Server | null;
  private boundPort: number | null;
  private startedAt: number | null;
  private startPromise: Promise<void> | null;
  private stopPromise: Promise<void> | null;

  constructor(options: CallbackServerOptions = {}) {
    this.host = options.host?.trim() || DEFAULT_CALLBACK_HOST;

    const port = options.port !== undefined ? options.port : DEFAULT_CALLBACK_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid callback port: ${String(port)}`);
    }
    this.configuredPort = port;

    this.maxBodyBytes =
      typeof options.maxBodyBytes === 'number' &&
      Number.isFinite(options.maxBodyBytes) &&
      options.maxBodyBytes > 0
        ? options.maxBodyBytes
        : DEFAULT_MAX_BODY_BYTES;

    if (options.resolveReplyToken) {
      this.resolveTokenFn = options.resolveReplyToken;
    } else if (options.replyTokens) {
      const registry = options.replyTokens;
      this.resolveTokenFn = (token: string) => registry.resolve(token);
    } else {
      this.resolveTokenFn = () => undefined;
    }

    this.onDeliverReply = options.onDeliverReply;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;

    this.server = null;
    this.boundPort = null;
    this.startedAt = null;
    this.startPromise = null;
    this.stopPromise = null;
  }

  isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  getAddress(): CallbackServerAddress {
    return {
      host: this.host,
      port: this.boundPort ?? this.configuredPort,
    };
  }

  getUrl(): string {
    const addr = this.getAddress();
    return `http://${formatHostForUrl(addr.host)}:${addr.port}`;
  }

  async start(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.isListening()) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    const runStart = async (): Promise<void> => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const onStartupError = (err: Error): void => {
            server.removeListener('listening', onListening);
            rejectListen(err);
          };
          const onListening = (): void => {
            server.removeListener('error', onStartupError);
            server.on('error', (runtimeErr: Error) => {
              this.logger?.error(`[bridge:callback] HTTP server error: ${runtimeErr.message}`);
            });
            resolveListen();
          };
          server.once('error', onStartupError);
          server.once('listening', onListening);
          server.listen(this.configuredPort, this.host);
        });

        const rawAddr = server.address();
        const actualPort =
          rawAddr && typeof rawAddr === 'object' ? rawAddr.port : this.configuredPort;
        this.server = server;
        this.boundPort = actualPort;
        this.startedAt = this.now();
        this.logger?.info(`[bridge:callback] listening on ${this.getUrl()}`);
      } catch (err) {
        try {
          server.close();
        } catch {
          // ignore cleanup error
        }
        this.server = null;
        this.boundPort = null;
        this.startedAt = null;
        throw err;
      }
    };

    this.startPromise = runStart().finally(() => {
      this.startPromise = null;
    });

    await this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // 启动失败时继续清理
      }
    }
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    const activeServer = this.server;
    if (!activeServer) {
      return;
    }

    const runStop = async (): Promise<void> => {
      await new Promise<void>((resolveClose, rejectClose) => {
        activeServer.close((err?: Error) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            rejectClose(err);
            return;
          }
          resolveClose();
        });
        activeServer.closeIdleConnections?.();
        activeServer.closeAllConnections?.();
      });

      this.server = null;
      this.boundPort = null;
      this.startedAt = null;
      this.logger?.info('[bridge:callback] stopped');
    };

    this.stopPromise = runStop().finally(() => {
      this.stopPromise = null;
    });

    await this.stopPromise;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname = '/';
    try {
      const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      pathname = parsedUrl.pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid request URL' });
      return;
    }

    if (pathname === '/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET' });
        return;
      }
      const uptimeMs = this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt);
      const healthBody: CallbackHealthResponse = { ok: true, uptimeMs };
      sendJson(res, 200, healthBody);
      return;
    }

    if (pathname === '/reply') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' });
        return;
      }
      await this.handleReplyRequest(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  private async handleReplyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rawBody: string;
    try {
      rawBody = await readJsonBodyWithLimit(req, this.maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(
          res,
          413,
          { ok: false, error: err.message },
          { Connection: 'close' },
          () => {
            req.destroy();
          },
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: message });
      return;
    }

    const parsed = parseReplyPayload(rawBody);
    if ('error' in parsed) {
      sendJson(res, 400, { ok: false, error: parsed.error });
      return;
    }

    const target = this.resolveTokenFn(parsed.replyToken);
    if (!target) {
      sendJson(res, 404, { ok: false, error: 'Unknown or expired replyToken' });
      return;
    }

    if (!this.onDeliverReply) {
      sendJson(res, 500, { ok: false, error: 'No reply delivery handler configured' });
      return;
    }

    try {
      const outcome = await this.onDeliverReply({
        target,
        text: parsed.text,
        replyToken: parsed.replyToken,
      });

      let chunksSent = 1;
      let deliveredAt = this.now();
      if (typeof outcome === 'number' && Number.isFinite(outcome)) {
        chunksSent = outcome;
      } else if (outcome && typeof outcome === 'object') {
        if (typeof outcome.chunksSent === 'number' && Number.isFinite(outcome.chunksSent)) {
          chunksSent = outcome.chunksSent;
        }
        if (typeof outcome.deliveredAt === 'number' && Number.isFinite(outcome.deliveredAt)) {
          deliveredAt = outcome.deliveredAt;
        }
      }

      const replyBody: CallbackReplyResponse = {
        ok: true,
        deliveredAt,
        chunksSent,
      };
      sendJson(res, 200, replyBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`[bridge:callback] reply delivery failed: ${message}`);
      sendJson(res, 500, { ok: false, error: message });
    }
  }
}
