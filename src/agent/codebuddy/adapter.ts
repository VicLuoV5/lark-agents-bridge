import { probeAgentVersion } from '../proc';
import { runStreamJsonAgent } from '../stream-agent';
import { createClaudeTranslatorState, translateClaudeEvent } from '../cc-stream-json';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../types';

export interface CodeBuddyAdapterOptions {
  binary?: string;
}

/**
 * Adapter for Tencent CodeBuddy Code (npm @tencent-ai/codebuddy-code, bin
 * `codebuddy`/`cbc`). Its headless stream-json is Claude-Code-isomorphic:
 * same system/init + assistant/user/result envelopes, same
 * `--include-partial-messages`, same `--resume <id>`, and the bridge's
 * permission vocabulary maps 1:1. Auth is the user's own OAuth login (or
 * CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN env — not managed here).
 */
export class CodeBuddyAdapter implements AgentAdapter {
  readonly id = 'codebuddy';
  readonly displayName = 'CodeBuddy Code';
  private readonly binary: string;

  constructor(opts: CodeBuddyAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.CODEBUDDY_BIN ?? 'codebuddy';
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
        buildArgs: buildCodeBuddyArgs,
        translate: (raw) => translateClaudeEvent(raw, translatorState),
      },
      opts,
    );
  }
}

export function buildCodeBuddyArgs(opts: AgentRunOptions, extraDirs: string[] = []): string[] {
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
