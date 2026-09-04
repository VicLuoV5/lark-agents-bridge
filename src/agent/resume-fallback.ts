import { log } from '../core/logger';
import type { AgentEvent, AgentRun, AgentRunOptions } from './types';

/**
 * Failure messages that mean "the stored session id points nowhere" —
 * wiped storage dirs, CLI upgrades, runs that died before persisting.
 * Phrasings seen in the wild: codex "no rollout found for thread id",
 * Claude-Code-family "No conversation found with session ID".
 */
export const RESUME_FAILURE_RE =
  /no rollout found|thread\/resume|resume failed|no (?:conversation|session) found|(?:conversation|session|thread) not found/i;

/**
 * Swallow one resume-flavored startup failure and re-run the prompt as a
 * fresh session. The fresh run's system event heals the stored id.
 *
 * Safety gate: the retry only fires when NOTHING user-visible happened
 * before the failure (no text/thinking/tool events) — a resume either
 * works or dies at startup; retrying a mid-run failure would re-execute
 * side effects. Any other error passes through untouched.
 */
export async function* withResumeFallback(
  base: AgentRun,
  opts: AgentRunOptions,
  agentId: string,
  spawn: (opts: AgentRunOptions) => AgentRun,
): AsyncGenerator<AgentEvent> {
  let resumeFailed: string | undefined;
  let userVisibleOutput = false;
  for await (const evt of base.events) {
    if (evt.type === 'error' && !userVisibleOutput && RESUME_FAILURE_RE.test(evt.message)) {
      resumeFailed = evt.message;
      break;
    }
    if (evt.type === 'text' || evt.type === 'thinking' || evt.type === 'tool_use') {
      userVisibleOutput = true;
    }
    yield evt;
  }
  if (resumeFailed === undefined) return;
  log.warn('agent', 'resume-stale-retry-fresh', {
    agent: agentId,
    sessionId: opts.sessionId,
    detail: resumeFailed.slice(0, 200),
  });
  const retry = spawn({ ...opts, sessionId: undefined });
  yield* retry.events;
}
