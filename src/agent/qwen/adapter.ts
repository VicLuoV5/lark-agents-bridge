import { probeAgentVersion } from '../proc';
import { runStreamJsonAgent } from '../stream-agent';
import { createClaudeTranslatorState, translateClaudeEvent } from '../cc-stream-json';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../types';

export interface QwenAdapterOptions {
  binary?: string;
}

/**
 * Adapter for Qwen Code (阿里 QwenLM/qwen-code, Gemini CLI lineage).
 *
 * Verified against the shipped CLI (v0.22.3 `qwen --help`) — the online
 * docs advertise `--approval-mode` / `--include-partial-messages` /
 * `--include-directories`, but none of those flags exist in the binary.
 * Reality: `-p` reads stdin (prompt is "appended to input on stdin"),
 * stream-json is message-granular (no token deltas), and permission
 * control lives in settings.json (`tools.approvalMode`), not argv.
 * Session resume additionally requires `general.chatRecording=true`.
 */
export class QwenAdapter implements AgentAdapter {
  readonly id = 'qwen';
  readonly displayName = 'Qwen Code';
  private readonly binary: string;

  constructor(opts: QwenAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.QWEN_BIN ?? 'qwen';
  }

  isAvailable(): Promise<boolean> {
    return probeAgentVersion(this.binary);
  }

  run(opts: AgentRunOptions): AgentRun {
    // One dedupe state per RUN — see claude adapter.
    const translatorState = createClaudeTranslatorState();
    return runStreamJsonAgent(
      {
        agentId: this.id,
        binary: this.binary,
        buildArgs: buildQwenArgs,
        translate: (raw) => translateClaudeEvent(raw, translatorState),
      },
      opts,
    );
  }
}

export function buildQwenArgs(opts: AgentRunOptions, _extraDirs: string[] = []): string[] {
  const base = ['-p', '--output-format', 'stream-json'];
  if (opts.model) base.push('--model', opts.model);
  if (opts.sessionId) base.push('--resume', opts.sessionId);
  // No permission/approval flag exists on the CLI; the bridge prompt's
  // workspace-root convention is the guardrail here.
  return base;
}
