import { describe, expect, it } from 'vitest';
import { translateKimiEvent } from '../src/agent/kimi/stream-json';
import { buildKimiArgs } from '../src/agent/kimi/adapter';

function collect(lines: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    for (const evt of translateKimiEvent(line)) out.push(evt);
  }
  return out;
}

describe('kimi stream-json translation (tolerant, schema undocumented)', () => {
  it('extracts text and tool_calls from an assistant message envelope', () => {
    const events = collect([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '看一下目录' }],
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"ls"}' },
            },
          ],
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: '看一下目录' },
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
    ]);
  });

  it('maps a tool result message with snake/camel id variants', () => {
    const events = collect([
      { type: 'tool', message: { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' } },
      { type: 'tool_result', toolCallId: 'call_2', content: 'ok', is_error: true },
    ]);
    expect(events).toEqual([
      { type: 'tool_result', id: 'call_1', output: 'a.txt\nb.txt', isError: false },
      { type: 'tool_result', id: 'call_2', output: 'ok', isError: true },
    ]);
  });

  it('yields a system event for a session meta line but not for assistant lines', () => {
    const events = collect([
      { type: 'meta', session_id: '01HZXYZ' },
      { type: 'assistant', session_id: '01HZXYZ', message: { role: 'assistant', content: 'hi' } },
    ]);
    expect(events.filter((e) => (e as { type: string }).type === 'system')).toHaveLength(1);
    expect(events.filter((e) => (e as { type: string }).type === 'text')).toHaveLength(1);
  });

  it('emits usage and done from a result line', () => {
    const events = collect([
      {
        type: 'result',
        session_id: '01HZXYZ',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', sessionId: '01HZXYZ' },
    ]);
  });

  it('ignores malformed and unknown lines', () => {
    expect(collect([null, 'nope', { type: 'status', foo: 1 }, 42])).toEqual([]);
  });
});

describe('kimi args', () => {
  it('passes the composed prompt via -p argv and resumes with --session', () => {
    const args = buildKimiArgs(
      { prompt: 'user text', sessionId: '01HZXYZ', model: 'kimi-k3' },
      ['D:\\w\\.feishu-codex-bridge-tools'],
      'BRIDGE+user text',
    );
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('BRIDGE+user text');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--add-dir');
    expect(args).toContain('D:\\w\\.feishu-codex-bridge-tools');
    expect(args).toContain('--model');
    expect(args).toContain('kimi-k3');
    expect(args).toContain('--session');
    expect(args).toContain('01HZXYZ');
    // -p cannot combine with permission flags (auto is implied).
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--auto');
    expect(args).not.toContain('--plan');
  });
});
