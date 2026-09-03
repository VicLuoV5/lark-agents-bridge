import { createInterface } from 'node:readline';
import { buildBridgePrompt, prepareAgentEnv } from '../bridge';
import { spawnAgentCommand, stopChild, waitForChildExit, type AgentChild } from '../proc';
import { getProviderProfile } from '../providers';
import { log } from '../../core/logger';
import { withWindowsNpmGlobalBin } from '../../runtime/path-env';
import { workspaceRoot } from '../../workspace/guard';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { createClaudeTranslatorState, translateClaudeEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  /** Provider profile id (undefined / 'anthropic' = the user's own login). */
  provider?: string;
  /** Resolved provider API key plaintext. */
  apiKey?: string;
}

/**
 * Adapter for the Claude Code CLI (headless `claude -p`). With a provider
 * profile configured it points Claude Code at an Anthropic-compatible
 * vendor endpoint via env, so one adapter covers DeepSeek/GLM/Kimi/Qwen/
 * 豆包/MiniMax models.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  private readonly binary: string;
  private readonly provider?: string;
  private readonly apiKey?: string;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.CLAUDE_BIN ?? 'claude';
    this.provider = opts.provider;
    this.apiKey = opts.apiKey;
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
    const cwd = opts.cwd ?? workspaceRoot();
    const { env, larkCli } = prepareAgentEnv(cwd);
    applyProviderEnv(env, this.provider, this.apiKey, opts.model);
    const args = buildArgs(opts, larkCli ? [larkCli.toolsDir] : []);
    const child = spawnAgentCommand(this.binary, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // `claude -p` with no prompt argument reads the prompt from stdin.
    child.stdin.end(`${buildBridgePrompt(opts.prompt, { larkCli })}\n`);

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      permissionMode: opts.permissionMode,
      binary: this.binary,
      provider: this.provider ?? 'anthropic',
      larkCli: larkCli?.commandPath,
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

/**
 * Inject the provider profile's env into the spawned claude process.
 * ANTHROPIC_BASE_URL + the profile's token env are the officially supported
 * gateway overrides; model mapping mirrors vendor docs (all DEFAULT_* tiers
 * point at the chosen model unless the profile names a haiku-class one).
 */
function applyProviderEnv(
  env: NodeJS.ProcessEnv,
  providerId: string | undefined,
  apiKey: string | undefined,
  model: string | undefined,
): void {
  const profile = getProviderProfile(providerId);
  if (!profile) return;
  env.ANTHROPIC_BASE_URL = profile.baseUrl;
  if (apiKey) env[profile.tokenEnvVar] = apiKey;
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.haikuModel ?? model;
  }
  if (profile.extraEnv) Object.assign(env, profile.extraEnv);
}

export function buildArgs(opts: AgentRunOptions, extraDirs: string[] = []): string[] {
  const base = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  for (const dir of extraDirs) {
    base.push('--add-dir', dir);
  }
  if (opts.model) base.push('--model', opts.model);
  if (opts.permissionMode) base.push('--permission-mode', opts.permissionMode);
  if (opts.sessionId) base.push('--resume', opts.sessionId);
  return base;
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
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const state = createClaudeTranslatorState();
  let sawError = false;
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
      for (const evt of translateClaudeEvent(parsed, state)) {
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
  // A `result` error event already carries the failure detail — don't pile
  // a second error on top of it when the CLI also exits nonzero.
  if (!sawError && exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `claude exited with code ${exitCode}${detail}` };
  } else if (!sawError && runtimeError) {
    yield { type: 'error', message: `claude runtime error: ${runtimeError.message}` };
  }
}
