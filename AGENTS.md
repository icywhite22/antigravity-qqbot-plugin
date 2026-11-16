# antigravity-qqbot 项目协作规范

本项目旨在将 QQ 官方机器人接入 Google Antigravity（参考 `tencent-connect/dsh-qqbot` 的 QQ 接入与避坑工程层，将其 `dsh`/Cordis 宿主层替换为 Antigravity 的 Sidecar + `agentapi` + MCP 桥接层）。

## 一、模块划分与蜂群（Swarm）分工边界

若在本项目开启 Swarm 模式并行开发，必须按以下目录边界拆分职责，**禁止多个 Worker 同时修改同一文件**：

| 目录 / 文件 | 职责说明 | 建议归属角色 |
| --- | --- | --- |
| `src/shared/` | 跨模块共享类型与配置读取（稳定契约，变更前需协调） | Coordinator / 架构收敛后冻结 |
| `src/qq/` | QQ 扫码绑定、WebSocket 网关、被动回复 `msgId` 限流与超限降级、长文本分片 | `qq-gateway` worker |
| `src/bridge/` | QQ Peer ↔ Antigravity 会话映射、`agentapi` 进程调用、本地回调服务 | `agy-bridge` worker |
| `src/mcp/` | 暴露给 Antigravity Agent 的本地 MCP Server（`qqbot_reply` 等工具） | `mcp-server` worker |
| `plugin/` | Antigravity 插件清单、`mcp_config.json`、`rules/`、`skills/`、`sidecars/` | Coordinator 或单独 `plugin-pack` worker |
| `scripts/` | 独立最小验证脚本（如 QQ 扫码与回显验证） | 单次验证任务使用 |
| `tests/` | 单元测试与契约验证（只做独立核查，修改业务代码交回对应模块作者） | `verifier` worker |

## 二、技术与环境约束（已验证）

1. **Windows 下的 `agentapi` 调用约定**：
   - 当系统用户目录包含非 ASCII 字符（如中文用户名）时，直接调用 `agentapi.bat` 可能出现路径解析失败。
   - 必须优先通过环境变量 `ANTIGRAVITY_AGENTAPI_EXE` 直接执行 `language_server.exe agentapi <subcommand>`（封装见 `src/bridge/index.ts` 中的 `resolveAgentApiCommand()`）。
2. **Node.js 原生 TypeScript 兼容规范**：
   - 本项目基于 Node.js 20.3+（本机已验证 Node v24.19.0 原生支持直接运行 `.ts` 与 `node --test`）。
   - 为保证无需编译即可直接运行测试与脚本：类型导入一律使用 `import type`，避免使用 `enum` 与构造函数参数属性（parameter properties）等非可擦除语法。
3. **Antigravity 插件清单约束**：
   - `plugin/plugin.json` 仅允许使用官方受支持的顶层字段（`name`、`displayName`、`description`、`version`、`author`、`homepage`、`repository`、`logo`、`suggestedPrompts`、`disabled`），不要写入未知字段。
   - 开发未完成前 `plugin/plugin.json` 保持 `"disabled": true`。
4. **安全与凭据保护**：
   - `QQBOT_APPID`、`QQBOT_SECRET` 等凭据严禁硬编码或提交到 Git；统一通过 `.env`（已被 `.gitignore` 忽略）或本地运行时数据目录读取。
