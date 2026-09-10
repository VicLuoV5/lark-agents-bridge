import type { SpawnOptions } from 'node:child_process';
import { buildBridgePrompt, prepareAgentEnv } from './bridge';
import { createJsonlEventStream } from './jsonl';
import { withResumeFallback } from './resume-fallback';
import { spawnAgentCommand, stopChild, waitForChildExit, type AgentChild } from './proc';
import { log } from '../core/logger';
import { workspaceRoot } from '../workspace/guard';
import type { AgentEvent, AgentRun, AgentRunOptions } from './types';

/**
 * Everything that varies between the Claude-Code-dialect agents (claude /
 * qwen / codebuddy): binary, argv builder, per-run env extras, and the line
 * translator. The run shape — spawn, pipe the bridge prompt via stdin,
 * capture stderr, pump JSONL events, graceful stop — is identical.
 */
export interface StreamJsonAgentSpec {
  agentId: string;
  binary: string;
  /** Env layered onto the prepared bridge env (provider endpoints, auth…). */
  extraEnv?: NodeJS.ProcessEnv;
  /**
   * Third argument is the composed prompt (bridge conventions + user text).
   * Only meaningful with promptViaArgv; stdin-mode builders ignore it.
   */
  buildArgs: (opts: AgentRunOptions, extraDirs: string[], composedPrompt: string) => string[];
  translate: (raw: unknown) => Generator<AgentEvent>;
  /** Extra structured log fields on spawn (e.g. provider id). */
  logFields?: Record<string, unknown>;
  /**
   * Pass the composed prompt as an argv element (CLI reads `-p <prompt>`)
   * instead of stdin. Windows CreateProcess caps a single command line at
   * ~32k chars — guard with maxArgvPromptChars.
   */
  promptViaArgv?: boolean;
  maxArgvPromptChars?: number;
  /**
   * Override the default spawn (cmd.exe wrapper on Windows) — e.g. a
   * resolved `node <entry>` pair for CLIs whose argv carries the prompt.
   */
  spawn?: (binary: string, args: string[], options: SpawnOptions) => AgentChild;
}

function errorRun(agentId: string, message: string): AgentRun {
  log.warn('agent', 'run-rejected', { agent: agentId, reason: message });
  return {
    events: (async function* () {
      yield { type: 'error', message };
    })(),
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

export function runStreamJsonAgent(spec: StreamJsonAgentSpec, opts: AgentRunOptions): AgentRun {
  const base = buildStreamJsonRun(spec, opts);
  if (!opts.sessionId) return base;
  // Resuming a stored id can hard-fail (wiped CLI storage, upgrade, run
  // that died before persisting) — retry once fresh, same contract as the
  // codex adapter. Only fires for startup failures; see withResumeFallback.
  let current: AgentRun = base;
  return {
    events: withResumeFallback(base, opts, spec.agentId, (retryOpts: AgentRunOptions): AgentRun => {
      const retry = buildStreamJsonRun(spec, retryOpts);
      current = retry;
      return retry;
    }),
    stop: async () => current.stop(),
    waitForExit: (timeoutMs) => current.waitForExit(timeoutMs),
  };
}

function buildStreamJsonRun(spec: StreamJsonAgentSpec, opts: AgentRunOptions): AgentRun {
  const cwd = opts.cwd ?? workspaceRoot();
  const { env, larkCli } = prepareAgentEnv(cwd, opts.larkCliProfile);
  if (spec.extraEnv) Object.assign(env, spec.extraEnv);
  const composedPrompt = buildBridgePrompt(opts.prompt, { larkCli });
  if (spec.promptViaArgv && composedPrompt.length > (spec.maxArgvPromptChars ?? Infinity)) {
    return errorRun(
      spec.agentId,
      `消息过长（${composedPrompt.length} 字符）。该 agent 通过命令行参数接收 prompt，` +
        `上限约 ${spec.maxArgvPromptChars} 字符；请缩短消息或减少引用内容。`,
    );
  }
  const args = spec.buildArgs(opts, larkCli ? [larkCli.toolsDir] : [], composedPrompt);
  const child = (spec.spawn ?? spawnAgentCommand)(spec.binary, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!spec.promptViaArgv) {
    // These CLIs read the prompt from stdin when no prompt argument is given.
    child.stdin.end(`${composedPrompt}\n`);
  } else {
    child.stdin.end();
  }

  log.info('agent', 'spawn', {
    pid: child.pid ?? null,
    agent: spec.agentId,
    cwd,
    hasSession: Boolean(opts.sessionId),
    promptChars: opts.prompt.length,
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    permissionMode: opts.permissionMode,
    binary: spec.binary,
    larkCli: larkCli?.commandPath,
    larkCliProfile: opts.larkCliProfile,
    ...spec.logFields,
  });

  const stderrChunks: Buffer[] = [];
  let stderrBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBuffer += chunk.toString('utf8');
    let nl = stderrBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stderrBuffer.slice(0, nl);
      stderrBuffer = stderrBuffer.slice(nl + 1);
      if (line.trim()) log.warn('agent', 'stderr', { line });
      nl = stderrBuffer.indexOf('\n');
    }
  });

  let runtimeError: Error | null = null;
  child.on('error', (err) => {
    runtimeError = err;
  });
  child.on('exit', (code, signal) => {
    log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
  });

  const stopGraceMs = opts.stopGraceMs ?? 5000;
  return {
    events: createJsonlEventStream(child, stderrChunks, () => runtimeError, {
      agentLabel: spec.agentId,
      translate: spec.translate,
    }),
    async stop() {
      await stopChild(child, stopGraceMs, spec.agentId);
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      return waitForChildExit(child, timeoutMs);
    },
  };
}
