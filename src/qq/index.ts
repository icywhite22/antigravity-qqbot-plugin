export {
  getFallbackCredentialsPath,
  getPrimaryCredentialsPath,
  loadCachedQqCredentials,
  resolveQqCredentials,
  saveQqCredentials,
} from './credentials.ts';
export type {
  QqCredentialSource,
  QrConnectStarter,
  ResolveQqCredentialsOptions,
  ResolvedQqCredentials,
  SavedQqCredentials,
} from './credentials.ts';

export {
  C2C_MSG_ID_TTL_MS,
  DEFAULT_MAX_MSG_IDS_PER_TARGET,
  GROUP_MSG_ID_TTL_MS,
  MsgIdCache,
} from './msg-id-cache.ts';
export type {
  CachedMsgIdEntry,
  MsgIdCacheOptions,
  MsgIdRefInput,
} from './msg-id-cache.ts';

export {
  DEFAULT_MAX_TRACKED_MESSAGES,
  DEFAULT_PASSIVE_REPLY_LIMIT,
  DEFAULT_REPLY_LIMIT_TTL_MS,
  ReplyLimiter,
} from './reply-limiter.ts';
export type {
  ReplyLimitFallbackReason,
  ReplyLimitResult,
  ReplyLimiterConfig,
} from './reply-limiter.ts';

export { DEFAULT_TEXT_CHUNK_LIMIT, chunkMarkdownText, chunkText } from './text-chunk.ts';

export { buildQqUserAgent, createQqGateway, mapInboundMessage } from './gateway.ts';
export type {
  CreateQqGatewayOptions,
  InboundHandler,
  QqBotClient,
  QqGateway,
} from './gateway.ts';

/**
 * QQ 接入层模块能力说明（供基础契约与诊断检查使用）。
 */
export function describeQqGatewayPlan(): {
  packages: readonly string[];
  responsibilities: readonly string[];
} {
  return {
    packages: ['@tencent-connect/qqbot-connector', '@tencent-connect/qqbot-nodejs'],
    responsibilities: [
      'QR code credential binding and local persistence',
      'WebSocket gateway connection and reconnect handling',
      'Passive reply msgId caching, rate limit fallback, and text chunking',
    ],
  };
}
