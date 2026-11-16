import { QQBOT_REPLY_TOOL_DEFINITION } from './server.ts';

export interface McpToolSpec {
  name: string;
  description: string;
  requiredParams: readonly string[];
}

/**
 * 规划暴露给 Antigravity Agent 的 QQ 回传工具清单。
 */
export function getPlannedMcpTools(): readonly McpToolSpec[] {
  return [
    {
      name: QQBOT_REPLY_TOOL_DEFINITION.name,
      description: QQBOT_REPLY_TOOL_DEFINITION.description,
      requiredParams: QQBOT_REPLY_TOOL_DEFINITION.inputSchema.required,
    },
  ];
}

export {
  DEFAULT_CALLBACK_TIMEOUT_MS,
  formatQqbotReplyToolResult,
  postCallbackReply,
  resolveCallbackEndpoint,
} from './callback-client.ts';
export {
  createMcpServer,
  createStderrLogger,
  DEFAULT_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  QQBOT_REPLY_TOOL_DEFINITION,
  QQBOT_REPLY_TOOL_DESCRIPTION,
  QQBOT_REPLY_TOOL_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './server.ts';
export type {
  CallbackReplyResult,
  CreateMcpServerOptions,
  DeliverReplyFn,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  McpInitializeResult,
  McpServer,
  McpServerInfo,
  McpTextContent,
  McpToolCallResult,
  McpToolDefinition,
  McpToolsListResult,
  PostCallbackReplyOptions,
} from './types.ts';
