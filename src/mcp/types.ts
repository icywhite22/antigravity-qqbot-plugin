import type { AppLogger, CallbackReplyRequest, CallbackReplyResponse } from '../shared/types.ts';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: readonly string[];
    additionalProperties?: boolean;
  };
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: Record<string, never>;
  };
  serverInfo: McpServerInfo;
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface PostCallbackReplyOptions {
  callbackHost?: string;
  callbackPort?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface CallbackReplyResult extends CallbackReplyResponse {
  statusCode?: number;
  endpoint: string;
  guidance?: string;
}

export type DeliverReplyFn = (
  request: CallbackReplyRequest,
) => Promise<CallbackReplyResponse | McpToolCallResult | void> | CallbackReplyResponse | McpToolCallResult | void;

export interface CreateMcpServerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  deliverReply?: DeliverReplyFn;
  callback?: PostCallbackReplyOptions;
  serverInfo?: McpServerInfo;
  protocolVersion?: string;
  logger?: AppLogger;
  debug?: boolean;
}

export interface McpServer {
  start(): void;
  stop(): Promise<void>;
  handleMessage(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
  isStarted(): boolean;
  isInitialized(): boolean;
}
