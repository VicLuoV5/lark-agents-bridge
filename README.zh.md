# lark-agents-bridge

把飞书 / Lark 聊天消息转发给本机 coding agent CLI 的本地 bot——Codex、Claude Code、Qwen Code、Kimi Code、CodeBuddy、DeepSeek Harness，在聊天里随时切换。适合已经在本机跑着 agent，希望从飞书直接驱动它的个人或小团队。

[English README](./README.md)

本项目参考了 `zarazhangrui/feishu-claude-code-bridge` 的架构，agent 层泛化为可插拔适配器，本地状态目录沿用 `~/.feishu-codex-bridge`。

## 当前状态

这是从个人自用部署整理出的开源 alpha。个人使用和小团队使用已经比较顺手，但邀请进大群或长期无人值守前，请先检查安全边界和访问控制。

桥本身不需要任何 API key：每个 agent 用各自的登录态或凭据运行，按该 agent 官方方式提前配好即可，与桥无关。

## 功能

- 把飞书 / Lark 消息发送给本机 agent CLI（默认 Codex，也支持 Claude Code、Qwen Code、Kimi Code、CodeBuddy、DeepSeek Harness）。
- 每个 chat 或话题维护独立 agent session。
- 支持轻量流式 markdown 卡片，也支持跑完后一次性发文本。
- 将 agent 回复里常见的 LaTeX 公式转换为飞书 / Lark 可读的 Unicode 数学文本。
- `/new [name]` 创建新群、新会话，并继承当前工作目录。
- `/reset` 清空当前 chat 会话。
- `/cd` 和 `/ws` 切换、保存工作空间。
- 下载聊天里的图片和文件，把本地路径交给 agent。
- `/config` 配置访问控制、回复模式、并发、run 探活和 agent 推理强度。
- 支持前台运行，也支持 OS 托管后台运行。

## Agent 与模型供应商

bridge 会 spawn 一个本地 agent CLI，由 `config.json` 里的 `preferences.agent.type`（或首跑向导）选择：

| Agent | 调用方式 | 模型来源 |
|---|---|---|
| `codex`（默认） | `codex exec --json` | 你的 Codex 登录态。 |
| `claude` | `claude -p --output-format stream-json` | 你的 Claude Code 登录；或经 `/config` 指向 Anthropic 兼容端点（DeepSeek、智谱 GLM、Kimi、Qwen 百炼、火山方舟/豆包、MiniMax）。 |
| `qwen` | `qwen -p --output-format stream-json` | 你的 Qwen Code 登录。会话续接需要在 qwen 设置里开启 `general.chatRecording`。 |
| `kimi` | `kimi -p --output-format stream-json` | 你的 Kimi Code 登录（Windows 需要 Git for Windows）。非交互模式固定走 CLI 的 auto 权限；消息整条到达（无逐 token 流）。 |
| `codebuddy` | `codebuddy -p --output-format stream-json` | 你的 CodeBuddy 浏览器 OAuth 登录（或 `CODEBUDDY_API_KEY`）。 |
| `dsh` | `dsh --profile acp`（常驻 ACP 子进程） | dsh 自身的认证（先用 dsh 官方方式配好，与桥无关）。developer preview——可能有破坏性变更。 |

每个 adapter 都注入同一套 bridge 约定和本地 `lark-cli` shim，所以每个 agent 都能像 Codex 一样反过来操作飞书（消息、文档、交互卡片）。供应商 API Key 保存在本机加密 keystore（`secrets.enc`），不进 config.json、不进日志。各家端点和模型 id 迭代很快，内置 profile 只作默认值，供应商改名时用 `/config` 覆盖模型 id 即可。Kimi 的输出 schema 官方未成文，adapter 按容错方式实现，若 Kimi Code 改了流式格式需要同步调整。

`dsh` adapter 把 DeepSeek Harness 跑成一个所有聊天共享的常驻 ACP 子进程（进程重启后经 `session/resume` 恢复会话），首次使用时自动安装 acp profile，并按 `/config` 的文件权限档位控制审批回调。注意：回复按消息粒度到达（无逐 token 流），且 dsh 的 Windows 沙箱只有部分强制力——把它当实验性能力看待。版本要配对：acp 插件和 launcher 必须同一代，建议 launcher 直接装 next 通道（`npm i -g @deepseek-ai/dsh@next`），版本错配会在 profile 加载时报错。

## 多账号

同一个本机 agent 登录态要服务多个飞书 / Lark Bot 应用？每个应用在一次性录入后保存为档案，切换直接在聊天里完成；当前版本一次只运行一个 Bot，不会把同一应用启动为两个 bridge 进程：

- `/account add` → **扫码创建新应用**（推荐）：桥会把注册链接发到聊天里，用目标账号的飞书打开、登录、确认——应用自动创建并录入档案。也可选 **绑定已有应用**，填入它的 App ID 和 Secret。
- `/account` → 列出所有已存档案，下拉选择切换。切换时会先校验凭据并连接新 Bot，确认成功后才关闭旧 Bot；原卡片会明确显示“切换完成”或“切换失败”。目标档案已有管理员时，新 Bot 还会向管理员发送上线接管通知。

Secret 按应用分别保存在本机加密 keystore（`secrets.enc`）。管理员 open_id、聊天 session、工作空间和 agent 可调用的 `lark-cli` Profile 都按应用隔离。扫码录入会保存该应用的管理员；手动绑定的应用切换后会在旧 bot 的成功卡片显示一次性交接码，指定操作者必须私聊新 bot 发送 `/claim <交接码>` 才能取得管理员权限。如果新 Bot 无法连接，旧 Bot 会继续在线，并自动恢复切换前的落盘配置。

## 前置条件

- Node.js 20 或更新版本。
- 默认 agent 是 Codex：需要本机 Codex CLI 已登录（普通终端跑 `codex login`）。用其他 agent 时换成对应的登录/凭据。
- 一个飞书 / Lark PersonalAgent 应用。
- 能访问 OpenAI/Codex 以及飞书 / Lark 开放平台网络。

首次运行可以通过二维码向导创建或绑定应用。`lark-cli` 不是普通聊天的硬依赖，但建议安装；agent 需要操作飞书文档、消息、日历等 API 时会用到它。bridge 会为每个已激活 Bot 自动维护独立 Profile，并只把当前 Profile 传给 agent；不要把 `lark-cli config bind` 当作账号切换步骤。

Windows 上如果用户名包含中文或空格，Codex 沙箱可能无法稳定解析全局 npm 路径。bridge 会在工作区根目录生成 `.feishu-codex-bridge-tools/` 作为运行时 shim，并根据全局 `@larksuite/cli` 的版本和二进制元数据自动同步。

## 安装

从 npm 安装：

```bash
npm i -g lark-agents-bridge
lark-agents-bridge --version
```

从源码运行：

```bash
corepack enable
corepack pnpm install
corepack pnpm build
node bin/lark-agents-bridge.mjs --help
```

## 首次运行

前台启动：

```bash
lark-agents-bridge run
```

源码目录里也可以这样跑：

```bash
node bin/lark-agents-bridge.mjs run
```

首次运行会创建 `~/.feishu-codex-bridge/config.json`。如果没有应用凭据，会进入二维码注册向导。新的 App Secret 会立即迁移到本地加密 keystore：`~/.feishu-codex-bridge/secrets.enc`。

终端提示开始监听后，私聊 bot：

```text
/status
Reply exactly OK
```

## 飞书 / Lark 应用配置

请在开放平台后台确认权限和事件。bridge 连接成功但 bot 不回复，最常见原因就是这里缺配置。

必需权限：

- `im:message`
- `im:message:send_as_bot`
- `im:resource`
- `cardkit:card:write`，流式卡片回复需要
- `im:chat`，`/new` 创建群需要
- `drive:drive`，云文档评论处理需要

长连接事件订阅：

- `im.message.receive_v1`
- `card.action.trigger`
- `drive.notice.comment_add_v1`，云文档评论需要

可选事件：

- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`
- `im.chat.member.bot.added_v1`

## 宿主 CLI

前台进程命令：

```bash
lark-agents-bridge run [-c <config>]
lark-agents-bridge ps
lark-agents-bridge kill <id|#>
```

后台服务命令：

```bash
lark-agents-bridge start
lark-agents-bridge stop
lark-agents-bridge restart
lark-agents-bridge status
lark-agents-bridge unregister
```

服务后端：

- macOS：用户级 `launchd`，带 `KeepAlive`。
- Linux：用户级 `systemd`，带 `Restart=always`。
- Windows：Task Scheduler 任务，加 `.cmd` launcher；bridge 异常退出后 60 秒重启，正常退出不重启。

不要用同一个飞书 / Lark 应用启动多个 bridge。开放平台长连接事件可能随机投递给其中一个进程。

## 飞书斜杠命令

| 命令 | 作用 |
|---|---|
| `/new [name]` | 创建新群和新会话，继承当前 cwd，并邀请发送者 |
| `/reset` | 清空当前 chat 会话 |
| `/resume [N]` | 列出当前 agent 在当前 cwd 下最近的会话 |
| `/cd <path>` | 在 `FEISHU_CODEX_WORKSPACE_ROOT` 内切换 cwd，并重置 session |
| `/ws list/save/use/remove` | 管理命名工作空间 |
| `/status` | 查看 scope、cwd、session、agent 和 reasoning 设置 |
| `/config` | 配置回复方式、工具显示、并发、timeout、reasoning effort 和访问控制 |
| `/timeout [N\|off\|default]` | 覆盖当前 session 的 idle timeout |
| `/stop` | 停止当前 agent run |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止一个 bridge 进程 |
| `/reconnect` | 强制重连飞书 / Lark WebSocket |
| `/doctor [描述]` | 让当前 agent 根据近期 bridge 日志自助诊断 |
| `/account` | 管理 Bot 应用档案、录入或切换应用 |
| `/claim <交接码>` | 在新 bot 私聊中领取手动绑定应用的管理员权限 |
| `/help` | 帮助卡片 |

私聊里普通消息都会响应。群和话题群默认只有 @ bot 才响应。

## 本地配置

本地状态放在仓库外：

| 路径 | 用途 |
|---|---|
| `~/.feishu-codex-bridge/config.json` | 应用配置和偏好 |
| `~/.feishu-codex-bridge/secrets.enc` | 加密 App Secret |
| `~/.feishu-codex-bridge/sessions.json` | chat/topic 到 agent session 的映射（按 Bot 应用和 agent 隔离） |
| `~/.feishu-codex-bridge/workspaces.json` | 按 Bot 应用隔离的命名工作空间 |
| `~/.feishu-codex-bridge/processes.json` | 运行中进程注册表 |
| `~/.feishu-codex-bridge/media/<chatId>/` | 附件下载缓存 |
| `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` | JSONL 结构化日志 |
| `<workspace-root>/.feishu-codex-bridge-tools/` | Windows 下给 agent 使用的 `lark-cli` 运行时 shim；由全局 `@larksuite/cli` 自动同步，不要手工编辑或提交 |

重要环境变量：

| 变量 | 含义 |
|---|---|
| `CODEX_HOME` | Codex 配置目录。不设置时由 Codex CLI 使用自己的默认值。 |
| `CODEX_BIN` | 自定义 Codex 可执行文件路径。 |
| `FEISHU_CODEX_WORKSPACE_ROOT` | bot 允许 `/cd` 的最大文件系统根目录，默认是 bridge 进程 cwd。 |
| `FEISHU_CODEX_BRIDGE_PROXY` | Windows helper 脚本使用的可选代理。 |
| `HTTP_PROXY` / `HTTPS_PROXY` | Node 和 agent 子进程继承的可选网络代理。 |

## 安全提示

- 不要提交 App Secret、agent 登录态、cookie 或 `~/.feishu-codex-bridge`。
- 把 `FEISHU_CODEX_WORKSPACE_ROOT` 设成 bot 真正需要访问的最小目录。
- 邀请 bot 进共享群前，先在 `/config` 里设置管理员。
- 群聊默认要求 @ bot，除非明确需要，否则不要关闭。
- `/doctor` 会先清洗日志再交给当前 agent，但日志仍可能包含运行元数据；只在可信会话里使用。

## 开发

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

GitHub Actions 会在 pull request 上运行同样的 typecheck、test 和 build。

## 许可

[MIT](./LICENSE)
