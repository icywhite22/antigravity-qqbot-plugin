# antigravity-qqbot-plugin

将 QQ 官方机器人接入本地 **Google Antigravity** 的插件，让你直接在手机 QQ 私聊或群聊中驱动本地 Antigravity 完成对话与工作任务。

## 主要特性

- **开箱即用的绑定方式**：支持终端扫码直接绑定 QQ 机器人并本地缓存凭据，也支持通过 `.env` 配置 `QQBOT_APPID` / `QQBOT_SECRET`。
- **原生插件集成**：安装并启用后，由 Antigravity Sidecar 自动维持 QQ WebSocket 长连接，通过本地 MCP 工具（`qqbot_reply`）将回复准确回传到 QQ。
- **多机器人 & 多会话工作区隔离**：每个机器人、每个私聊用户与每个群聊都会自动分配独立的 Antigravity 会话与隔离目录，避免不同对话之间串台。
- **QQ 平台协议适配**：内置被动回复 `msgId` 缓存与限流降级（超限/过期自动转为主动推送）以及长文本/代码块/表格智能分段发送。

## 快速开始

### 1. 环境要求

- **Node.js** `>= 20.3.0`
- 已在本地安装并运行 **Google Antigravity**

### 2. 下载与安装依赖

```bash
git clone https://github.com/icywhite22/antigravity-qqbot-plugin.git
cd antigravity-qqbot-plugin
npm install
```

### 3. 绑定 QQ 机器人

运行最小验证脚本进行扫码绑定（如果你已有 `QQBOT_APPID` 和 `QQBOT_SECRET`，也可跳过此步直接填进 `.env`）：

```bash
npm run verify:qq
```

1. 终端会输出绑定二维码与备用链接，使用**手机 QQ** 扫码完成绑定（凭据会自动缓存到本地 `.qqbot-data/credentials.json`）。
2. 连上网关后给机器人发一条私聊消息，收到 `"收到: ..."` 回复说明 QQ 通路已正常，按 `Ctrl+C` 结束测试脚本即可（**记得关闭该测试进程**，避免之后与插件 Sidecar 同时连接同一机器人）。

### 4. 配置工作区并安装插件

1. 复制 `.env.example` 为 `.env`，设置你希望存放机器人会话文件的根路径 **`QQBOT_WORKSPACE_DIR`**（如果不设置，默认位于 `~/.antigravity-qqbot/workspace`）：

```dotenv
QQBOT_WORKSPACE_DIR=/path/to/your/qqbot-workspaces
```

2. 一键将插件安装到本机 Antigravity 全局插件目录：

```bash
npm run install:plugin
# 也可以直接通过参数覆盖工作区目录：
npm run install:plugin -- --workspace "/path/to/your/qqbot-workspaces"
```

> 以后如果修改了 `.env` 里的 `QQBOT_WORKSPACE_DIR`，重新执行一次 `npm run install:plugin` 并在 Antigravity 插件页重新开关一次插件即可生效。

3. 打开 Antigravity 插件管理页面，启用 **`antigravity-qqbot`**，即可直接在手机 QQ 给机器人发消息开始使用。

## 工作区目录结构

运行时插件会在 `QQBOT_WORKSPACE_DIR` 指定的目录下自动按「机器人 → 会话」两级创建隔离文件夹：

```text
<QQBOT_WORKSPACE_DIR>/
└── bot-<appId>/                  # 单个机器人的工作区
    ├── c2c-<userOpenId>/         # 私聊用户的专属隔离目录
    └── group-<groupOpenId>/      # 群聊的专属隔离目录
```

## 环境变量说明（`.env`）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `QQBOT_WORKSPACE_DIR` | `<QQBOT_DATA_DIR>/workspace` | **会话工作区根目录**。控制所有机器人及私聊/群聊隔离子目录的存放位置 |
| `QQBOT_APPID` / `QQBOT_SECRET` | 空 | QQ 机器人凭据；留空时自动读取本地扫码缓存 |
| `QQBOT_DATA_DIR` | `~/.antigravity-qqbot` | 会话映射（`sessions.json`）与凭据缓存目录 |
| `QQBOT_CALLBACK_HOST` / `QQBOT_CALLBACK_PORT` | `127.0.0.1` / `39871` | 本地桥接回调服务监听地址与端口 |
| `QQBOT_MARKDOWN_SUPPORT` | `false` | 机器人若拥有 QQ 官方 Markdown 消息权限可设为 `true` |
| `QQBOT_REQUIRE_MENTION` | `true` | 群聊中是否需要 `@机器人` 才触发回复 |
| `QQBOT_AGENT_MODEL` | 空 | 可选，指定新建会话时 `agentapi --model=...` 使用的模型 |
| `QQBOT_DEBUG` | `false` | 设为 `true` 或 `1` 输出详细调试日志 |

## 开发与贡献

如果你希望参与二次开发、了解内部模块拆分与测试方式，请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [AGENTS.md](./AGENTS.md)。

## 致谢与协议

- QQ 网关协议工程设计参考 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)
- 开源协议：[MIT](./LICENSE)
