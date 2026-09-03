import type { ChildProcessByStdio } from 'node:child_process';
import { spawn, type SpawnOptions } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { log } from '../core/logger';
import { withWindowsNpmGlobalBin } from '../runtime/path-env';

export type AgentChild = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Spawn an agent CLI. On Windows the bin is usually an npm `.cmd` shim that
 * Node can't spawn directly — route through cmd.exe with manual quoting
 * (cmd's argument parser differs from MSVCRT; escape its metacharacters).
 */
export function spawnAgentCommand(
  binary: string,
  args: string[],
  options: SpawnOptions,
): AgentChild {
  if (process.platform !== 'win32') {
    return spawn(binary, args, options) as AgentChild;
  }
  const command = [binary, ...args].map(quoteCmdArg).join(' ');
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    ...options,
    windowsHide: true,
  }) as AgentChild;
}

function quoteCmdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["^&|<>()%])/g, '^$1')}"`;
}

/**
 * Availability probe: run `<binary> --version` with the Windows npm-global
 * PATH patch and report whether it exited 0.
 */
export function probeAgentVersion(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnAgentCommand(binary, ['--version'], {
      env: withWindowsNpmGlobalBin({ ...process.env }),
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Resolve the real JS entry behind an npm global shim on Windows
 * (`%APPDATA%\npm\kimi.cmd` → `%APPDATA%\npm\node_modules\...\main.mjs`).
 * Spawning `node <entry>` directly skips the cmd.exe layer entirely, which
 * matters when argv carries arbitrary text (a prompt with quotes, `&`,
 * unicode — cmd quoting cannot survive those). Returns undefined when the
 * shim is missing or unparseable; callers then fall back to the cmd
 * wrapper.
 */
export async function resolveWindowsNodeEntry(binary: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const appData = process.env.APPDATA;
  if (!appData) return undefined;
  const shimDir = join(appData, 'npm');
  let text: string;
  try {
    text = await readFile(join(shimDir, `${binary}.cmd`), 'utf8');
  } catch {
    return undefined;
  }
  const m = /"([^"]+\.(?:mjs|cjs|js))"\s+%(\*)?/.exec(text);
  const raw = m?.[1];
  if (!raw) return undefined;
  // Shims reference the entry relative to their own directory (%dp0% /
  // %~dp0, including a trailing separator).
  return raw.replace(/%(?:~)?dp0%/g, `${shimDir}\\`);
}

/** Spawn a resolved JS entry with node — no cmd.exe in the picture. */
export function spawnNodeEntry(
  entry: string,
  args: string[],
  options: SpawnOptions,
): AgentChild {
  return spawn(process.execPath, [entry, ...args], {
    ...options,
    windowsHide: process.platform === 'win32',
  }) as AgentChild;
}

/** SIGTERM → wait graceMs → SIGKILL. Resolves once the child is (being) reaped. */
export async function stopChild(child: AgentChild, graceMs: number, agentId: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  log.info('agent', 'stop-sigterm', { agent: agentId, pid: child.pid ?? null, graceMs });
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.warn('agent', 'stop-sigkill', {
          agent: agentId,
          pid: child.pid ?? null,
          graceMs,
          reason: 'grace-period-expired',
        });
        child.kill('SIGKILL');
      }
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Wait up to `timeoutMs` for the child to exit on its own. Resolves true if
 * it exited within the window, false if the timer fired first (caller usually
 * wants to fall back to stop()). See AgentRun.waitForExit for why callers
 * wait out the post-terminal-event tail instead of SIGTERMing immediately.
 */
export function waitForChildExit(child: AgentChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
