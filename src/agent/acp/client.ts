import { createInterface, type Interface } from 'node:readline';
import type { Writable, Readable } from 'node:stream';
import { log } from '../../core/logger';

/**
 * Minimal newline-delimited JSON-RPC 2.0 client over an ACP agent's stdio.
 * Hand-rolled (no @agentclientprotocol/sdk dependency): the bridge needs
 * request/response correlation, notifications, and server→client requests
 * (session/request_permission) — nothing more. Wire shapes verified against
 * dsh --profile acp (see spike, 2026-09).
 */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface AcpClientOptions {
  /** Who this client talks to — used in logs/errors. */
  agentLabel: string;
  onNotification: (method: string, params: unknown) => void;
  /** Server→client request; the returned value becomes the JSON-RPC result. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** Called once when the transport breaks or the child exits. */
  onBroken: (error: Error) => void;
  /** Default timeout for control-plane calls (not prompts — those live as long as the turn). */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class AcpJsonRpcClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private broken = false;
  private readonly rl: Interface;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly opts: AcpClientOptions,
  ) {
    this.rl = createInterface({ input: stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.onLine(line));
    this.rl.on('close', () => this.break(new Error(`${opts.agentLabel} ACP stream closed`)));
  }

  /** Send a request and await its response. timeoutMs 0 = no timeout. */
  call<T = unknown>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 30_000): Promise<T> {
    if (this.broken) {
      return Promise.reject(new Error(`${this.opts.agentLabel} ACP client is closed`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: (v) => resolve(v as T), reject, timer: undefined };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.opts.agentLabel} ACP request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Fire-and-forget notification (session/cancel). */
  notify(method: string, params: unknown): void {
    if (this.broken) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Reject every in-flight request (process death). Idempotent. */
  break(error: Error): void {
    if (this.broken) return;
    this.broken = true;
    this.rl.close();
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.opts.onBroken(error);
  }

  get isBroken(): boolean {
    return this.broken;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      jsonrpc?: string;
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: JsonRpcError;
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Non-JSON stdout noise (e.g. a user plugin) — skip, like the JSONL pump.
      log.warn('agent', 'acp-unparsed', { agent: this.opts.agentLabel, line: trimmed.slice(0, 200) });
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // Server→client request: answer it, never throw into the readline loop.
      this.opts
        .onRequest(msg.method, msg.params)
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }))
        .catch((err: Error) =>
          this.write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: err.message },
          }),
        );
      return;
    }
    if (msg.method !== undefined) {
      this.opts.onNotification(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        pending.reject(new Error(`${msg.error.message ?? 'ACP request failed'} (code ${msg.error.code})`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private write(frame: object): void {
    if (this.broken) return;
    this.stdin.write(`${JSON.stringify(frame)}\n`);
  }
}
