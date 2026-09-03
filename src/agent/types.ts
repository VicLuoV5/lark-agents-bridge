import type { AgentPermissionMode } from '../config/schema';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  /**
   * Opaque reasoning-effort knob. The vocabulary is adapter-specific (Codex:
   * minimal/low/medium/high/xhigh; dsh: off/low/high/max; ...) — each adapter
   * validates and ignores (with a warning) values it doesn't understand.
   */
  reasoningEffort?: string;
  permissionMode?: AgentPermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
   */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before the agent has actually closed
   * stdout; there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/** One entry of an adapter's resumable-session history (for /resume). */
export interface AgentHistoryEntry {
  sessionId: string;
  mtime: number;
  preview: string;
  lineCount: number;
}

/**
 * Optional per-adapter session-history capability. Adapters whose CLI can
 * list resumable sessions for a cwd (Codex: ~/.codex jsonl) implement this;
 * the /resume command hides itself when the active adapter doesn't.
 */
export interface AgentHistory {
  list(cwd: string, limit?: number): Promise<AgentHistoryEntry[]>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  run(opts: AgentRunOptions): AgentRun;
  /** Absent = the adapter has no resumable-session listing (/resume hidden). */
  readonly history?: AgentHistory;
}
