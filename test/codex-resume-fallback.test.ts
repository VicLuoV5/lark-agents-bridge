import { describe, expect, it } from 'vitest';
import {
  RESUME_FAILURE_RE,
  withStaleSessionFallback,
} from '../src/agent/codex/adapter';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../src/agent/types';

function fakeRun(events: AgentEvent[]): AgentRun {
  return {
    events: (async function* () {
      for (const evt of events) yield evt;
    })(),
    stop: async () => {},
    waitForExit: async () => true,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}

const OPTS: AgentRunOptions = { prompt: 'hi', sessionId: 'dead-1' };

describe('codex stale-session fallback', () => {
  it('swallows a resume failure and retries fresh', async () => {
    let retriedWith: AgentRunOptions | undefined;
    const events = await collect(
      withStaleSessionFallback(
        fakeRun([
          { type: 'system', sessionId: 'dead-1' },
          { type: 'error', message: 'codex exited with code 1: Error: thread/resume: no rollout found for thread id x' },
        ]),
        OPTS,
        (opts) => {
          retriedWith = opts;
          return fakeRun([
            { type: 'system', sessionId: 'fresh-1' },
            { type: 'text', delta: 'ok' },
            { type: 'done', sessionId: 'fresh-1' },
          ]);
        },
      ),
    );
    expect(retriedWith?.sessionId).toBeUndefined();
    // The dead run's system event passes through; the fresh run's system
    // event overwrites the stored id right after.
    expect(events).toEqual([
      { type: 'system', sessionId: 'dead-1' },
      { type: 'system', sessionId: 'fresh-1' },
      { type: 'text', delta: 'ok' },
      { type: 'done', sessionId: 'fresh-1' },
    ]);
  });

  it('passes through non-resume errors untouched', async () => {
    const events = await collect(
      withStaleSessionFallback(
        fakeRun([{ type: 'error', message: 'codex exited with code 1: network unreachable' }]),
        OPTS,
        () => {
          throw new Error('must not retry');
        },
      ),
    );
    expect(events).toEqual([{ type: 'error', message: 'codex exited with code 1: network unreachable' }]);
  });

  it('matches the documented codex failure phrasing', () => {
    expect(RESUME_FAILURE_RE.test('Error: thread/resume: thread/resume failed: no rollout found for thread id 1a55 (code -32600)')).toBe(true);
    expect(RESUME_FAILURE_RE.test('Error: quota exceeded')).toBe(false);
  });
});
