import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { AcpJsonRpcClient } from './client';

/**
 * One long-lived ACP agent subprocess multiplexing every bridge session.
 * Unlike the spawn-per-run adapters, this connection survives between runs:
 * sessions created here stay live in the agent's memory, and after a
 * process restart `session/resume` restores them from disk (verified by the
 * 2026-09 spike — the first model request after a restart contained the
 * pre-restart conversation).
 */

export interface AcpSpawnResult {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  onExit: (listener: () => void) => void;
  kill: () => void;
  label: string;
}

export interface AcpSessionSummary {
  sessionId: string;
  cwd?: string;
}

export interface AcpConfigOption {
  id: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<{ value?: string; name?: string; options?: Array<{ value?: string; name?: string }> }>;
  [key: string]: unknown;
}

export type AcpUpdateListener = (update: AcpUpdate) => void;

export interface AcpUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpConnectionOptions {
  agentId: string;
  /** Start the agent subprocess; the connection owns its lifetime. */
  spawn: () => AcpSpawnResult;
  /** Answer server→client permission prompts (adapter policy). */
  decidePermission: (params: unknown) => 'allow' | 'deny';
  /** Kill the subprocess after this much idle time (0 = never). */
  idleShutdownMs?: number;
  /** stderr lines go here (defaults to the agent log). */
  onStderrLine?: (line: string) => void;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;

export class AcpConnection {
  private client: AcpJsonRpcClient | undefined;
  private starting: Promise<void> | undefined;
  private readonly live = new Set<string>();
  private readonly configBySession = new Map<string, AcpConfigOption[]>();
  private readonly promptListeners = new Map<string, AcpUpdateListener>();
  private readonly promptRejects = new Map<string, (error: Error) => void>();
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly onStderrLine: (line: string) => void;

  constructor(private readonly opts: AcpConnectionOptions) {
    this.onStderrLine = opts.onStderrLine ?? ((line) => log.warn('agent', 'stderr', { line }));
  }

  /** Start (or reuse) the subprocess and complete the ACP handshake. */
  async start(): Promise<void> {
    if (this.client && !this.client.isBroken) return;
    this.starting ??= this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async doStart(): Promise<void> {
    const child = this.opts.spawn();
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.trim()) this.onStderrLine(line);
      });
    }
    let brokenError: Error | undefined;
    const client = new AcpJsonRpcClient(child.stdin, child.stdout, {
      agentLabel: this.opts.agentId,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onServerRequest(method, params),
      onBroken: (error) => {
        brokenError = error;
        this.handleDeath(error);
      },
      requestTimeoutMs: 30_000,
    });
    child.onExit(() => client.break(brokenError ?? new Error(`${child.label} ACP process exited`)));
    this.client = client;

    await client.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    log.info('agent', 'acp-started', { agent: this.opts.agentId });
    this.armIdleTimer();
  }

  /** Whether the subprocess is alive and handshaken. */
  get isUp(): boolean {
    return this.client !== undefined && !this.client.isBroken;
  }

  /** Sessions created/resumed in the current subprocess lifetime. */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /** configOptions captured when the session was created/resumed. */
  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    return this.configBySession.get(sessionId);
  }

  async newSession(cwd: string): Promise<{ sessionId: string; configOptions: AcpConfigOption[] }> {
    await this.start();
    const result = await this.rpc<{ sessionId: string; configOptions?: AcpConfigOption[] }>('session/new', {
      cwd,
      mcpServers: [],
    });
    this.live.add(result.sessionId);
    this.configBySession.set(result.sessionId, result.configOptions ?? []);
    return { sessionId: result.sessionId, configOptions: result.configOptions ?? [] };
  }

  async resumeSession(sessionId: string, cwd: string): Promise<AcpConfigOption[]> {
    await this.start();
    const result = await this.rpc<{ configOptions?: AcpConfigOption[] }>('session/resume', {
      sessionId,
      cwd,
      mcpServers: [],
    });
    this.live.add(sessionId);
    this.configBySession.set(sessionId, result.configOptions ?? []);
    return result.configOptions ?? [];
  }

  async listSessions(): Promise<AcpSessionSummary[]> {
    await this.start();
    const result = await this.rpc<{ sessions?: AcpSessionSummary[] }>('session/list', {});
    return result.sessions ?? [];
  }

  /**
   * Apply a session config option (model / reasoning_effort). Values are
   * opaque ACP config ids — the adapter resolves them from configOptions.
   * Failures are logged and swallowed: config drift must not kill a run.
   */
  async setConfigOption(sessionId: string, configId: string, value: unknown): Promise<void> {
    try {
      await this.start();
      await this.rpc('session/set_config_option', { sessionId, configId, value });
    } catch (err) {
      log.warn('agent', 'acp-config-skipped', {
        agent: this.opts.agentId,
        configId,
        err: String(err),
      });
    }
  }

  /**
   * Submit one prompt. `onUpdate` receives every session/update for this
   * session until the prompt settles; resolves with the server's stop
   * reason ('end_turn' | 'cancelled' | 'max_tokens' | …). One prompt per
   * session at a time — the bridge enforces this per chat.
   */
  async prompt(sessionId: string, blocks: unknown[], onUpdate: AcpUpdateListener): Promise<string> {
    if (this.promptListeners.has(sessionId)) {
      throw new Error('a prompt is already in flight for this session');
    }
    await this.start();
    this.promptListeners.set(sessionId, onUpdate);
    const settled = new Promise<string>((resolve, reject) => {
      this.promptRejects.set(sessionId, reject);
      this.rpc<{ stopReason?: string }>('session/prompt', { sessionId, prompt: blocks }, 0)
        .then((result) => resolve(result.stopReason ?? 'end_turn'))
        .catch((err: Error) => reject(err));
    });
    try {
      return await settled;
    } finally {
      this.promptListeners.delete(sessionId);
      this.promptRejects.delete(sessionId);
      this.armIdleTimer();
    }
  }

  /** Interrupt the session's active prompt (maps to the bridge's /stop). */
  cancel(sessionId: string): void {
    this.client?.notify('session/cancel', { sessionId });
  }

  /** Tear the subprocess down now (tests, adapter disposal). */
  async shutdown(): Promise<void> {
    this.disarmIdleTimer();
    this.client?.break(new Error('acp connection shut down'));
    this.live.clear();
  }

  private rpc<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return this.client!.call<T>(method, params, timeoutMs);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const p = params as { sessionId?: string; update?: AcpUpdate } | undefined;
    const sessionId = p?.sessionId;
    const update = p?.update;
    if (!sessionId || !update) return;
    this.promptListeners.get(sessionId)?.(update);
  }

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      return this.answerPermission(params);
    }
    throw new Error(`unsupported ACP server request: ${method}`);
  }

  /**
   * Wire shape follows the standard ACP request_permission: options carry
   * kind allow_once/allow_always/reject_once… The dsh spike never triggered
   * one, so field names here are the standard's — re-verify against real
   * dsh output when an approval actually fires.
   */
  private answerPermission(params: unknown): unknown {
    const decision = this.opts.decidePermission(params);
    const p = params as {
      options?: Array<{ id?: string; optionId?: string; kind?: string }>;
    } | undefined;
    const options = p?.options ?? [];
    const wantedKind = decision === 'allow' ? 'allow' : 'reject';
    const picked =
      options.find((o) => (o.kind ?? '').startsWith(wantedKind)) ??
      (decision === 'allow' ? options[0] : undefined);
    const optionId = picked?.optionId ?? picked?.id;
    if (decision === 'allow' && optionId === undefined) {
      return { outcome: { outcome: 'cancelled' } };
    }
    return { outcome: { outcome: 'selected', optionId } };
  }

  private handleDeath(error: Error): void {
    this.live.clear();
    this.configBySession.clear();
    for (const [sessionId, reject] of this.promptRejects) {
      reject(new Error(`dsh ACP 进程退出，会话中断（下次消息会自动 resume）：${error.message}`));
      this.promptListeners.delete(sessionId);
    }
    this.promptRejects.clear();
    this.disarmIdleTimer();
    log.warn('agent', 'acp-exited', { agent: this.opts.agentId, detail: error.message });
  }

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    const ms = this.opts.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    if (ms <= 0) return;
    this.idleTimer = setTimeout(() => {
      log.info('agent', 'acp-idle-shutdown', { agent: this.opts.agentId, idleMs: ms });
      void this.shutdown();
    }, ms);
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
