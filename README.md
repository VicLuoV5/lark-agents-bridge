# lark-agents-bridge

A local Feishu / Lark bot that forwards chat messages to your local coding agent CLI — Codex, Claude Code, Qwen Code, Kimi Code, CodeBuddy, or DeepSeek Harness, switchable from the chat itself. It is designed for people who already run an agent on their own machine and want to drive it from Feishu or Lark chats.

[中文 README](./README.zh.md)

This project was adapted from the architecture of `zarazhangrui/feishu-claude-code-bridge`, with the agent layer generalized into pluggable adapters and the local state directory renamed to `~/.feishu-codex-bridge` (kept for continuity).

## Status

This is an open-source alpha extracted from a personal deployment. It is useful for personal or small-team use, but you should review the security model and access-control settings before inviting it into large groups.

The bridge itself needs no API keys: every agent runs through its own login or credentials, set up with that agent's own tooling before the bridge starts.

## Features

- Send Feishu / Lark messages to a local agent CLI (Codex by default; Claude Code, Qwen Code, Kimi Code, CodeBuddy, and DeepSeek Harness also supported).
- Keep separate agent sessions per chat or topic.
- Stream replies as lightweight markdown cards or send one final text reply.
- Use `/new [name]` to create a new group chat and inherit the current workspace.
- Use `/reset` to clear the current chat session.
- Switch and save workspaces with `/cd` and `/ws`.
- Download images and files from chat and pass their local paths to the agent.
- Configure access control, reply mode, concurrency, run idle timeout, and agent reasoning effort from `/config`.
- Run in the foreground or as an OS-managed background process.

## Agents

The bridge spawns a local agent CLI; `preferences.agent.type` in `config.json` (or the first-run wizard) picks which:

| Agent | Invocation | Model access |
|---|---|---|
| `codex` (default) | `codex exec --json` | Your Codex login. |
| `claude` | `claude -p --output-format stream-json` | Your Claude Code login, or an Anthropic-compatible provider endpoint (DeepSeek, 智谱 GLM, Kimi, Qwen 百炼, 火山方舟/豆包, MiniMax) selected via `/config`. |
| `qwen` | `qwen -p --output-format stream-json` | Your Qwen Code login. Session resume needs `general.chatRecording=true` in qwen settings. |
| `kimi` | `kimi -p --output-format stream-json` | Your Kimi Code login (Windows needs Git for Windows). Non-interactive runs use the CLI's `auto` permission; messages arrive whole (no token deltas). |
| `codebuddy` | `codebuddy -p --output-format stream-json` | Your CodeBuddy OAuth login (or `CODEBUDDY_API_KEY`). |
| `dsh` | `dsh --profile acp` (persistent ACP subprocess) | dsh's own credentials (set up dsh first, as its docs require). Developer preview — expect breaking changes. |

Every adapter injects the same bridge conventions and the local `lark-cli` shim, so each agent can operate Feishu (messages, docs, interactive cards) exactly like Codex. Provider API keys are stored in the encrypted local keystore (`secrets.enc`), never in `config.json` or logs. Provider endpoints/models move quickly — treat the built-in profiles as defaults and override the model id via `/config` when a vendor renames things. The Kimi adapter is based on an undocumented output schema; if a Kimi Code release changes its stream format, the adapter may need a matching update.

The `dsh` adapter runs DeepSeek Harness as one long-lived ACP subprocess shared by all chats (sessions survive process restarts via `session/resume`), auto-installs its `acp` profile on first use, and enforces the `/config` file-permission vocabulary through its approval callbacks. Notes: replies arrive per message (no token streaming), and dsh's Windows sandbox is only partially enforced — treat it as experimental. Version pairing matters: the `acp` profile plugin must match the launcher generation, so install the launcher from the `next` channel (`npm i -g @deepseek-ai/dsh@next`); mismatched versions fail at profile load.

## Requirements

- Node.js 20 or newer.
- A working local Codex CLI login. Run `codex login` in your normal terminal first.
- A Feishu / Lark PersonalAgent app.
- Network access to OpenAI/Codex and Feishu/Lark open platform endpoints.

The first run can guide you through app registration by QR code. `lark-cli` is optional but recommended; the bridge uses it so Codex can call Feishu/Lark APIs from local tool runs.

On Windows, Codex sandbox commands may not reliably resolve global npm paths when the user profile path contains non-ASCII characters or spaces. The bridge creates a workspace-local `.feishu-codex-bridge-tools/` runtime shim and keeps it synchronized from the globally installed `@larksuite/cli` version and binary metadata.

## Install

From npm:

```bash
npm i -g lark-agents-bridge
lark-agents-bridge --version
```

From source:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
node bin/lark-agents-bridge.mjs --help
```

## First Run

Run the bridge in the foreground:

```bash
lark-agents-bridge run
```

Or from a source checkout:

```bash
node bin/lark-agents-bridge.mjs run
```

On first run the bridge creates `~/.feishu-codex-bridge/config.json`. If no app credentials are present, it starts the QR-code registration wizard. Fresh App Secrets are moved into the encrypted local keystore at `~/.feishu-codex-bridge/secrets.enc`.

After the terminal says it is listening, DM the bot:

```text
/status
Reply exactly OK
```

## Feishu / Lark App Settings

Confirm these in the open-platform console. Missing scopes or events are the most common reason the bridge connects but the bot stays silent.

Required permission scopes:

- `im:message`
- `im:message:send_as_bot`
- `im:resource`
- `im:chat`, required by `/new`
- `drive:drive`, required for cloud-doc comment handling

Required event subscriptions in long-connection mode:

- `im.message.receive_v1`
- `card.action.trigger`
- `drive.notice.comment_add_v1`, required for cloud-doc comments

Optional event subscriptions:

- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`
- `im.chat.member.bot.added_v1`

## Host CLI

Foreground process commands:

```bash
lark-agents-bridge run [-c <config>]
lark-agents-bridge ps
lark-agents-bridge kill <id|#>
```

Background service commands:

```bash
lark-agents-bridge start
lark-agents-bridge stop
lark-agents-bridge restart
lark-agents-bridge status
lark-agents-bridge unregister
```

Service backends:

- macOS: user `launchd` agent with `KeepAlive`.
- Linux: user `systemd` unit with `Restart=always`.
- Windows: Task Scheduler task plus a `.cmd` launcher that restarts crashed bridge runs after 60 seconds. A clean exit is not restarted.

Do not start two bridge processes for the same Feishu/Lark app. Open-platform long-connection events may be delivered to either process at random.

## Slash Commands

| Command | Effect |
|---|---|
| `/new [name]` | Create a new group chat, start a fresh session, inherit current cwd, invite sender |
| `/reset` | Clear the current chat session |
| `/resume [N]` | List recent Codex sessions for the current cwd |
| `/cd <path>` | Switch cwd within `FEISHU_CODEX_WORKSPACE_ROOT` and reset session |
| `/ws list/save/use/remove` | Manage named workspaces |
| `/status` | Show current scope, cwd, session, agent, and reasoning setting |
| `/config` | Configure reply mode, tool display, concurrency, timeout, reasoning effort, and access control |
| `/timeout [N\|off\|default]` | Override idle timeout for the current session |
| `/stop` | Stop the current Codex run |
| `/ps` | List bridge processes on this host |
| `/exit <id\|#>` | Stop one bridge process |
| `/reconnect` | Force a Feishu/Lark WebSocket reconnect |
| `/doctor [description]` | Ask Codex to diagnose recent bridge logs |
| `/account` | View or rotate app credentials |
| `/help` | Show the help card |

In DMs, the bot responds to normal messages. In groups and topic groups, the default is to respond only when the bot is mentioned.

## Configuration

Local state lives outside the repository:

| Path | Purpose |
|---|---|
| `~/.feishu-codex-bridge/config.json` | App config and preferences |
| `~/.feishu-codex-bridge/secrets.enc` | Encrypted App Secret store |
| `~/.feishu-codex-bridge/sessions.json` | Chat/topic to Codex session mapping |
| `~/.feishu-codex-bridge/workspaces.json` | Named workspaces |
| `~/.feishu-codex-bridge/processes.json` | Live process registry |
| `~/.feishu-codex-bridge/media/<chatId>/` | Downloaded attachment cache |
| `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` | Structured JSONL logs |
| `<workspace-root>/.feishu-codex-bridge-tools/` | Windows runtime `lark-cli` shim for Codex; auto-synced from global `@larksuite/cli`, do not edit or commit |

Important environment variables:

| Variable | Meaning |
|---|---|
| `CODEX_HOME` | Codex config directory. If unset, Codex CLI uses its own default. |
| `CODEX_BIN` | Custom Codex executable path. |
| `FEISHU_CODEX_WORKSPACE_ROOT` | Maximum filesystem root the bot may use for `/cd` and default cwd. Defaults to the process cwd. |
| `FEISHU_CODEX_BRIDGE_PROXY` | Optional proxy used by the Windows helper script. |
| `HTTP_PROXY` / `HTTPS_PROXY` | Optional network proxy inherited by Node and Codex child processes. |

## Security Notes

- Never commit App Secret, OpenAI/Codex login state, cookies, or `~/.feishu-codex-bridge`.
- Restrict `FEISHU_CODEX_WORKSPACE_ROOT` to the smallest directory tree the bot should access.
- Set `/config` admins before inviting the bot into shared groups.
- In groups, keep "require mention" enabled unless you deliberately want all group messages sent to Codex.
- `/doctor` sanitizes logs before sending them to Codex, but logs may still contain operational metadata. Use it in trusted chats.

## Development

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

The GitHub Actions workflow runs the same typecheck, test, and build checks on pull requests.

## License

[MIT](./LICENSE)
