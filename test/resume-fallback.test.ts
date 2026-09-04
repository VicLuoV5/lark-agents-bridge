import { describe, expect, it } from 'vitest';
import {
  RESUME_FAILURE_RE,
  withResumeFallback,
} from '../src/agent/resume-fallback';
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
const AGENT = 'claude';

describe('resume fallback (shared by codex + stream-json agents)', () => {
  it('swallows a startup resume failure and retries fresh', async () => {
    let retriedWith: AgentRunOptions | undefined;
    const events = await collect(
      withResumeFallback(
        fakeRun([
          { type: 'system', sessionId: 'dead-1' },
          { type: 'error', message: 'claude exited with code 1: No conversation found with session ID dead-1' },
        ]),
        OPTS,
        AGENT,
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

  it('never retries after user-visible output (side-effect safety)', async () => {
    const events = await collect(
      withResumeFallback(
        fakeRun([
          { type: 'text', delta: 'partial answer' },
          { type: 'error', message: 'no conversation found' },
        ]),
        OPTS,
        AGENT,
        () => {
          throw new Error('must not retry after user-visible output');
        },
      ),
    );
    expect(events).toEqual([
      { type: 'text', delta: 'partial answer' },
      { type: 'error', message: 'no conversation found' },
    ]);
  });

  it('passes through non-resume errors untouched', async () => {
    const events = await collect(
      withResumeFallback(
        fakeRun([{ type: 'error', message: 'claude exited with code 1: network unreachable' }]),
        OPTS,
        AGENT,
        () => {
          throw new Error('must not retry');
        },
      ),
    );
    expect(events).toEqual([{ type: 'error', message: 'claude exited with code 1: network unreachable' }]);
  });

  it('matches the documented failure phrasings across CLIs', () => {
    expect(RESUME_FAILURE_RE.test('Error: thread/resume: thread/resume failed: no rollout found for thread id 1a55 (code -32600)')).toBe(true);
    expect(RESUME_FAILURE_RE.test('No conversation found with session ID dead-1')).toBe(true);
    expect(RESUME_FAILURE_RE.test('Error: quota exceeded')).toBe(false);
  });
});
