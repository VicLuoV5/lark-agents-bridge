import { createInterface } from 'node:readline';
import type { AgentChild } from './proc';
import type { AgentEvent } from './types';

export interface JsonlEventStreamSpec {
  /** Used in error messages ("claude exited with code 1"). */
  agentLabel: string;
  /** Translate one parsed JSONL object into bridge events. */
  translate: (raw: unknown) => Generator<AgentEvent>;
}

/**
 * Shared event pump for stream-json agents: parse stdout lines, run each
 * through the translator, then emit one exit-code error unless the
 * translator already surfaced one (a `result`-style error event carries
 * better detail than a bare nonzero exit — don't pile both on the user).
 */
export async function* createJsonlEventStream(
  child: AgentChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  spec: JsonlEventStreamSpec,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err
        ? `failed to spawn ${spec.agentLabel}: ${err.message}`
        : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawError = false;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const evt of spec.translate(parsed)) {
        if (evt.type === 'error') sawError = true;
        yield evt;
      }
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });
  const runtimeError = getError();
  if (!sawError && exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `${spec.agentLabel} exited with code ${exitCode}${detail}` };
  } else if (!sawError && runtimeError) {
    yield { type: 'error', message: `${spec.agentLabel} runtime error: ${runtimeError.message}` };
  }
}
