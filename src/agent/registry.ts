import type { AgentAdapter } from './types';
import { CodexAdapter } from './codex/adapter';

interface AgentRegistration {
  displayName: string;
  /** One-line hint printed when the CLI can't be found on this machine. */
  installHint: string;
  create(): AgentAdapter;
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
export async function resolveAgent(type: string): Promise<AgentResolution> {
  const entry = REGISTRY[type];
  if (!entry) {
    return {
      error: `未知的 agent 类型: \`${type}\`。可选: ${knownAgentTypes().join(', ')}`,
    };
  }
  const adapter = entry.create();
  if (!(await adapter.isAvailable())) {
    return { error: entry.installHint };
  }
  return { adapter };
}
