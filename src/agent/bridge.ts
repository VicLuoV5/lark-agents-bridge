import { ensureLarkCliShim, type LarkCliShim } from '../runtime/lark-cli-shim';
import { prependPathSegment, withWindowsNpmGlobalBin } from '../runtime/path-env';
import { workspaceRoot } from '../workspace/guard';

/**
 * Shared per-run prompt preamble injected ahead of every user message.
 * Agent-agnostic on purpose — this is the bridge's contract with whatever
 * CLI it spawns. Adapter-specific additions belong in the adapter.
 */
const BRIDGE_PROMPT = `# lark-agents-bridge 运行约定

你正在 lark-agents-bridge（原名 feishu-codex-bridge）里运行：飞书/Lark 用户消息会被桥接到本地的 agent CLI。

## bridge_context
每条 user message 顶部可能带一个 <bridge_context> 块，包含 chat_id、chat_type、sender_id、sender_name、thread_id。
这些是 bridge 注入的元数据，不要照抄到回复里；只在需要判断上下文、私聊/群聊、回调对象时使用。

## quoted_message
如果用户引用回复某条消息，bridge 会注入 <quoted_message> 块。用户真正的问题在它之后；回答时围绕被引用内容和后续问题展开。

## interactive_card
如果消息来自交互卡片，bridge 可能注入 <interactive_card> JSON。解析它来理解按钮、字段、布局，不要把 XML 标签原样回复给用户。

## 发交互卡片的回调约定
你想发一张可交互的卡片让用户点选时：

1. 用 lark-cli 把卡发到 bridge_context.chat_id。
2. 卡片用 CardKit 2.0 schema。
3. 如果希望用户点按钮后回调到你，同一按钮的 value 对象必须包含 "__bridge_cb": true。
4. 用户点击后，bridge 会把 payload 去掉 "__bridge_cb" 后作为 "[card-click] {...}" 消息发回给你；你的 session 会自动续上。
5. 只是展示卡片时，不要加 "__bridge_cb"。

示例按钮：
\`\`\`json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "方案 A" },
  "behaviors": [{
    "type": "callback",
    "value": { "__bridge_cb": true, "choice": "a" }
  }]
}
\`\`\`

## 飞书工具约定
如果你需要操作飞书文档、表格、日历、消息等，优先使用本机已经配置的 lark-cli，并遵守当前项目和全局 AGENTS 规则。
涉及授权登录时，只能在私聊里引导用户完成，不能把授权链接发到群里。

## 安全边界
默认只在工作根目录内操作文件。除非用户明确要求且权限机制允许，不要访问或修改根目录外的路径。
`;

export interface AgentRunEnv {
  /** Process env to spawn the agent CLI with (PATH / lark-cli shim applied). */
  env: NodeJS.ProcessEnv;
  /** Windows workspace-local lark-cli shim, when one was prepared. */
  larkCli: LarkCliShim | undefined;
}

/**
 * Prepare the shared spawn environment for any agent CLI: Windows
 * npm-global-bin fixup + the workspace-local lark-cli shim (so the agent
 * can call Feishu APIs from inside sandboxed tool runs).
 */
export function prepareAgentEnv(
  cwd: string = workspaceRoot(),
  larkCliProfile?: string,
): AgentRunEnv {
  const larkCli = ensureLarkCliShim(cwd);
  const env = withWindowsNpmGlobalBin({ ...process.env });
  if (larkCli) {
    env.Path = prependPathSegment(env.Path ?? env.PATH ?? env.path ?? '', larkCli.toolsDir);
    env.FEISHU_BRIDGE_LARK_CLI = larkCli.commandPath;
  }
  env.FEISHU_BRIDGE = '1';
  if (larkCliProfile) env.LARKSUITE_CLI_PROFILE = larkCliProfile;
  return { env, larkCli };
}

/** Compose the full prompt: shared bridge preamble + adapter notes + user text. */
export function buildBridgePrompt(
  userPrompt: string,
  opts: { larkCli?: LarkCliShim } = {},
): string {
  return `${BRIDGE_PROMPT}${larkCliPrompt(opts.larkCli)}\n\n${userPrompt}`;
}

function larkCliPrompt(larkCli: LarkCliShim | undefined): string {
  if (!larkCli) return '';
  return `

## lark-cli 可执行入口
bridge 已准备好一个工作区内的 lark-cli 入口，优先使用这个精确路径：

\`${larkCli.commandPath}\`

Windows 下 agent 沙箱里的 PATH / APPDATA 可能无法解析中文用户名路径。不要只因为 \`Get-Command lark-cli\` 或 \`where lark-cli\` 失败就判断 lark-cli 不可用；先尝试上面的工作区入口。`;
}
