# 开发与架构指南

本文档面向参与 `antigravity-qqbot-plugin` 二次开发与维护的贡献者。关于 Swarm 多 Agent 模块边界与语言/清单硬约束，请同时阅读 [AGENTS.md](./AGENTS.md)。

## 架构概览

```text
手机 QQ
  │  (WebSocket / REST)
  ▼
QQ 接入层 (src/qq/)
  │  InboundMessage (含 botId / scope / peerId / replyTarget)
  ▼
Antigravity 桥接层 (src/bridge/) ──▶ 创建隔离目录 + 调用 agentapi
  ▲                                        │
  │  HTTP POST /reply (127.0.0.1:39871)    ▼
本地 MCP Server (src/mcp/cli.ts) ◀── Antigravity 对话调用 qqbot_reply
```

1. **共享契约（`src/shared/`）**：`types.ts` 定义纯跨模块类型，`config.ts` 负责 `.env` / `.env.local` 与环境变量解析。
2. **QQ 接入层（`src/qq/`）**：
   - `credentials.ts`：按环境变量 → `<dataDir>/credentials.json` → `.qqbot-data/credentials.json` → `startQrConnect` 扫码的顺序解析并原子保存凭据。
   - `msg-id-cache.ts` & `reply-limiter.ts`：维护私聊 30 分钟 / 群聊 5 分钟被动回复窗口与次数限流，超限或过期时降级为复用缓存或主动消息。
   - `text-chunk.ts`：保留代码块围栏与 GFM 表格完整性的文本分片器。
   - `gateway.ts`：基于 `@tencent-connect/qqbot-nodejs` 封装 `createQqGateway()`。
3. **Antigravity 桥接层（`src/bridge/`）**：
   - `workspace.ts`：安全清洗标识符并生成 `<workspaceRoot>/bot-<appId>/<c2c|group>-<peerId>/` 隔离目录。
   - `session-store.ts`：将 `botId:scope:peerId -> conversationId` 原子持久化到 `<dataDir>/sessions.json`。
   - `agentapi-client.ts`：通过 `ANTIGRAVITY_AGENTAPI_EXE`（优先于 Windows `agentapi.bat`）调用 `new-conversation` / `send-message`，隔离工作目录为当前会话目录。
   - `reply-tokens.ts` & `callback-server.ts`：管理带 TTL 的 `replyToken` 与本地回环 HTTP 回调服务。
4. **本地 MCP Server（`src/mcp/`）**：
   - 零外部依赖的 stdio JSON-RPC 2.0 服务端（日志仅输出到 `stderr`），向 Antigravity Agent 暴露 `qqbot_reply(replyToken, text)`。
5. **插件包模板与安装器（`plugin/` & `scripts/`）**：
   - `plugin/` 保持占位路径与 `"disabled": true`，不硬编码本机路径或凭据。
   - `scripts/install-plugin.ts` 在部署到 `~/.gemini/config/plugins/antigravity-qqbot` 时注入本机 `node` 绝对路径、仓库路径、`.env` 的 `QQBOT_WORKSPACE_DIR` 及 Sidecar `agent_permissions.workspace_uris`。

## 目录结构

```text
antigravity-qqbot-plugin/
├── AGENTS.md                       # 协作规范与环境技术约束
├── CONTRIBUTING.md                 # 本文档：内部架构与开发指南
├── LICENSE
├── README.md                       # 面向使用者的说明文档
├── package.json
├── tsconfig.json
├── .env.example
├── plugin/                         # Antigravity 插件包模板
│   ├── plugin.json
│   ├── mcp_config.json
│   ├── rules/AGENTS.md
│   ├── skills/qqbot-reply/SKILL.md
│   └── sidecars/qqbot-gateway/sidecar.json
├── src/
│   ├── shared/
│   ├── qq/
│   ├── bridge/
│   ├── mcp/
│   └── gateway-entry.ts
├── scripts/
│   ├── verify-qq-echo.ts           # QQ 扫码与回显最小验证脚本
│   └── install-plugin.ts           # 部署本机插件脚本
└── tests/                          # node --test 单元与集成测试
```

## 开发与校验命令

```bash
# 类型检查（含 Node v24 原生 TS 可擦除语法校验）
npm run typecheck
npx tsc --noEmit --erasableSyntaxOnly

# 运行全部单元与集成测试
npm test

# 构建检查
npm run build
```

## 提交前开源安全检查

- 确认 `.env`、`.env.local`、`.qqbot-data/` 未进入版本跟踪（已由 `.gitignore` 忽略）。
- 确认 `plugin/` 中未写入本机绝对路径，且 `plugin/plugin.json` 保持 `"disabled": true`。
- 确认提交历史与测试样例中不包含真实 `AppID`、`AppSecret`、用户 `OpenID` 或本地用户名路径。
