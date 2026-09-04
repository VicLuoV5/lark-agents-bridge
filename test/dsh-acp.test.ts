import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DshAdapter, resolveModelValue, translateAcpUpdate } from '../src/agent/dsh/adapter';
import type { AgentChild } from '../src/agent/proc';
import type { AgentEvent } from '../src/agent/types';

const CONFIG_OPTIONS = [
  {
    id: 'model',
    type: 'select',
    options: [
      {
        group: 'deepseek-official',
        options: [
          { value: '["deepseek-official","deepseek-v4-flash"]', name: 'DeepSeek-V4-Flash' },
          { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
        ],
      },
    ],
  },
  {
    id: 'reasoning_effort',
    type: 'select',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
      { value: 'max', name: 'Max' },
    ],
  },
];

type Frame = { jsonrpc: string; id?: number; method?: string; params?: any; result?: unknown };

/**
 * In-process fake ACP server: feeds the adapter's client over paired
 * streams, records inbound frames, and scripts prompt responses. Covers
 * the whole adapter stack (provisioning gate → connection → translation)
 * without spawning dsh.
 */
class FakeAcpServer {
  readonly child: AgentChild;
  readonly inbound: Frame[] = [];
  private nextId = 100;
  /** Updates emitted (and the stop reason) when the next session/prompt arrives. */
  promptScript: { updates: unknown[]; stopReason: string } = { updates: [], stopReason: 'end_turn' };
  /** When set, session/prompt is left unanswered until releasePrompt(). */
  holdPrompt = false;
  private heldPromptId: number | undefined;
  private pendingPromptSession: string | undefined;
  private out: PassThrough;
  private readonly events = new EventEmitter();
  private sessionIdCounter = 0;

  constructor() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = this.events;
    const child = {
      stdin,
      stdout,
      stderr,
      pid: 424242,
      once: emitter.once.bind(emitter),
      kill: () => emitter.emit('exit'),
      exitCode: null,
    } as unknown as AgentChild & EventEmitter;
    this.child = child;
    this.out = stdout;
    const rl = createInterface({ input: stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = JSON.parse(trimmed) as Frame;
      this.inbound.push(msg);
      this.handle(msg);
    });
  }

  private handle(msg: Frame): void {
    if (msg.id === undefined) {
      if (msg.method === 'session/cancel' && this.heldPromptId !== undefined) {
        // Cancel while held: settle the prompt with the cancelled reason.
        const id = this.heldPromptId;
        this.heldPromptId = undefined;
        this.respond(id, { stopReason: 'cancelled' });
      }
      return;
    }
    switch (msg.method) {
      case 'initialize':
        this.respond(msg.id, {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
          authMethods: [],
        });
        return;
      case 'session/new': {
        const sessionId = `sess-${++this.sessionIdCounter}`;
        this.respond(msg.id, { sessionId, configOptions: CONFIG_OPTIONS });
        return;
      }
      case 'session/resume':
        this.respond(msg.id, { configOptions: CONFIG_OPTIONS });
        return;
      case 'session/list':
        this.respond(msg.id, { sessions: [{ sessionId: 'sess-9', cwd: 'D:\\proj' }] });
        return;
      case 'session/set_config_option':
        this.respond(msg.id, {});
        return;
      case 'session/prompt': {
        this.pendingPromptSession = msg.params.sessionId as string;
        for (const update of this.promptScript.updates) {
          this.notify('session/update', { sessionId: this.pendingPromptSession, update });
        }
        if (this.holdPrompt) {
          this.heldPromptId = msg.id;
          return;
        }
        this.respond(msg.id, { stopReason: this.promptScript.stopReason });
        return;
      }
      default:
        this.respond(msg.id, { error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }

  private respond(id: number, body: unknown): void {
    const frame = body as { error?: unknown };
    this.out.write(
      `${JSON.stringify(frame && 'error' in frame ? { jsonrpc: '2.0', id, ...frame } : { jsonrpc: '2.0', id, result: body })}\n`,
    );
  }

  notify(method: string, params: unknown): void {
    this.out.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  releasePrompt(stopReason = 'end_turn'): void {
    if (this.heldPromptId === undefined) return;
    const id = this.heldPromptId;
    this.heldPromptId = undefined;
    this.respond(id, { stopReason });
  }

  /** Server→client request, e.g. session/request_permission. */
  request(method: string, params: unknown): void {
    this.out.write(`${JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params })}\n`);
  }

  kill(): void {
    this.events.emit('exit');
  }
}

function makeAdapter(server: FakeAcpServer, permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions') {
  return new DshAdapter({
    spawn: () => server.child,
    profileInstalled: async () => true,
    provision: async () => {},
    permissionMode,
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-acp-test-'));
  process.env.FEISHU_CODEX_WORKSPACE_ROOT = tmpRoot;
});

afterAll(() => {
  delete process.env.FEISHU_CODEX_WORKSPACE_ROOT;
});

describe('dsh adapter over a fake ACP server', () => {
  it('maps new-session prompt events to bridge events', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    server.promptScript = {
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想想' } },
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', rawInput: { command: 'ls' } },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] },
        { sessionUpdate: 'usage_update', used: 1000, size: 128000 },
      ],
      stopReason: 'end_turn',
    };
    const adapter = makeAdapter(server);
    const events = await collect(adapter.run({ prompt: 'hi' }).events);

    expect(events[0]).toMatchObject({ type: 'system', sessionId: 'sess-1' });
    expect(events).toContainEqual({ type: 'text', delta: '你好' });
    expect(events).toContainEqual({ type: 'thinking', delta: '想想' });
    expect(events).toContainEqual({ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } });
    expect(events).toContainEqual({ type: 'tool_result', id: 't1', output: 'a.txt', isError: false });
    // usage_update is context occupancy, not per-turn usage — dropped.
    expect(events.filter((e) => e.type === 'usage')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'sess-1' });
  });

  it('resumes a stored session id instead of creating a new one', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    const adapter = makeAdapter(server);
    await collect(adapter.run({ prompt: 'hi', sessionId: 'stored-1' }).events);
    const methods = server.inbound.map((f) => f.method);
    expect(methods).not.toContain('session/new');
    expect(methods).toContain('session/resume');
    const resume = server.inbound.find((f) => f.method === 'session/resume');
    expect(resume?.params).toMatchObject({ sessionId: 'stored-1' });
  });

  it('answers permission prompts per the bridge permission vocabulary', { timeout: 20_000 }, async () => {
    const permission = {
      sessionId: 'x',
      toolCall: { title: 'Write file' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    };

    const allowServer = new FakeAcpServer();
    allowServer.holdPrompt = true;
    const allowAdapter = makeAdapter(allowServer, 'acceptEdits');
    const runPromise = (async () => collect(allowAdapter.run({ prompt: 'hi' }).events))();
    await new Promise((r) => setTimeout(r, 100));
    allowServer.request('session/request_permission', permission);
    await new Promise((r) => setTimeout(r, 100));
    allowServer.releasePrompt('end_turn');
    await runPromise;
    const allowReplies = allowServer.inbound.filter((f) => f.result !== undefined && f.method === undefined);
    expect(JSON.stringify(allowReplies.at(-1) ?? null)).toContain('"selected"');
    expect(JSON.stringify(allowReplies.at(-1) ?? null)).toContain('allow-once');

    const denyServer = new FakeAcpServer();
    denyServer.holdPrompt = true;
    const denyAdapter = makeAdapter(denyServer, 'default');
    const denyPromise = (async () => collect(denyAdapter.run({ prompt: 'hi' }).events))();
    await new Promise((r) => setTimeout(r, 100));
    denyServer.request('session/request_permission', permission);
    await new Promise((r) => setTimeout(r, 100));
    denyServer.releasePrompt('end_turn');
    await denyPromise;
    const denyReplies = denyServer.inbound.filter((f) => f.result !== undefined && f.method === undefined);
    expect(JSON.stringify(denyReplies.at(-1) ?? null)).toContain('reject-once');
  });

  it('stop() cancels the in-flight prompt and settles with done', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    server.holdPrompt = true;
    const adapter = makeAdapter(server);
    const run = adapter.run({ prompt: 'long task' });
    const collected = collect(run.events);
    await new Promise((r) => setTimeout(r, 100));
    await run.stop();
    const events = await collected;
    expect(server.inbound.some((f) => f.method === 'session/cancel')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('reports an error event when the subprocess dies mid-prompt', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    server.holdPrompt = true;
    const adapter = makeAdapter(server);
    const events = await (async () => {
      const collected = collect(adapter.run({ prompt: 'hi' }).events);
      await new Promise((r) => setTimeout(r, 100));
      server.kill();
      return collected;
    })();
    expect(events.at(-1)?.type).toBe('error');
    expect((events.at(-1) as { message: string }).message).toContain('resume');
  });

  it('keeps a long-running prompt alive past the idle-shutdown window', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    server.holdPrompt = true;
    const adapter = new DshAdapter({
      spawn: () => server.child,
      profileInstalled: async () => true,
      provision: async () => {},
      idleShutdownMs: 100, // would reap the subprocess mid-prompt if armed
    });
    const collected = collect(adapter.run({ prompt: 'long task' }).events);
    await new Promise((r) => setTimeout(r, 400)); // 4× the idle window
    server.releasePrompt('end_turn');
    const events = await collected;
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('surfaces provisioning failures with the manual command hint', { timeout: 20_000 }, async () => {
    const adapter = new DshAdapter({
      spawn: () => new FakeAcpServer().child,
      profileInstalled: async () => false,
      provision: async () => {
        throw new Error('pnpm exploded');
      },
    });
    const events = await collect(adapter.run({ prompt: 'hi' }).events);
    expect(events.at(-1)?.type).toBe('error');
    expect((events.at(-1) as { message: string }).message).toContain('pnpm exploded');
  });

  it('lists resumable sessions filtered by cwd for /resume', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    const adapter = makeAdapter(server);
    const entries = await adapter.history.list('D:\\proj');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionId: 'sess-9', preview: '(dsh 会话)' });
    const other = await adapter.history.list('D:\\other');
    expect(other).toEqual([]);
  });

  it('applies model and reasoning_effort config options when they resolve', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    const adapter = makeAdapter(server);
    await collect(
      adapter.run({
        prompt: 'hi',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      }).events,
    );
    const sets = server.inbound.filter((f) => f.method === 'session/set_config_option');
    expect(sets).toHaveLength(2);
    expect(sets[0]?.params).toMatchObject({ configId: 'model', value: '["deepseek-official","deepseek-v4-pro"]' });
    expect(sets[1]?.params).toMatchObject({ configId: 'reasoning_effort', value: 'max' });
  });

  it('ignores unsupported reasoning effort values', { timeout: 20_000 }, async () => {
    const server = new FakeAcpServer();
    const adapter = makeAdapter(server);
    await collect(adapter.run({ prompt: 'hi', reasoningEffort: 'xhigh' }).events);
    expect(server.inbound.filter((f) => f.method === 'session/set_config_option')).toEqual([]);
  });
});

describe('resolveModelValue', () => {
  it('matches a model id inside the JSON "[provider, model]" option values', () => {
    expect(resolveModelValue(CONFIG_OPTIONS, 'deepseek-v4-pro')).toBe('["deepseek-official","deepseek-v4-pro"]');
  });

  it('returns undefined for unknown models', () => {
    expect(resolveModelValue(CONFIG_OPTIONS, 'gpt-99')).toBeUndefined();
  });
});

describe('translateAcpUpdate', () => {
  it('passes tool_call updates in progress through as tool_use only once', () => {
    const events = [...translateAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', rawInput: {} })];
    expect(events).toEqual([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]);
  });

  it('emits tool_result only for terminal statuses', () => {
    expect([...translateAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' })]).toEqual([]);
    const failed = [...translateAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'boom' } }] })];
    expect(failed).toEqual([{ type: 'tool_result', id: 't1', output: 'boom', isError: true }]);
  });
});
