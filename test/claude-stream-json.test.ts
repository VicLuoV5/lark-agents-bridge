import { describe, expect, it } from 'vitest';
import {
  createClaudeTranslatorState,
  translateClaudeEvent,
} from '../src/agent/claude/stream-json';

function collect(lines: unknown[]): ReturnType<typeof Array.from> {
  const state = createClaudeTranslatorState();
  const out: unknown[] = [];
  for (const line of lines) {
    for (const evt of translateClaudeEvent(line, state)) out.push(evt);
  }
  return out;
}

describe('claude stream-json translation', () => {
  it('maps system init to a system event with session id', () => {
    const events = collect([
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5', cwd: '/w' },
    ]);
    expect(events).toEqual([
      { type: 'system', sessionId: 'sess-1', model: 'claude-opus-5', cwd: '/w' },
    ]);
  });

  it('emits streamed text deltas and suppresses the duplicate complete message', () => {
    const events = collect([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
    ]);
  });

  it('falls back to the complete message when no partial messages arrive', () => {
    const events = collect([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    ]);
    expect(events).toEqual([{ type: 'text', delta: 'Hello' }]);
  });

  it('keeps tool_use from the complete message even when text was streamed', () => {
    const events = collect([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'thinking out loud' } } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking out loud' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false }] },
      },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'thinking out loud' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 'toolu_1', output: 'a.txt', isError: false },
    ]);
  });

  it('resets dedupe per message so the next message streams again', () => {
    const state = createClaudeTranslatorState();
    const out: unknown[] = [];
    for (const line of [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
    ]) {
      for (const evt of translateClaudeEvent(line, state)) out.push(evt);
    }
    expect(out).toEqual([
      { type: 'text', delta: 'one' },
      { type: 'text', delta: 'two' },
    ]);
  });

  it('maps the result event to usage + done', () => {
    const events = collect([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sess-1',
        usage: { input_tokens: 12, output_tokens: 34 },
        total_cost_usd: 0.01,
      },
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 34, costUsd: 0.01 },
      { type: 'done', sessionId: 'sess-1' },
    ]);
  });

  it('maps an error result to an error event', () => {
    const events = collect([
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' },
    ]);
    expect(events).toEqual([{ type: 'error', message: 'boom' }]);
  });
});
