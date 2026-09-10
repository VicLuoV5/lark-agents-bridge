import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { withWindowsNpmGlobalBin } from './path-env';
import { ensureLarkCliShim } from './lark-cli-shim';

const PROFILE_TIMEOUT_MS = 30_000;

export interface LarkCliProfileInput {
  workspace: string;
  profile: string;
  appId: string;
  appSecret: string;
  tenant: 'feishu' | 'lark';
}

export interface LarkCliProfileResult {
  configured: boolean;
  reason?: string;
}

/**
 * Build the command accepted by lark-cli 1.0.x. `config init --name` creates
 * or updates that named profile; unlike `config bind`, it does not replace
 * the CLI's single workspace binding.
 */
export function profileInitArgs(input: Pick<LarkCliProfileInput, 'profile' | 'appId' | 'tenant'>): string[] {
  return [
    'config',
    'init',
    '--name', input.profile,
    '--app-id', input.appId,
    '--app-secret-stdin',
    '--brand', input.tenant,
  ];
}

/**
 * Provision the named profile used by child agents. The bot itself uses the
 * SDK and remains available when lark-cli is absent or misconfigured.
 */
export async function ensureLarkCliProfile(input: LarkCliProfileInput): Promise<LarkCliProfileResult> {
  const shim = ensureLarkCliShim(input.workspace);
  // The .cmd wrapper is ideal for an interactive agent's PATH, but cmd.exe
  // quote handling around an absolute path is brittle when we also need to
  // pipe the secret. Provisioning owns the process, so use the copied .exe
  // directly on Windows.
  const executable = shim && process.platform === 'win32'
    ? join(shim.toolsDir, 'lark-cli.exe')
    : (shim?.commandPath ?? 'lark-cli');
  const result = await runWithSecret(executable, profileInitArgs(input), input.appSecret);
  return result.ok
    ? { configured: true }
    : { configured: false, reason: result.reason };
}

async function runWithSecret(
  executable: string,
  args: string[],
  secret: string,
): Promise<{ ok: boolean; reason?: string }> {
  const command = commandFor(executable, args);
  return new Promise((resolve) => {
    let output = '';
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (value: { ok: boolean; reason?: string }): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(command.cmd, command.args, {
        env: withWindowsNpmGlobalBin({ ...process.env }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32',
      });
    } catch (err) {
      resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', (err) => done({ ok: false, reason: err.message }));
    child.once('exit', (code) => {
      if (code === 0) done({ ok: true });
      else done({ ok: false, reason: conciseOutput(output) ?? `exit ${code ?? 'unknown'}` });
    });
    child.stdin?.end(`${secret}\n`);
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ ok: false, reason: 'timed out' });
    }, PROFILE_TIMEOUT_MS);
  });
}

function conciseOutput(output: string): string | undefined {
  const oneLine = output.replace(/[\r\n]+/g, ' ').trim();
  return oneLine ? oneLine.slice(0, 240) : undefined;
}

function commandFor(executable: string, args: string[]): { cmd: string; args: string[] } {
  if (process.platform !== 'win32' || !executable.toLowerCase().endsWith('.cmd')) {
    return { cmd: executable, args };
  }
  const command = [executable, ...args].map(quoteCmdArg).join(' ');
  return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
}

function quoteCmdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["^&|<>()%])/g, '^$1')}"`;
}
