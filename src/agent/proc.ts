import type { ChildProcessByStdio } from 'node:child_process';
import { spawn, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { log } from '../core/logger';

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
