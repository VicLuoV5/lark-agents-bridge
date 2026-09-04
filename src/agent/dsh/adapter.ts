import type { SpawnOptions } from 'node:child_process';
import { normalize } from 'node:path';
import { AcpConnection, type AcpConfigOption, type AcpSpawnResult, type AcpUpdate } from '../acp/connection';
import { buildBridgePrompt, prepareAgentEnv } from '../bridge';
import { spawnAgentCommand, probeAgentVersion, type AgentChild } from '../proc';
import { log } from '../../core/logger';
import { workspaceRoot } from '../../workspace/guard';
import type { AgentAdapter, AgentEvent, AgentHistory, AgentHistoryEntry, AgentRun, AgentRunOptions } from '../types';

export interface DshAdapterOptions {
  binary?: string;
  /** Bridge permission vocabulary snapshot, for the approval policy. */
  permissionMode?: AgentRunOptions['permissionMode'];
  /** Test/SMOKE seam: override every dsh spawn (probe, provision, ACP child). */
  spawn?: (args: string[], options: SpawnOptions) => AgentChild;
  /** Test seam: whether the `acp` profile is already installed. */
  profileInstalled?: () => Promise<boolean>;
  /** Test seam: install the profile. */
  provision?: () => Promise<void>;
  /** Test seam: ACP subprocess idle shutdown (default 10 min). */
  idleShutdownMs?: number;
}

const ACP_PROFILE_ARGS = ['--profile', 'acp'];
const ACP_APP_PACKAGE = '@deepseek-ai/dsh-acp-app';

/**
 * Adapter for DeepSeek Harness (dsh) over its automation-only ACP stdio
 * profile. One persistent dsh subprocess multiplexes every bridge session;
 * sessions survive process restarts via session/resume (spike-verified).
 *
 * DeepSeek Harness is a developer preview: expect breaking changes. The
 * message updates arrive per committed message (no token streaming), and
 * the CLI's own sandbox is only partially enforced on Windows.
 */
export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness';
  /** dsh's reasoning_effort config option, per the spike's configOptions. */
  readonly effortOptions = ['off', 'low', 'high', 'max'] as const;
  private readonly binary: string;
  private readonly permissionMode: AgentRunOptions['permissionMode'];
  private readonly spawnDsh: (args: string[], options: SpawnOptions) => AgentChild;
  private readonly profileInstalledProbe: () => Promise<boolean>;
  private readonly provisionProfile: () => Promise<void>;
  private readonly idleShutdownMs: number | undefined;
  private connection: AcpConnection | undefined;
  private provisioned = false;
  private provisioning: Promise<void> | undefined;
  private currentEnv: NodeJS.ProcessEnv | undefined;

  constructor(opts: DshAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.DSH_BIN ?? 'dsh';
    this.permissionMode = opts.permissionMode;
    this.idleShutdownMs = opts.idleShutdownMs;
    this.spawnDsh = opts.spawn ?? ((args, options) => spawnAgentCommand(this.binary, args, options));
    this.profileInstalledProbe =
      opts.profileInstalled ??
      (() =>
        new Promise<boolean>((resolve) => {
          const child = this.spawnDsh([...ACP_PROFILE_ARGS, '-h'], { stdio: 'ignore' });
          child.on('error', () => resolve(false));
          child.on('exit', (code) => resolve(code === 0));
        }));
    this.provisionProfile =
      opts.provision ??
      (() =>
        new Promise<void>((resolve, reject) => {
          log.info('agent', 'dsh-provision-start', { agent: this.id });
          const child = this.spawnDsh(
            ['plugin', ...ACP_PROFILE_ARGS, 'add', ACP_APP_PACKAGE],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          const stderr: Buffer[] = [];
          child.stderr?.on('data', (c: Buffer) => stderr.push(c));
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`dsh profile 安装超时（180s）。可手动执行：dsh plugin --profile acp add ${ACP_APP_PACKAGE}`));
          }, 180_000);
          child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`dsh profile 安装失败：${err.message}`));
          });
          child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else {
              const tail = Buffer.concat(stderr).toString('utf8').trim().slice(-400);
              reject(
                new Error(
                  `dsh profile 安装失败（exit ${code}）${tail ? `：${tail}` : ''}。` +
                    `可手动执行：dsh plugin --profile acp add ${ACP_APP_PACKAGE}`,
                ),
              );
            }
          });
        }));
  }

  isAvailable(): Promise<boolean> {
    return probeAgentVersion(this.binary);
  }

  /** Sessions resumable right now (live in-memory or persisted on disk). */
  readonly history: AgentHistory = {
    list: async (cwd: string, limit = 5): Promise<AgentHistoryEntry[]> => {
      await this.ensureProvisioned();
      const sessions = await this.getConnection().listSessions();
      const wanted = normalize(cwd).toLowerCase();
      return sessions
        .filter((s) => !s.cwd || normalize(s.cwd).toLowerCase() === wanted)
        .slice(0, limit)
        .map((s) => ({
          sessionId: s.sessionId,
          // session/list carries no timestamps/previews (verified shape:
          // {sessionId, cwd}); placeholders keep the /resume UI working.
          mtime: Date.now(),
          preview: '(dsh 会话)',
          lineCount: 0,
        }));
    },
  };

  run(opts: AgentRunOptions): AgentRun {
    const state = { sessionId: undefined as string | undefined, stopRequested: false };
    const queue = new EventQueue();
    void this.drive(opts, state, queue);
    return {
      events: queue,
      stop: async () => {
        state.stopRequested = true;
        if (state.sessionId) this.getConnection().cancel(state.sessionId);
      },
      waitForExit: async () => {
        // ACP runs settle with the prompt request — no process tail to wait
        // out (the subprocess stays up for the next message).
        return queue.settled;
      },
    };
  }

  private async drive(
    opts: AgentRunOptions,
    state: { sessionId: string | undefined; stopRequested: boolean },
    queue: EventQueue,
  ): Promise<void> {
    const finish = (evt?: AgentEvent): void => {
      if (evt) queue.push(evt);
      queue.close();
    };
    try {
      const cwd = opts.cwd ?? workspaceRoot();
      await this.ensureProvisioned();
      const conn = this.getConnection();
      const { env, larkCli } = prepareAgentEnv(cwd);
      this.currentEnv = env;
      await conn.start();

      let sessionId = opts.sessionId;
      let configOptions: AcpConfigOption[] = [];
      if (sessionId && conn.isLive(sessionId)) {
        configOptions = conn.getConfigOptions(sessionId) ?? [];
        // Already alive in this subprocess — prompt directly.
      } else if (sessionId) {
        try {
          configOptions = await conn.resumeSession(sessionId, cwd);
        } catch (err) {
          // Stale id (e.g. sessions carried over from a different agent
          // after a /config switch, or a wiped dsh home) — fall back to a
          // fresh session instead of failing the run. The system event
          // below persists the new id, so this heals itself.
          log.warn('agent', 'acp-resume-stale', {
            agent: this.id,
            sessionId,
            detail: err instanceof Error ? err.message : String(err),
          });
          sessionId = undefined;
          const created = await conn.newSession(cwd);
          sessionId = created.sessionId;
          configOptions = created.configOptions;
        }
      } else {
        const created = await conn.newSession(cwd);
        sessionId = created.sessionId;
        configOptions = created.configOptions;
      }
      state.sessionId = sessionId;
      // The channel persists this id for the chat — same contract as codex's
      // thread.started event.
      queue.push({ type: 'system', sessionId });
      if (state.stopRequested) {
        // /stop landed while provisioning/session setup was still running —
        // cancel whatever the server might have started and settle without
        // submitting the prompt.
        conn.cancel(sessionId);
        finish({ type: 'done', sessionId });
        return;
      }

      await this.applyConfigOptions(sessionId, configOptions, opts);

      const composed = buildBridgePrompt(opts.prompt, { larkCli });
      const stopReason = await conn.prompt(sessionId, [{ type: 'text', text: composed }], (update) => {
        for (const evt of translateAcpUpdate(update)) queue.push(evt);
      });
      finish({ type: 'done', sessionId });
      log.info('agent', 'acp-prompt-settled', { agent: this.id, stopReason });
    } catch (err) {
      finish({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Map /config's model + reasoning effort onto the session's ACP config
   * options. dsh exposes `model` (values are JSON "[provider, model]" ids)
   * and `reasoning_effort` (off/low/high/max) — verified by the spike.
   * Options come from the session's new/resume result; unknown values are
   * warned and ignored (the types.ts contract).
   */
  private async applyConfigOptions(
    sessionId: string,
    configOptions: AcpConfigOption[],
    opts: AgentRunOptions,
  ): Promise<void> {
    const conn = this.getConnection();
    if (opts.model) {
      const value = resolveModelValue(configOptions, opts.model);
      if (value !== undefined) await conn.setConfigOption(sessionId, 'model', value);
    }
    if (opts.reasoningEffort) {
      const effortGroup = configOptions.find((o) => o.id === 'reasoning_effort');
      const match = (effortGroup?.options ?? []).find((o) => o.value === opts.reasoningEffort);
      if (match?.value !== undefined) {
        await conn.setConfigOption(sessionId, 'reasoning_effort', match.value);
      } else {
        log.warn('agent', 'acp-effort-ignored', {
          agent: this.id,
          effort: opts.reasoningEffort,
          supported: (effortGroup?.options ?? []).map((o) => o.value),
        });
      }
    }
  }

  private decidePermission(): 'allow' | 'deny' {
    // Writes were explicitly authorized in /config for acceptEdits/bypass;
    // default/plan stay read-only. The dsh sandbox itself stays at the
    // profile default (workspace-write + ask) — see README.
    return this.permissionMode === 'acceptEdits' || this.permissionMode === 'bypassPermissions'
      ? 'allow'
      : 'deny';
  }

  private ensureProvisioned(): Promise<void> {
    if (this.provisioned) return Promise.resolve();
    this.provisioning ??= (async () => {
      if (await this.profileInstalledProbe()) {
        this.provisioned = true;
        return;
      }
      await this.provisionProfile();
      this.provisioned = true;
    })();
    return this.provisioning.finally(() => {
      this.provisioning = undefined;
    });
  }

  private getConnection(): AcpConnection {
    this.connection ??= new AcpConnection({
      agentId: this.id,
      spawn: () => this.spawnAcpChild(),
      decidePermission: () => this.decidePermission(),
      idleShutdownMs: this.idleShutdownMs ?? 10 * 60_000,
    });
    return this.connection;
  }

  private spawnAcpChild(): AcpSpawnResult {
    const cwd = workspaceRoot();
    const { env } = prepareAgentEnv(cwd);
    const child = this.spawnDsh([...ACP_PROFILE_ARGS], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (fn) => child.once('exit', () => fn()),
      kill: () => child.kill(),
      label: this.binary,
    };
  }
}

/**
 * ACP session/update → AgentEvent. usage_update is context occupancy
 * (used/size), not per-turn token usage — feeding it into the bridge's
 * usage stats would misreport, so it's dropped until dsh exposes real
 * per-turn usage over ACP.
 */
export function* translateAcpUpdate(update: AcpUpdate): Generator<AgentEvent> {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = blockText(update.content);
      if (text) yield { type: 'text', delta: text };
      return;
    }
    case 'agent_thought_chunk': {
      const text = blockText(update.content);
      if (text) yield { type: 'thinking', delta: text };
      return;
    }
    case 'tool_call': {
      if (typeof update.toolCallId === 'string') {
        yield {
          type: 'tool_use',
          id: update.toolCallId,
          name: typeof update.title === 'string' ? update.title : 'tool',
          input: update.rawInput ?? {},
        };
      }
      return;
    }
    case 'tool_call_update': {
      const status = typeof update.status === 'string' ? update.status : undefined;
      if (status !== 'completed' && status !== 'failed') return;
      if (typeof update.toolCallId !== 'string') return;
      yield {
        type: 'tool_result',
        id: update.toolCallId,
        output: toolCallContentText(update.content),
        isError: status === 'failed',
      };
      return;
    }
    default:
      return;
  }
}

function blockText(content: unknown): string {
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

/** Match /config's free-form model id against the ACP model option values ("[provider, model]" JSON ids). */
export function resolveModelValue(configOptions: AcpConfigOption[], model: string): unknown {
  const group = configOptions.find((o) => o.id === 'model');
  for (const groupEntry of group?.options ?? []) {
    for (const leaf of groupEntry.options ?? []) {
      if (!leaf.value) continue;
      try {
        const parsed = JSON.parse(leaf.value) as unknown;
        if (Array.isArray(parsed) && parsed.some((part) => part === model)) return leaf.value;
      } catch {
        /* non-JSON value shape — ignore */
      }
      if (leaf.name === model) return leaf.value;
    }
  }
  log.warn('agent', 'acp-model-ignored', { agent: 'dsh', model });
  return undefined;
}

/** ToolCallContent[] per dsh's ACP bridge: {type:'content', content:{type:'text',text}}. */
function toolCallContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (item && typeof item === 'object') {
        const inner = (item as { content?: unknown }).content ?? item;
        if (inner && typeof inner === 'object' && typeof (inner as { text?: unknown }).text === 'string') {
          return (inner as { text: string }).text;
        }
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Push/pull bridge between callback-driven ACP updates and a run's async iterator. */
class EventQueue implements AsyncIterable<AgentEvent> {
  private items: AgentEvent[] = [];
  private waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;
  readonly settled: Promise<boolean>;

  constructor() {
    this.settled = new Promise<boolean>((resolve) => {
      this.settle = resolve;
    });
  }

  private settle: (value: boolean) => void = () => {};

  push(evt: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: evt, done: false });
    else this.items.push(evt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    this.settle(true);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
