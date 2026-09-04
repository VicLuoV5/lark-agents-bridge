import type { AgentPermissionMode } from '../config/schema';
import type { AgentAdapter } from './types';
import { CodexAdapter } from './codex/adapter';
import { ClaudeAdapter } from './claude/adapter';
import { QwenAdapter } from './qwen/adapter';
import { KimiAdapter } from './kimi/adapter';
import { CodeBuddyAdapter } from './codebuddy/adapter';
import { DshAdapter } from './dsh/adapter';

/** Runtime options an adapter may need from the active config. */
export interface AgentCreateOptions {
  /** Provider profile id (claude adapter). */
  provider?: string;
  /** Resolved provider API key plaintext (claude adapter). */
  apiKey?: string;
  /** Bridge permission vocabulary snapshot (dsh adapter approval policy). */
  permissionMode?: AgentPermissionMode;
}

interface AgentRegistration {
  displayName: string;
  /** One-line hint printed when the CLI can't be found on this machine. */
  installHint: string;
  create(opts?: AgentCreateOptions): AgentAdapter;
}

/**
 * Registry of spawnable agent CLIs. Adding a new agent = one entry here +
 * a `src/agent/<id>/` adapter implementing AgentAdapter. start.ts resolves
 * `preferences.agent.type` through this table.
 */
const REGISTRY: Record<string, AgentRegistration> = {
  codex: {
    displayName: 'Codex',
    installHint: '未找到 Codex CLI。请先安装并登录 Codex：\n  https://developers.openai.com/codex/cli',
    create: () => new CodexAdapter(),
  },
  claude: {
    displayName: 'Claude Code',
    installHint: '未找到 Claude Code CLI。请先安装并登录 Claude Code：\n  https://code.claude.com/docs/en/quickstart',
    create: (opts) => new ClaudeAdapter({ provider: opts?.provider, apiKey: opts?.apiKey }),
  },
  qwen: {
    displayName: 'Qwen Code',
    installHint: '未找到 Qwen Code CLI。请先安装并登录 Qwen Code：\n  npm i -g @qwen-code/qwen-code\n  会话续接需要在 qwen 设置里开启 general.chatRecording',
    create: () => new QwenAdapter(),
  },
  kimi: {
    displayName: 'Kimi Code',
    installHint: '未找到 Kimi Code CLI。请先安装并登录 Kimi Code（Windows 需 Git for Windows）：\n  npm i -g @moonshot-ai/kimi-code',
    create: () => new KimiAdapter(),
  },
  codebuddy: {
    displayName: 'CodeBuddy Code',
    installHint: '未找到 CodeBuddy Code CLI。请先安装并登录（浏览器 OAuth 或 CODEBUDDY_API_KEY）：\n  npm i -g @tencent-ai/codebuddy-code',
    create: () => new CodeBuddyAdapter(),
  },
  dsh: {
    displayName: 'DeepSeek Harness',
    installHint: '未找到 DeepSeek Harness CLI（developer preview）。请先安装，launcher 需与 acp 插件版本配套（建议直接装 next 通道）：\n  npm i -g @deepseek-ai/dsh@next\n  前提：dsh 自身已完成认证（按 dsh 官方方式自备，与桥无关）',
    create: (opts) => new DshAdapter({ permissionMode: opts?.permissionMode }),
  },
};

export function knownAgentTypes(): string[] {
  return Object.keys(REGISTRY);
}

export interface AgentResolution {
  adapter?: AgentAdapter;
  /** Human-readable reason the adapter can't run on this machine. */
  error?: string;
}

/**
 * Resolve an adapter by config id and verify its CLI is available.
 * Returns `error` (never throws) for unknown ids or missing CLIs so
 * callers can exit with the install hint.
 */
export async function resolveAgent(
  type: string,
  opts?: AgentCreateOptions,
): Promise<AgentResolution> {
  const entry = REGISTRY[type];
  if (!entry) {
    return {
      error: `未知的 agent 类型: \`${type}\`。可选: ${knownAgentTypes().join(', ')}`,
    };
  }
  const adapter = entry.create(opts);
  if (!(await adapter.isAvailable())) {
    return { error: entry.installHint };
  }
  return { adapter };
}
