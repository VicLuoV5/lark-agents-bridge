import { createInterface } from 'node:readline';
import { buildBridgePrompt, prepareAgentEnv } from '../bridge';
import { withResumeFallback } from '../resume-fallback';
import { spawnAgentCommand, stopChild, waitForChildExit, type AgentChild } from '../proc';
import { log } from '../../core/logger';
import { withWindowsNpmGlobalBin } from '../../runtime/path-env';
import { isCodexReasoningEffort } from '../../config/schema';
import { listRecentSessions } from '../../session/history';
import { workspaceRoot } from '../../workspace/guard';
import type { AgentAdapter, AgentEvent, AgentHistory, AgentRun, AgentRunOptions } from '../types';
import { translateCodexEvent } from './stream-json';

export interface CodexAdapterOptions {
  binary?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly history: AgentHistory = { list: listRecentSessions };
  readonly effortOptions = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
  private readonly binary: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.CODEX_BIN ?? 'codex';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawnAgentCommand(this.binary, ['--version'], {
        env: withWindowsNpmGlobalBin({ ...process.env }),
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const base = this.spawnRun(opts);
    if (!opts.sessionId) return base;
    // Resuming a stored id can hard-fail for reasons outside our control
    // (wiped ~/.codex, an upgrade, a run that died before persisting its
    // rollout). Retry once with a fresh session instead of failing the
    // user's message; the fresh run's system event heals the stored id.
    let current: AgentRun = base;
    return {
      events: withResumeFallback(base, opts, this.id, (retryOpts: AgentRunOptions): AgentRun => {
        const retry = this.spawnRun(retryOpts);
        current = retry;
        return retry;
      }),
      stop: async () => current.stop(),
      waitForExit: (timeoutMs) => current.waitForExit(timeoutMs),
    };
  }

  private spawnRun(opts: AgentRunOptions): AgentRun {
    const cwd = opts.cwd ?? workspaceRoot();
    const { env, larkCli } = prepareAgentEnv(cwd, opts.larkCliProfile);
    const args = buildArgs(opts, larkCli ? [larkCli.toolsDir] : []);
    const child = spawnAgentCommand(this.binary, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(`${buildBridgePrompt(opts.prompt, { larkCli })}\n`);

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      binary: this.binary,
      larkCli: larkCli?.commandPath,
      larkCliProfile: opts.larkCliProfile,
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
    const agentId = this.id;
    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        await stopChild(child, stopGraceMs, agentId);
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return waitForChildExit(child, timeoutMs);
      },
    };
  }
}

export function buildArgs(opts: AgentRunOptions, extraSandboxDirs: string[] = []): string[] {
  const sandbox = sandboxForPermissionMode(opts.permissionMode);
  const base = [
    'exec',
    '--json',
    '--sandbox',
    sandbox,
    '--skip-git-repo-check',
  ];
  for (const dir of [...extraSandboxDirsForPermissionMode(opts.permissionMode), ...extraSandboxDirs]) {
    base.push('--add-dir', dir);
  }
  if (opts.model) base.push('--model', opts.model);
  // reasoningEffort is opaque at the bridge level — validate the Codex
  // vocabulary here and ignore anything else with a warning.
  if (opts.reasoningEffort) {
    if (isCodexReasoningEffort(opts.reasoningEffort)) {
      base.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
    } else {
      log.warn('agent', 'reasoning-effort-ignored', {
        agent: 'codex',
        value: opts.reasoningEffort,
        supported: 'minimal|low|medium|high|xhigh',
      });
    }
  }
  if (opts.sessionId) {
    base.push('resume', opts.sessionId, '-');
  } else {
    base.push('-');
  }
  return base;
}

function sandboxForPermissionMode(mode: AgentRunOptions['permissionMode']): string {
  if (mode === 'bypassPermissions') return 'danger-full-access';
  if (mode === 'acceptEdits') return 'workspace-write';
  return 'read-only';
}

export function extraSandboxDirsForPermissionMode(
  mode: AgentRunOptions['permissionMode'],
  _env: NodeJS.ProcessEnv = process.env,
  _platform = process.platform,
): string[] {
  if (mode !== 'acceptEdits') return [];
  return [];
}

async function* createEventStream(
  child: AgentChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
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
      yield* translateCodexEvent(parsed);
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
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
