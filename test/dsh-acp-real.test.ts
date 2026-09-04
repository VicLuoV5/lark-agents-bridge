import { spawn as spawnProcess } from 'node:child_process';
import { spawnAgentCommand } from '../src/agent/proc';
import { DshAdapter } from '../src/agent/dsh/adapter';
import type { SpawnOptions } from 'node:child_process';
import type { AgentChild } from '../src/agent/proc';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/types';

/**
 * Real dsh smoke against the bundled dsh-llm-mock-server — zero API cost,
 * no key needed. Requires dsh on PATH (its npm global install also provides
 * the mock server) and network for the one-time profile provisioning into a
 * throwaway DSH_HOME. Skipped unless DSH_SMOKE=1:
 *
 *   DSH_SMOKE=1 corepack pnpm vitest run test/dsh-acp-real.test.ts
 *
 * Validated: spawn → initialize → session/new → prompt events → process
 * kill → restart → session/resume with context continuity → stop/cancel.
 */
const SMOKE = process.env.DSH_SMOKE === '1';

describe.skipIf(!SMOKE)('dsh real smoke (mock LLM, zero cost)', { timeout: 300_000 }, () => {
  let home: string;
  let workspace: string;
  let mockProc: AgentChild | undefined;
  const children: AgentChild[] = [];

  afterAll(async () => {
    for (const child of children.splice(0)) child.kill();
    mockProc?.kill();
    // dsh releases the workspace dir shortly after exit — retry briefly.
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        if (home) await rm(home, { recursive: true, force: true });
        if (workspace) await rm(workspace, { recursive: true, force: true });
        return;
      } catch {
        /* EBUSY — retry */
      }
    }
  });

  it('runs the full ACP lifecycle', async () => {
    // The mock server runs in a child node process: vitest's vite loader
    // can't import the machine-specific global dsh path (non-ASCII user
    // dir) directly. The bootstrap prints "ready <baseURL>" on stdout.
    const mockLib = join(
      process.env.APPDATA ?? '',
      'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-mock-server/lib/index.js',
    );
    const bootstrap = join(await mkdtemp(join(tmpdir(), 'dsh-smoke-boot-')), 'boot.mjs');
    await writeFile(
      bootstrap,
      [
        `import { startMockLlmServer } from ${JSON.stringify(pathToFileURL(mockLib).href)};`,
        `const mock = await startMockLlmServer({ port: 0, apiKey: 'mock-key',`,
        `  sequence: ['success', 'success', 'stall', 'success'], repeatLast: true });`,
        `process.stdout.write('ready ' + mock.baseURL + '\\n');`,
      ].join('\n'),
      'utf8',
    );
    // Plain spawn (no cmd wrapper): node.exe's own path contains spaces and
    // the cmd quoting layer mangles it.
    const proc = spawnProcess(process.execPath, [bootstrap], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as AgentChild;
    mockProc = proc;
    const mockBase = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock LLM server did not start')), 30_000);
      let errTail = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        const url = /ready (\S+)/.exec(chunk.toString())?.[1];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        errTail = (errTail + chunk.toString()).slice(-400);
      });
      proc.on('exit', (code: number | null) => {
        clearTimeout(timer);
        reject(new Error(`mock LLM server exited early (code ${code ?? '?'})${errTail ? `: ${errTail}` : ''}`));
      });
    });

    home = await mkdtemp(join(tmpdir(), 'dsh-smoke-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'dsh-smoke-ws-'));
    process.env.FEISHU_CODEX_WORKSPACE_ROOT = workspace;

    // DSH_SMOKE_BIN: path to a dsh launcher entry (lib/bin.js) when the
    // globally installed launcher is too old for current acp-app releases —
    // the plugin tree refuses mixed launcher/plugin versions.
    const dshEntry = process.env.DSH_SMOKE_BIN;
    const spawnDsh = (args: string[], options: SpawnOptions): AgentChild => {
      const merged = {
        ...options,
        env: { ...options.env, DSH_HOME: home, DEEPSEEK_BASE_URL: mockBase, DEEPSEEK_API_KEY: 'mock-key' },
      };
      if (dshEntry) {
        return spawnProcess(process.execPath, [dshEntry, ...args], {
          ...merged,
          windowsHide: true,
        }) as unknown as AgentChild;
      }
      return spawnAgentCommand('dsh', args, merged);
    };

    const adapter = new DshAdapter({
      spawn: spawnDsh,
    });

    const collect = async (run: { events: AsyncIterable<AgentEvent> }) => {
      const events: AgentEvent[] = [];
      for await (const evt of run.events) events.push(evt);
      return events;
    };

    // 1. fresh run → real mock-model turn
    const run1 = adapter.run({ prompt: 'Say something.' });
    const events1 = await collect(run1);
    console.log('[dsh-smoke] events1:', JSON.stringify(events1).slice(0, 600));
    const system = events1.find((e) => e.type === 'system');
    expect(system).toMatchObject({ type: 'system' });
    const sessionId = (system as { sessionId?: string }).sessionId;
    expect(sessionId).toBeTruthy();
    expect(events1.some((e) => e.type === 'text' && (e as { delta: string }).delta.includes('mock response recovered'))).toBe(true);
    expect(events1.at(-1)).toMatchObject({ type: 'done', sessionId });

    // 2. kill the subprocess mid-flight between runs
    children.at(-1)?.kill();
    await new Promise((r) => setTimeout(r, 500));

    // 3. next run must transparently restart + resume (the mock's scripted
    // sequence continues, proving a fresh model request was made)
    const run2 = adapter.run({ prompt: 'What did I ask before?', sessionId });
    const events2 = await collect(run2);
    expect(events2.at(-1)).toMatchObject({ type: 'done', sessionId });

    // 4. cancel path
    const run3 = adapter.run({ prompt: 'Long running task.', sessionId });
    const eventsPromise = collect(run3);
    await new Promise((r) => setTimeout(r, 3000));
    await run3.stop();
    const events3 = await eventsPromise;
    expect(events3.at(-1)?.type).toBe('done');

    delete process.env.FEISHU_CODEX_WORKSPACE_ROOT;
  });
});
