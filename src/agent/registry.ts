import type { AgentAdapter } from './types';
import { CodexAdapter } from './codex/adapter';
import { ClaudeAdapter } from './claude/adapter';

/** Runtime options an adapter may need from the active config. */
export interface AgentCreateOptions {
  /** Provider profile id (claude adapter). */
  provider?: string;
  /** Resolved provider API key plaintext (claude adapter). */
  apiKey?: string;
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
