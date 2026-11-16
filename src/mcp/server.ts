import { StringDecoder } from 'node:string_decoder';
import type { AppLogger, CallbackReplyResponse } from '../shared/types.ts';
import { formatQqbotReplyToolResult, postCallbackReply } from './callback-client.ts';
import type {
  CreateMcpServerOptions,
  DeliverReplyFn,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  McpInitializeResult,
  McpServer,
  McpServerInfo,
  McpToolCallResult,
  McpToolDefinition,
  McpToolsListResult,
} from './types.ts';

export const MCP_SERVER_NAME = 'antigravity-qqbot';
export const MCP_SERVER_VERSION = '0.1.0';
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const QQBOT_REPLY_TOOL_NAME = 'qqbot_reply';
export const QQBOT_REPLY_TOOL_DESCRIPTION =
  'Send a text/markdown reply back to the active QQ chat via the local bridge callback.';

export const QQBOT_REPLY_TOOL_DEFINITION: McpToolDefinition = {
  name: QQBOT_REPLY_TOOL_NAME,
  description: QQBOT_REPLY_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      replyToken: {
        type: 'string',
        description:
          'The replyToken provided in the [QQ c2c message] or [QQ group message] prompt.',
      },
      text: {
        type: 'string',
        description: 'The reply text or markdown content to deliver back to the QQ chat.',
      },
    },
    required: ['replyToken', 'text'],
    additionalProperties: false,
  },
};

const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMcpToolCallResult(value: unknown): value is McpToolCallResult {
  return isPlainRecord(value) && Array.isArray(value.content);
}

function isStreamWritable(stream: NodeJS.WritableStream): boolean {
  const candidate = stream as NodeJS.WritableStream & {
    destroyed?: boolean;
    writableEnded?: boolean;
  };
  return !candidate.destroyed && !candidate.writableEnded;
}

function createSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function createErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

/**
 * 创建仅输出到 stderr 的诊断日志器，确保 stdio MCP 的 stdout 通道绝对纯净。
 */
export function createStderrLogger(
  debug = false,
  stderr: NodeJS.WritableStream = process.stderr,
): AppLogger {
  const writeLine = (level: string, msg: string): void => {
    try {
      if (isStreamWritable(stderr)) {
        stderr.write(`[antigravity-qqbot-mcp] [${level}] ${msg}\n`);
      }
    } catch {
      // 忽略日志流写入错误，避免影响 MCP 主协议流程
    }
  };

  return {
    info: (msg: string) => writeLine('INFO', msg),
    warn: (msg: string) => writeLine('WARN', msg),
    error: (msg: string) => writeLine('ERROR', msg),
    ...(debug ? { debug: (msg: string) => writeLine('DEBUG', msg) } : {}),
  };
}

/**
 * 创建零外部依赖的 JSON-RPC 2.0 stdio MCP Server。
 */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const logger = options.logger ?? createStderrLogger(Boolean(options.debug), stderr);
  const serverInfo: McpServerInfo = options.serverInfo ?? {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  };
  const deliverReply: DeliverReplyFn =
    options.deliverReply ?? ((request) => postCallbackReply(request, options.callback));

  let started = false;
  let closed = false;
  let initialized = false;
  let lineBuffer = '';
  let decoder = new StringDecoder('utf8');
  const inFlight = new Set<Promise<void>>();
  let queueTail: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | null = null;

  const negotiateProtocolVersion = (params: unknown): string => {
    if (options.protocolVersion) {
      return options.protocolVersion;
    }
    if (isPlainRecord(params) && typeof params.protocolVersion === 'string') {
      const requested = params.protocolVersion.trim();
      if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
        return requested;
      }
    }
    return DEFAULT_PROTOCOL_VERSION;
  };

  const handleToolsCall = async (id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> => {
    if (!isPlainRecord(params)) {
      return createErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params: expected an object with "name" and "arguments".',
      );
    }

    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!toolName) {
      return createErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params: "name" must be a non-empty string.',
      );
    }

    if (toolName !== QQBOT_REPLY_TOOL_NAME) {
      return createErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Unknown tool: ${toolName}`,
      );
    }

    if (!isPlainRecord(params.arguments)) {
      return createErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Invalid arguments for tool "${QQBOT_REPLY_TOOL_NAME}": expected an object with "replyToken" and "text".`,
      );
    }

    const rawReplyToken = params.arguments.replyToken;
    const rawText = params.arguments.text;
    const replyToken = typeof rawReplyToken === 'string' ? rawReplyToken.trim() : '';
    const text = typeof rawText === 'string' ? rawText : '';

    if (!replyToken) {
      return createErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Invalid arguments for tool "${QQBOT_REPLY_TOOL_NAME}": "replyToken" must be a non-empty string.`,
      );
    }

    if (!text.trim()) {
      return createErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Invalid arguments for tool "${QQBOT_REPLY_TOOL_NAME}": "text" must be a non-empty string.`,
      );
    }

    try {
      const outcome = await deliverReply({ replyToken, text });
      if (outcome === undefined) {
        return createSuccessResponse(id, formatQqbotReplyToolResult({ ok: true }));
      }
      if (isMcpToolCallResult(outcome)) {
        return createSuccessResponse(id, outcome);
      }
      return createSuccessResponse(id, formatQqbotReplyToolResult(outcome as CallbackReplyResponse));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`qqbot_reply delivery threw unexpectedly: ${detail}`);
      return createSuccessResponse(
        id,
        formatQqbotReplyToolResult({
          ok: false,
          error: `qqbot_reply delivery failed: ${detail}`,
        }),
      );
    }
  };

  const handleSingleMessage = async (raw: unknown): Promise<JsonRpcResponse | null> => {
    if (!isPlainRecord(raw)) {
      return createErrorResponse(
        null,
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        'Invalid Request: expected a JSON object.',
      );
    }

    const hasId = Object.prototype.hasOwnProperty.call(raw, 'id') && raw.id !== undefined;
    const isValidId =
      typeof raw.id === 'string' || (typeof raw.id === 'number' && Number.isFinite(raw.id));

    if (hasId && !isValidId) {
      return createErrorResponse(
        null,
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        'Invalid Request: "id" must be a string or finite number.',
      );
    }

    const id: JsonRpcId | null = hasId && isValidId ? (raw.id as JsonRpcId) : null;

    if (raw.jsonrpc !== '2.0' || typeof raw.method !== 'string' || raw.method.length === 0) {
      return createErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        'Invalid Request: expected jsonrpc="2.0" and non-empty string "method".',
      );
    }

    const method = raw.method;

    // JSON-RPC 2.0 notifications omit `id` and MUST NOT receive any response.
    if (!hasId) {
      if (method === 'notifications/initialized' || method === 'initialized') {
        initialized = true;
        logger.debug?.('Received notifications/initialized');
      } else {
        logger.debug?.(`Ignored notification: ${method}`);
      }
      return null;
    }

    const requestId = id as JsonRpcId;

    switch (method) {
      case 'initialize': {
        const result: McpInitializeResult = {
          protocolVersion: negotiateProtocolVersion(raw.params),
          capabilities: {
            tools: {},
          },
          serverInfo,
        };
        logger.debug?.(`Handled initialize (protocolVersion=${result.protocolVersion})`);
        return createSuccessResponse(requestId, result);
      }

      case 'ping':
        return createSuccessResponse(requestId, {});

      case 'tools/list': {
        const result: McpToolsListResult = {
          tools: [QQBOT_REPLY_TOOL_DEFINITION],
        };
        return createSuccessResponse(requestId, result);
      }

      case 'tools/call':
        return handleToolsCall(requestId, raw.params);

      default:
        return createErrorResponse(
          requestId,
          JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        );
    }
  };

  const handleMessage = async (
    message: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> => {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return createErrorResponse(
          null,
          JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          'Invalid Request: batch array must not be empty.',
        );
      }
      const results = await Promise.all(message.map((item) => handleSingleMessage(item)));
      const responses = results.filter((item): item is JsonRpcResponse => item !== null);
      return responses.length > 0 ? responses : null;
    }
    return handleSingleMessage(message);
  };

  const writeResponse = (payload: JsonRpcResponse | JsonRpcResponse[]): void => {
    if (closed || !isStreamWritable(stdout)) {
      return;
    }
    try {
      stdout.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      logger.error(
        `Failed to write JSON-RPC response to stdout: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const processLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse JSON-RPC line: ${detail}`);
      writeResponse(
        createErrorResponse(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, `Parse error: ${detail}`),
      );
      return;
    }

    try {
      const response = await handleMessage(parsed);
      if (response !== null) {
        writeResponse(response);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`Unhandled error handling JSON-RPC message: ${detail}`);
      const fallbackId =
        isPlainRecord(parsed) &&
        (typeof parsed.id === 'string' ||
          (typeof parsed.id === 'number' && Number.isFinite(parsed.id)))
          ? (parsed.id as JsonRpcId)
          : null;
      if (fallbackId !== null) {
        writeResponse(
          createErrorResponse(fallbackId, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, detail),
        );
      }
    }
  };

  const dispatchLine = (rawLine: string): void => {
    const task = queueTail
      .then(() => processLine(rawLine))
      .catch((err) => {
        logger.error(
          `Unexpected dispatch error: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        inFlight.delete(task);
      });
    queueTail = task;
    inFlight.add(task);
  };

  const onData = (chunk: Buffer | string): void => {
    const textChunk = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    lineBuffer += textChunk;

    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      dispatchLine(line);
      newlineIndex = lineBuffer.indexOf('\n');
    }
  };

  const onEnd = (): void => {
    lineBuffer += decoder.end();
    if (lineBuffer.trim()) {
      dispatchLine(lineBuffer);
    }
    lineBuffer = '';
  };

  const onStdinError = (err: Error): void => {
    logger.error(`stdin stream error: ${err.message}`);
  };

  const detachStdinListeners = (): void => {
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdin.off('error', onStdinError);
  };

  const start = (): void => {
    if (started) {
      return;
    }
    closed = false;
    started = true;
    stopPromise = null;
    queueTail = Promise.resolve();
    decoder = new StringDecoder('utf8');
    lineBuffer = '';
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onStdinError);
    if (typeof stdin.resume === 'function') {
      stdin.resume();
    }
    logger.debug?.('MCP stdio server started');
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = (async () => {
      detachStdinListeners();
      if (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      closed = true;
      started = false;
      logger.debug?.('MCP stdio server stopped');
    })();
    return stopPromise;
  };

  return {
    start,
    stop,
    handleMessage,
    isStarted: () => started,
    isInitialized: () => initialized,
  };
}
