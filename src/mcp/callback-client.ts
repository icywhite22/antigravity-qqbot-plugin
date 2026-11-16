import { loadRuntimeConfig } from '../shared/config.ts';
import type { CallbackReplyRequest, CallbackReplyResponse } from '../shared/types.ts';
import type { CallbackReplyResult, McpToolCallResult, PostCallbackReplyOptions } from './types.ts';

export const DEFAULT_CALLBACK_TIMEOUT_MS = 15_000;

interface ResolvedCallbackEndpoint {
  host: string;
  port: number;
  url: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) {
    return `[${host}]`;
  }
  return host;
}

/**
 * 解析本地 QQ 桥接回调服务地址（优先读取显式参数，回退到 loadRuntimeConfig()）。
 */
export function resolveCallbackEndpoint(
  options: PostCallbackReplyOptions = {},
): ResolvedCallbackEndpoint {
  const config = loadRuntimeConfig(options.env);
  const host = options.callbackHost !== undefined ? options.callbackHost.trim() : config.callbackHost;
  if (!host) {
    throw new Error('Callback host must be a non-empty hostname or IP address.');
  }

  let port = config.callbackPort;
  if (options.callbackPort !== undefined) {
    if (
      !Number.isInteger(options.callbackPort) ||
      options.callbackPort <= 0 ||
      options.callbackPort > 65535
    ) {
      throw new Error(`Invalid callbackPort: ${String(options.callbackPort)} (expected 1-65535).`);
    }
    port = options.callbackPort;
  }

  return {
    host,
    port,
    url: `http://${formatHostForUrl(host)}:${port}/reply`,
  };
}

function extractErrorDetails(err: unknown): {
  summary: string;
  isTimeout: boolean;
  isNetworkError: boolean;
} {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let isTimeout = false;
  let isNetworkError = false;

  const visit = (node: unknown): void => {
    if (node === null || node === undefined || seen.has(node)) {
      return;
    }
    seen.add(node);

    if (node instanceof Error) {
      if (node.name === 'TimeoutError' || node.name === 'AbortError') {
        isTimeout = true;
      }
      const record = node as unknown as Record<string, unknown>;
      const code = typeof record.code === 'string' ? record.code : undefined;
      if (
        code &&
        (code === 'ECONNREFUSED' ||
          code === 'ECONNRESET' ||
          code === 'ENOTFOUND' ||
          code === 'EHOSTUNREACH' ||
          code === 'ENETUNREACH' ||
          code === 'ETIMEDOUT' ||
          code === 'UND_ERR_CONNECT_TIMEOUT')
      ) {
        isNetworkError = true;
      }
      const label = code && !node.message.includes(code) ? `${node.message} (${code})` : node.message;
      if (label && !parts.includes(label)) {
        parts.push(label);
      }
      if ('cause' in record && record.cause !== undefined) {
        visit(record.cause);
      }
      if (Array.isArray(record.errors)) {
        for (const inner of record.errors) {
          visit(inner);
        }
      }
      return;
    }

    const text = String(node);
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
  };

  visit(err);
  if (!isTimeout && parts.some((part) => /timed out|timeout|aborted/i.test(part))) {
    isTimeout = true;
  }
  if (!isTimeout && parts.length > 0 && !isNetworkError) {
    isNetworkError = true;
  }

  return {
    summary: parts.join(': ') || 'Unknown network error',
    isTimeout,
    isNetworkError,
  };
}

function buildActionableGuidance(params: {
  statusCode?: number;
  message: string;
  endpoint?: string;
  isTimeout?: boolean;
  isNetworkError?: boolean;
}): string {
  const endpointHint = params.endpoint ?? 'the local bridge callback URL';

  if (params.isTimeout) {
    return `The callback server at ${endpointHint} did not respond before the timeout elapsed. Verify that the antigravity-qqbot bridge/gateway sidecar is running and responsive, then retry.`;
  }

  if (params.isNetworkError) {
    return `Could not connect to ${endpointHint}. Ensure the antigravity-qqbot gateway/bridge sidecar is running and that QQBOT_CALLBACK_HOST / QQBOT_CALLBACK_PORT match the active bridge.`;
  }

  if (params.statusCode === 404 || /token|expired|invalid|not found/i.test(params.message)) {
    return 'Verify that you copied the exact replyToken from the [QQ c2c message] or [QQ group message] prompt header. If the token expired, wait for a newer QQ message instead of guessing a token.';
  }

  if (params.statusCode === 400) {
    return 'Ensure both replyToken and text are non-empty strings and within the bridge request size limit.';
  }

  if (params.statusCode !== undefined && params.statusCode >= 500) {
    return 'Check the antigravity-qqbot gateway/bridge sidecar logs for QQ WebSocket connectivity, rate-limit, or credential errors.';
  }

  return `Verify the antigravity-qqbot bridge callback server at ${endpointHint} is healthy (GET /health) and check the replyToken before retrying.`;
}

function parseCallbackResponseBody(rawBody: string): {
  parsed?: CallbackReplyResponse;
  parseError?: string;
} {
  if (!rawBody.trim()) {
    return { parseError: 'empty response body' };
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBody);
  } catch (err) {
    return {
      parseError: `invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!isPlainRecord(rawJson) || typeof rawJson.ok !== 'boolean') {
    return { parseError: 'response JSON is missing boolean "ok" field' };
  }

  return {
    parsed: {
      ok: rawJson.ok,
      ...(typeof rawJson.error === 'string' && rawJson.error ? { error: rawJson.error } : {}),
      ...(typeof rawJson.chunksSent === 'number' ? { chunksSent: rawJson.chunksSent } : {}),
      ...(typeof rawJson.deliveredAt === 'number' ? { deliveredAt: rawJson.deliveredAt } : {}),
    },
  };
}

/**
 * 向本地 Antigravity 桥接回调服务发送 QQ 回复请求。
 */
export async function postCallbackReply(
  request: CallbackReplyRequest,
  options: PostCallbackReplyOptions = {},
): Promise<CallbackReplyResult> {
  let endpoint: ResolvedCallbackEndpoint;
  try {
    endpoint = resolveCallbackEndpoint(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      endpoint: 'http://invalid-callback-endpoint/reply',
      error: message,
      guidance: 'Check QQBOT_CALLBACK_HOST and QQBOT_CALLBACK_PORT configuration.',
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      ok: false,
      endpoint: endpoint.url,
      error: `Invalid callback timeoutMs: ${String(timeoutMs)} (expected a positive number).`,
      guidance: 'Provide a positive timeoutMs value in milliseconds.',
    };
  }

  const replyToken = typeof request.replyToken === 'string' ? request.replyToken.trim() : '';
  const text = typeof request.text === 'string' ? request.text : '';
  if (!replyToken || !text.trim()) {
    return {
      ok: false,
      endpoint: endpoint.url,
      error: 'Both replyToken and non-empty text are required to deliver a QQ reply.',
      guidance: buildActionableGuidance({
        statusCode: 400,
        message: 'missing replyToken or text',
        endpoint: endpoint.url,
      }),
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      endpoint: endpoint.url,
      error: 'Global fetch API is unavailable in this Node.js runtime.',
      guidance: 'Run with Node.js 20.3+ or inject fetchImpl in options.',
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Callback request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const payload: CallbackReplyRequest = {
    replyToken,
    text,
  };

  let response: Response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const details = extractErrorDetails(err);
    const isTimeout = timedOut || details.isTimeout;
    const error = isTimeout
      ? `Timed out after ${timeoutMs}ms waiting for QQ bridge callback server at ${endpoint.url}.`
      : `Failed to reach QQ bridge callback server at ${endpoint.url}: ${details.summary}.`;
    return {
      ok: false,
      endpoint: endpoint.url,
      error,
      guidance: buildActionableGuidance({
        message: error,
        endpoint: endpoint.url,
        isTimeout,
        isNetworkError: !isTimeout && details.isNetworkError,
      }),
    };
  }

  let rawBody = '';
  try {
    rawBody = await response.text();
  } catch (err) {
    const details = extractErrorDetails(err);
    const isTimeout = timedOut || details.isTimeout;
    const error = isTimeout
      ? `Timed out after ${timeoutMs}ms reading response from QQ bridge callback server at ${endpoint.url}.`
      : `Failed reading response from QQ bridge callback server at ${endpoint.url} (HTTP ${response.status}): ${details.summary}.`;
    return {
      ok: false,
      statusCode: response.status,
      endpoint: endpoint.url,
      error,
      guidance: buildActionableGuidance({
        statusCode: response.status,
        message: error,
        endpoint: endpoint.url,
        isTimeout,
        isNetworkError: !isTimeout,
      }),
    };
  } finally {
    clearTimeout(timer);
  }

  const { parsed, parseError } = parseCallbackResponseBody(rawBody);
  if (!parsed) {
    const snippet = rawBody.trim().slice(0, 200);
    const detail = snippet ? `${parseError}: ${snippet}` : parseError ?? 'unparseable response';
    const error = `QQ bridge callback server at ${endpoint.url} returned an invalid response (HTTP ${response.status}): ${detail}.`;
    return {
      ok: false,
      statusCode: response.status,
      endpoint: endpoint.url,
      error,
      guidance: buildActionableGuidance({
        statusCode: response.status,
        message: error,
        endpoint: endpoint.url,
      }),
    };
  }

  if (!response.ok || !parsed.ok) {
    const serverMessage = parsed.error ?? `HTTP ${response.status} ${response.statusText || 'Error'}`.trim();
    const prefix =
      response.status === 404
        ? `QQ bridge rejected replyToken (HTTP 404)`
        : response.status >= 500
          ? `QQ bridge failed to deliver reply (HTTP ${response.status})`
          : `QQ bridge callback error (HTTP ${response.status})`;
    const error = `${prefix}: ${serverMessage}`;
    return {
      ok: false,
      statusCode: response.status,
      endpoint: endpoint.url,
      error,
      guidance: buildActionableGuidance({
        statusCode: response.status,
        message: serverMessage,
        endpoint: endpoint.url,
      }),
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    endpoint: endpoint.url,
    ...(parsed.chunksSent !== undefined ? { chunksSent: parsed.chunksSent } : {}),
    ...(parsed.deliveredAt !== undefined ? { deliveredAt: parsed.deliveredAt } : {}),
  };
}

/**
 * 将本地回调响应转换为标准 MCP tools/call 结果（失败时设置 isError: true 并附带可操作提示）。
 */
export function formatQqbotReplyToolResult(
  response: CallbackReplyResponse | CallbackReplyResult,
): McpToolCallResult {
  if (response.ok) {
    const details: string[] = [];
    if (typeof response.chunksSent === 'number') {
      details.push(`chunksSent=${response.chunksSent}`);
    }
    if (typeof response.deliveredAt === 'number') {
      details.push(`deliveredAt=${new Date(response.deliveredAt).toISOString()}`);
    }
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    return {
      content: [
        {
          type: 'text',
          text: `Reply delivered to QQ${suffix}.`,
        },
      ],
    };
  }

  const errorText = response.error?.trim() || 'Failed to deliver reply to QQ via local bridge.';
  const resultRecord = response as Partial<CallbackReplyResult>;
  const guidance =
    typeof resultRecord.guidance === 'string' && resultRecord.guidance.trim()
      ? resultRecord.guidance.trim()
      : buildActionableGuidance({
          statusCode: resultRecord.statusCode,
          message: errorText,
          endpoint: resultRecord.endpoint,
          isTimeout: /timed out|timeout/i.test(errorText),
          isNetworkError: /ECONNREFUSED|unreachable|Failed to reach|connect/i.test(errorText),
        });

  return {
    content: [
      {
        type: 'text',
        text: `${errorText}\nAction: ${guidance}`,
      },
    ],
    isError: true,
  };
}
