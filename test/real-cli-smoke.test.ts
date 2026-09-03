import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/agent/claude/adapter';
import { QwenAdapter } from '../src/agent/qwen/adapter';
import { KimiAdapter } from '../src/agent/kimi/adapter';
import { CodeBuddyAdapter } from '../src/agent/codebuddy/adapter';
import type { AgentAdapter } from '../src/agent/types';

/**
 * Real-CLI smoke harness. Skipped unless P2_SMOKE=1 — it spawns actual
 * agent CLIs (consuming whatever login/quota they have) and is meant for
 * manual verification, not CI:
 *
 *   P2_SMOKE=1 corepack pnpm vitest run test/real-cli-smoke.test.ts
 *
 * Unauthenticated CLIs are still useful here: the run must TERMINATE
 * (error event, not a hang) and any stream events it emits validate the
 * translators against reality.
 */
const SMOKE = process.env.P2_SMOKE === '1';
const PROMPT = 'Reply with exactly: OK';

interface Outcome {
  events: string[];
  text: string;
  sessionId?: string;
  terminated: boolean;
}

async function drive(adapter: AgentAdapter, label: string, timeoutMs = 60_000): Promise<Outcome> {
  const out: Outcome = { events: [], text: '', terminated: false };
  if (!(await adapter.isAvailable())) {
    out.events.push('unavailable');
    return out;
  }
  const run = adapter.run({ prompt: PROMPT, permissionMode: 'default' });
  const killer = setTimeout(() => void run.stop(), timeoutMs);
  try {
    for await (const evt of run.events) {
      if (evt.type === 'system') {
        out.sessionId = evt.sessionId;
        out.events.push(`system(session=${evt.sessionId ?? '-'},model=${evt.model ?? '-'})`);
      } else if (evt.type === 'text') {
        out.text += evt.delta;
        out.events.push(`text(+${evt.delta.length})`);
      } else if (evt.type === 'thinking') {
        out.events.push(`thinking(+${evt.delta.length})`);
      } else if (evt.type === 'tool_use') {
        out.events.push(`tool_use(${evt.name})`);
      } else if (evt.type === 'tool_result') {
        out.events.push(`tool_result(err=${evt.isError})`);
      } else if (evt.type === 'usage') {
        out.events.push(`usage(in=${evt.inputTokens ?? '-'},out=${evt.outputTokens ?? '-'})`);
      } else if (evt.type === 'done') {
        out.events.push(`done(session=${evt.sessionId ?? '-'})`);
        out.terminated = true;
      } else if (evt.type === 'error') {
        out.events.push(`error(${String(evt.message).slice(0, 200)})`);
        out.terminated = true;
      }
    }
    await run.waitForExit(15_000);
  } finally {
    clearTimeout(killer);
  }
  console.log(`[${label}]`, out.events.join(' -> ').slice(0, 1000));
  console.log(`[${label}] text:`, JSON.stringify(out.text.slice(0, 200)));
  return out;
}

describe.skipIf(!SMOKE)('real CLI smoke', () => {
  it('claude', { timeout: 120_000 }, async () => {
    const out = await drive(new ClaudeAdapter(), 'claude');
    expect(out.terminated, out.events.join('->')).toBe(true);
  });

  it('qwen', { timeout: 120_000 }, async () => {
    const out = await drive(new QwenAdapter(), 'qwen');
    expect(out.terminated, out.events.join('->')).toBe(true);
  });

  it('kimi', { timeout: 120_000 }, async () => {
    const out = await drive(new KimiAdapter(), 'kimi');
    expect(out.terminated, out.events.join('->')).toBe(true);
  });

  it('codebuddy', { timeout: 120_000 }, async () => {
    const out = await drive(new CodeBuddyAdapter(), 'codebuddy');
    expect(out.terminated, out.events.join('->')).toBe(true);
  });
});
