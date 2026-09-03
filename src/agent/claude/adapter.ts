import { probeAgentVersion } from '../proc';
import { applyProviderEnv } from './provider-env';
import { runStreamJsonAgent } from '../stream-agent';
import {
  createClaudeTranslatorState,
  translateClaudeEvent,
} from '../cc-stream-json';
import type { AgentAdapter, AgentHistory, AgentRun, AgentRunOptions } from '../types';
import { listRecentClaudeSessions } from './history';

export interface ClaudeAdapterOptions {
  binary?: string;
  /** Provider profile id (undefined / 'anthropic' = the user's own login). */
  provider?: string;
  /** Resolved provider API key plaintext. */
  apiKey?: string;
}

/**
 * Adapter for the Claude Code CLI (headless `claude -p`). With a provider
 * profile configured it points Claude Code at an Anthropic-compatible
 * vendor endpoint via env, so one adapter covers DeepSeek/GLM/Kimi/Qwen/
 * 豆包/MiniMax models.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly history: AgentHistory = { list: listRecentClaudeSessions };
  private readonly binary: string;
  private readonly provider?: string;
  private readonly apiKey?: string;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.CLAUDE_BIN ?? 'claude';
    this.provider = opts.provider;
    this.apiKey = opts.apiKey;
  }

  isAvailable(): Promise<boolean> {
    return probeAgentVersion(this.binary);
  }

  run(opts: AgentRunOptions): AgentRun {
    // One dedupe state per RUN — partial-delta suppression only works when
    // the state persists across the stream's lines.
    const translatorState = createClaudeTranslatorState();
    return runStreamJsonAgent(
      {
        agentId: this.id,
        binary: this.binary,
        extraEnv: applyProviderEnv(this.provider, this.apiKey, opts.model),
        buildArgs: buildClaudeArgs,
        translate: (raw) => translateClaudeEvent(raw, translatorState),
        logFields: { provider: this.provider ?? 'anthropic' },
      },
      opts,
    );
  }
}

export function buildClaudeArgs(opts: AgentRunOptions, extraDirs: string[] = []): string[] {
  const base = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  for (const dir of extraDirs) {
    base.push('--add-dir', dir);
  }
  if (opts.model) base.push('--model', opts.model);
  if (opts.permissionMode) base.push('--permission-mode', opts.permissionMode);
  if (opts.sessionId) base.push('--resume', opts.sessionId);
  return base;
}
