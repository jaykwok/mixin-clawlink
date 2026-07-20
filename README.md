# Mixin ClawLink

**量子密信智能助理连接器** — 把量子密信私聊消息交给本机 Agent（Claude Code / Antigravity CLI）执行，再将文本与文件结果返回量子密信。自带 **OpenTUI 运维面板**：首次运行走设置向导，之后直接进面板（实时日志 / 会话浏览 / WS·鉴权状态 / 模型切换 / 软重启）。

## 接口来源与声明

Mixin ClawLink 是量子密信智能助理的**非官方 OpenClaw 连接器兼容实现**。项目使用的鉴权、WebSocket 消息和文件收发等接口，来自对量子密信智能助理 **OpenClaw 连接器插件**运行行为及网络通信协议的逆向分析与兼容性整理，并非量子密信官方公开 SDK 或正式 API 文档。

本项目不隶属于量子密信或 OpenClaw，相关产品名称仅用于说明兼容对象。上游接口可能随时调整，请仅在已获授权的账号、系统和网络环境中研究或使用，并自行遵守适用的服务条款、法律法规与数据安全要求。

## 环境要求

- **Bun ≥ 1.3**（OpenTUI 渲染器需要 Bun 或 Node 26.4+ FFI；本项目按 Bun 运行）
- 量子密信智能助理的 `appId` / `appSecret`（客户端 → 通讯录 → 智能助理 → 详情页 apikey）
- **Agent 由你自备**（二选一）：
  - **Claude Code**：本程序不写入 `ANTHROPIC_*`；会优先读进程环境，并自动从 `~/.claude/settings.json` 的 `env` 读取 base-url/key/token（`AGENT=claude` 时）。会优先使用 `CLAUDE_CLI_PATH`，未配置时自动寻找本机 `claude.exe` / `cli.js`。
  - **Antigravity CLI (agy)**：需本机已安装 agy ≥ 1.1.4（1.1.4 起 headless `--print` 才遵守 settings.json 权限策略；未配置 `AGY_CLI_PATH` 时自动从 PATH 查找）。

## 安装与运行

### 方式一：Releases 发行包（推荐普通用户）

1. 从 [Releases](../../releases) 页面下载对应平台的压缩包（Windows / macOS / Linux）。
2. 解压到任意目录。
3. 运行其中的可执行文件（Windows 为 `MixinClawLink.exe`，macOS/Linux 为 `mixin-clawlink`）。
4. 首次运行自动进入设置向导（见下方「首次运行」）。

> 发行包已内置 Bun 运行时和全部依赖，无需额外安装。

### 方式二：源码运行（推荐开发者）

```bash
git clone <仓库地址>
cd mixin-clawlink
bun install        # 装 @anthropic-ai/claude-agent-sdk + ws + dotenv + OpenTUI(+solid-js)
bun start          # 无 .env 时自动进设置向导
```

- `bun run typecheck` — `tsc --noEmit` 类型检查（不产出文件）
- 源码部署只需仓库内容；目标机执行 `bun install --production && bun start`，首次运行会自动进入设置向导。
- 本机配置、会话数据、日志、工作区与构建产物均由 `.gitignore` 排除。

## 首次运行（设置向导）

首次启动时（无 `.env` 或缺凭据），程序自动进入 **TUI 设置向导**，引导你完成全部配置。无需手动创建 `.env` 文件——向导是唯一配置入口。

### 向导操作流程

1. **字段列表（左侧）**：用 `↑` / `↓` 或 `1-9` 选择要编辑的配置字段，`PgUp` / `PgDn` 翻页。
2. **进入编辑（右侧）**：选中字段后按 `Enter`，焦点跳到右侧编辑区。
   - **文本字段**（如 APP_ID、WORKSPACE）：原值已选中，直接输入会替换原内容；`Ctrl+V` 粘贴剪贴板内容。
   - **选项字段**（如 ENV、AGENT）：用 `↑` / `↓` 切换候选项。
3. **保存编辑**：按 `Enter` 保存当前字段并返回字段列表。
4. **放弃编辑**：按 `Esc` 放弃当前未保存的输入，返回字段列表。
5. **完成配置**：全部填好后按 `Ctrl+S` 保存并启动 bot。

### 必填字段

| 字段 | 说明 |
|---|---|
| **APP_ID** | 密信智能助理 apikey（客户端 → 通讯录 → 智能助理 → 详情页） |
| **APP_SECRET** | 密信智能助理密钥 |
| **WORKSPACE** | 工作目录（见下方说明） |

### 工作目录（WORKSPACE）

工作目录是 **Agent 读写文件的根目录**——Agent 在此目录下创建、编辑、查找文件，用户发送的附件也落盘到此目录的 `inbox/` 子文件夹。工作目录路径支持以下写法：

- **绝对路径**：`D:/projects/my-app`（Windows）、`/home/user/projects`（Linux/macOS）
- **相对路径**：`./workspace`（相对于程序所在目录）
- **家目录展开**：`~/projects`（`~` 自动展开为用户家目录）
- **路径分隔符**：Windows 下反斜杠 `\` 和正斜杠 `/` 均可，会自动规范化

> 如果按 `Ctrl+S` 时工作目录为空，会弹出提示：按 `Enter` 使用默认值 `./workspace`，或按 `Esc` 返回手动填写。

### 再次运行

凭据就绪后直接进运维面板。从「操作 → 编辑配置」可重新修改 `.env`，`Ctrl+S` 保存返回，`Esc` 放弃当前输入并返回。会话页/控制中心也可按 `Esc` 返回日志页。

面板用 `Tab` / `Shift+Tab` 或 `←` / `→` 循环切换视图；数字 `1–9` 直接执行当前页对应项目，列表超过 9 项时用 `PgUp` / `PgDn` 翻页。

`Ctrl+C` 优雅退出；运行期崩溃 5 秒自动重建。TUI 挂在重启循环之外，`/reboot` 只重建 bot，面板不闪退。

## 目录结构

```
src/
├── bootstrap.ts        # 统一应用根目录，固定配置、日志和数据的落盘位置
├── assets/icons/       # 透明 PNG 源图与 Windows ICO 应用图标
├── index.ts            # 主程序：挂 TUI（循环外）→ 首启向导门 → 软重启重建循环 + SIGINT
├── bot.ts              # 编排：WS onRaw→斜杠命令/dispatch；每用户锁；审批；/stop；只读状态访问器
├── config.ts           # .env + reload() + EDITABLE + /config setValue + writeEnvRaw + isDangerous
├── logger.ts           # 控制台 + 按大小轮转文件（无依赖）；sink/suppressConsole 供 TUI 接管
├── mime.ts             # ext→mime（无内建 mimetypes）
├── im/
│   ├── auth.ts         # OAuth client_credentials + token 缓存/401 失效 + getStatus
│   ├── transport.ts    # ws 握手头 + waitingForPong 心跳 + 三阶段退避重连 + status/onStatus
│   └── messages.ts     # 收消息(HMAC/去重) + 发消息(文本/分片上传/下载)
├── agents/
│   ├── base.ts         # Agent 接口（reply 带 resume/askPermission/abortController）
│   ├── echo.ts         # 回声（测通道）
│   ├── claude.ts       # Claude Agent SDK：query + resume + canUseTool 危险审批 + 多模态
│   ├── claude-settings.ts # 动态读取进程 env / ~/.claude/settings.json
│   ├── claude-cli.ts   # Claude CLI 路径查找
│   ├── models.ts       # 从 Anthropic/OpenAI 风格端点拉模型列表，供 /model 与面板用
│   ├── agy.ts          # Antigravity CLI 适配器（headless 子进程 --print 模式）
│   ├── agy-cli.ts      # agy 路径查找 + 会话 ID 解析 + 版本探测
│   └── index.ts        # 工厂（claude / antigravity 惰性 import）
├── session/
│   ├── workspace.ts    # 每用户工作目录（默认固定根 + /cwd 切换）
│   └── registry.ts     # 会话注册表：编号↔sessionId 映射 + listUsers
└── tui/
    ├── index.tsx       # OpenTUI 运维面板 + 首启向导（@opentui/solid，SolidJS 信号驱动）
    └── navigation.ts   # 视图切换 / 分页 / 编号选择工具函数
```

运行时产物（gitignore）：`workspace/`（默认 cwd）、`data/`（会话注册表）、`logs/`、`node_modules/`、`.env`。
根目录另有 `bunfig.toml`（Solid preload）与 `tsconfig.json`（`jsx: preserve` + `jsxImportSource`，仅为 `.tsx` 类型检查；Bun 运行时不需要）。

## Agent 类型

| AGENT 值 | 说明 | 会话续接 | 对话历史浏览 |
|---|---|---|---|
| `echo` | 回声测试（验证通道连通） | 无 | 无 |
| `claude` | Claude Code SDK（推荐） | SDK 原生 `resume` | 支持（面板会话页） |
| `antigravity` | Antigravity CLI headless 模式 | `--conversation <uuid>` | 不支持（无 SDK） |

### 走 router 用第三方模型

在 Claude Code 的 `~/.claude/settings.json`（或进程环境）里配置 `ANTHROPIC_BASE_URL` 与 key/token，再用 IM 的 `/model` 或面板「选择模型」按编号挑。模型拉取同时支持 Anthropic `/v1/models` 和 OpenAI `/models`；DeepSeek 的 `/anthropic` base 会自动转到根路径 `/models`。

## 自定义 Agent

实现 `Agent.reply(uid, text, workspace, attachments, opts)` 接口（见 `agents/base.ts`），在 `agents/index.ts` 注册即可。
- 附件已落盘到 `<工作目录>/inbox/`，路径在 `attachments` 里。
- 用 `[[FILE: 绝对路径]]` 标记声明要回传的文件（约定见 `cfg.FILE_RETURN_INSTRUCTION`），bot 解析后上传发送。
- `opts.sessionId` 是当前会话的 session_id（可 resume 续上下文）；`opts.askPermission` 是危险操作审批回调；`opts.abortController` 用于 `/stop`。

## 对话历史（多会话）

- 每个会话槽位存一个 session_id（`data/conversations/<userId>/index.json`）。
- **Claude**：SDK 原生 `resume`，首轮 `query()` 后从结果抓 `session_id` 存盘，`/use` 切换后作为 `options.resume` 传回，恢复全量上下文。
- **Antigravity**：`--conversation <uuid>` 续接，会话按 cwd 隔离，优先读 `~/.gemini/antigravity-cli/cache/last_conversations.json` 精确查。
- `/new` 新开槽、`/list` 列编号、`/use N` 切、`/reset` 当前槽换新 session、`/del N` 删。
- 限制：Claude session 按 `cwd` 存盘，`/cwd` 切换后旧槽可能无法 resume。

## IM 命令（直接在密信里发）

以 `/` 开头被拦截，**不转给 agent**：

| 命令 | 作用 |
|---|---|
| `/new` | 新开一个会话并切到它 |
| `/list` | 列出所有会话（带编号，标当前） |
| `/use <编号>` | 切到指定会话 |
| `/reset` | 清空当前会话（下次开新 session） |
| `/del <编号>` | 删除会话，可多个：`/del 1` 或 `/del 1,3` |
| `/config` | 查看/修改配置：`/config` 或 `/config <编号\|名称> <值>` |
| `/model` | 选模型：`/model` 拉网关列表带编号、`/model <编号\|名称>` 切、`/model default` 清空回默认 |
| `/reboot` | 软重启（重读 `.env`、重建 agent/WS） |
| `/stop` | 停止当前正在执行的任务 |
| `/cwd` | 查看/切换工作目录 |
| `/send` | 手动发送一个文件：`/send <路径>` |
| `/status` | 查看 agent / 工作目录 / 当前会话 |
| `/help` | 命令列表 |

## 配置热改 & 危险审批 & 软重启

**`/config`**（除 `MIXIN_APP_ID/SECRET` 外都能改，写回 `.env`）：
```
/config                       列出全部（编号+当前值；[重启] 需 /reboot）
/config CLAUDE_MODEL deepseek-chat   用名字改
/config 4                     看单项
```
即时生效：`SYSTEM_PROMPT`/`CLAUDE_MODEL`/`CLAUDE_ALLOWED_TOOLS`/`CLAUDE_PERMISSION`/`FILE_RETURN_INSTRUCTION`/`MAX_FILE_MB`/`CLAUDE_DANGER_*`/`AGY_*`。需 `/reboot`：`AGENT`/`WORKSPACE`。

`CLAUDE_PERMISSION` 默认使用 `auto`：Agent 自行判断，必要时申请权限；`CLAUDE_DANGER_CONFIRM=1` 时，命中危险模式的 Bash 仍会强制在量子密信中确认。

`AGY_PERMISSION` 控制 agy 的工具权限：`bypass`（默认）= `--dangerously-skip-permissions` 全自动放行；`settings` = 不传该 flag，改由 agy 的 `settings.json`（`toolPermission`/`sandbox`/`trustedWorkspaces`）控制，更精细安全（需 agy ≥ 1.1.4，1.1.4 起 headless `--print` 才读 settings.json 策略）。

**`/reboot`** 软重启：进程内拆重建（停 WS → 重读 `.env` → 新建 Bot），几秒重连，不用碰服务器。

**危险操作审批**（`MIXIN_CLAUDE_DANGER_CONFIRM=1` 默认开）：agent 跑命中危险模式（`rm`/`del`/`format`/`git reset --hard`/`DROP`…）的 Bash 前，在聊天框问你 y/n（120s 不回默认拒绝）；其余全自动。模式可自定义：`MIXIN_CLAUDE_DANGER_PATTERNS=\brm\b||\bdel\b`（`||` 分隔的正则）。

**消息格式**：agent 回复统一以 `markdown` 类型发送（表格/代码块/列表才会渲染）。

## 文件回传

工作目录可能很大，**不扫描全目录**。两种方式：
1. **agent 声明**（默认）：回复末尾用标记声明，每行一个：`[[FILE: D:/work/报告.pptx]]`。bot 解析后上传，正文去掉标记。
2. **手动**：`/send D:/work/报告.pptx`。

单文件上限 30MB（密信平台限制，`MIXIN_MAX_FILE_MB` 可改）；超限或缺文件用消息提示。

## 备注 / 已知限制

- **量子加密**未实现（需专有 `libqss.wasm`）。当前只收发明文——这是未订购量子加密用户的默认能力。
- WS 握手要带自定义头（裸 token + `X-App-ID`），标准 `WebSocket` 客户端不支持自定义头，故用 `ws` 包；心跳 ping/pong 手动实现。
- 走 router 时第三方模型若不支持视觉，图片识别无效（图片仍会作为 image block 注入，失败回退到 Read）。
- **Antigravity CLI** 无 SDK，走 `--print` headless 子进程模式；无法在面板浏览对话历史；危险审批对 agy 无效（`--print` 一次性跑完，无 canUseTool 回调）。
