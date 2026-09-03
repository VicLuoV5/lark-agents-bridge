import { probeAgentVersion, resolveWindowsNodeEntry, spawnNodeEntry } from '../proc';
import { runStreamJsonAgent } from '../stream-agent';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { translateKimiEvent } from './stream-json';

export interface KimiAdapterOptions {
  binary?: string;
}

/**
 * Adapter for Kimi Code CLI (月之暗面 MoonshotAI/kimi-code, bin `kimi`).
 * Quirks that differ from the Claude-Code family, per official docs and
 * verified against the shipped CLI (v0.40.1):
 *
 * - `-p` requires a non-empty argv prompt (stdin is rejected), so the
 *   composed prompt travels in argv, capped well under the ~32k Windows
 *   command-line limit. cmd.exe cannot quote such payloads safely (the
 *   bridge prompt alone contains quotes and unicode), so when the npm
 *   shim resolves we spawn `node <entry>` directly instead.
 * - Non-interactive mode runs with `auto` permission and cannot combine
 *   with --yolo/--auto/--plan, so the bridge's permission vocabulary has
 *   nowhere to land (dangerous commands stay hard-blocked by the CLI).
 * - No token-delta mode in the CLI; messages arrive whole, and the CLI
 *   documents no terminal result line — so a synthetic `done` is emitted
 *   when stdout closes without one.
 * - The stream-json field-level schema is undocumented; the translator is
 *   tolerance-based. Verify against real CLI output before trusting edge
 *   cases.
 */
export class KimiAdapter implements AgentAdapter {
  readonly id = 'kimi';
  readonly displayName = 'Kimi Code';
  private readonly binary: string;
  private entryPromise?: Promise<string | undefined>;
  private resolvedEntry: string | undefined;

  constructor(opts: KimiAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.KIMI_BIN ?? 'kimi';
  }

  async isAvailable(): Promise<boolean> {
    // Resolve the direct node entry alongside the availability probe so
    // run() can skip cmd.exe (the prompt argv must not pass through cmd).
    this.entryPromise ??= resolveWindowsNodeEntry(this.binary);
    const available = await probeAgentVersion(this.binary);
    this.resolvedEntry = await this.entryPromise;
    if (available && this.resolvedEntry === undefined && process.platform === 'win32') {
      log.warn('agent', 'shim-entry-unresolved', {
        agent: this.id,
        detail: 'falling back to cmd spawn; prompts with quotes/unicode may fail',
      });
    }
    return available;
  }

  run(opts: AgentRunOptions): AgentRun {
    // isAvailable() always precedes run() (registry gate + preflight), so
    // the entry resolution has already settled.
    const entry = this.resolvedEntry;
    const base = runStreamJsonAgent(
      {
        agentId: this.id,
        binary: entry ?? this.binary,
        buildArgs: buildKimiArgs,
        translate: translateKimiEvent,
        promptViaArgv: true,
        maxArgvPromptChars: 24_000,
        ...(entry
          ? { spawn: (binary: string, args: string[], options: Parameters<typeof spawnNodeEntry>[2]) => spawnNodeEntry(entry, args, options) }
          : {}),
      },
      opts,
    );
    return { ...base, events: withSyntheticDone(base.events) };
  }
}

export function buildKimiArgs(
  opts: AgentRunOptions,
  extraDirs: string[],
  composedPrompt: string,
): string[] {
  const base = ['-p', composedPrompt, '--output-format', 'stream-json'];
  for (const dir of extraDirs) {
    base.push('--add-dir', dir);
  }
  if (opts.model) base.push('--model', opts.model);
  if (opts.sessionId) base.push('--session', opts.sessionId);
  return base;
}

/**
 * Kimi documents no terminal result line for `-p` runs: the process simply
 * exits. If stdout closed without a done/error event, emit done so the
 * bridge settles the run instead of waiting for the idle timeout.
 */
async function* withSyntheticDone(events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
  let terminal = false;
  for await (const evt of events) {
    if (evt.type === 'done' || evt.type === 'error') terminal = true;
    yield evt;
  }
  if (!terminal) yield { type: 'done' };
}
