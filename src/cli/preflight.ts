import { spawn, spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { withWindowsNpmGlobalBin } from '../runtime/path-env';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const MANUAL_INSTALL_HINT = [
  '手动安装命令:',
  `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
  'Bridge 会在下次启动时为当前 Bot 自动创建独立的 lark-cli Profile。',
  '',
  '完整文档: https://github.com/larksuite/cli',
].join('\n');

export interface PreFlightOptions {
  /** Skip lark-cli auto-install check. */
  skipCheckLarkCli?: boolean;
  // Future: skipCheckXxx?: boolean;
}

export async function preFlightChecks(opts: PreFlightOptions): Promise<void> {
  await checkLarkCli(opts);
  // Future: await checkXxx(opts);
}

async function checkLarkCli(opts: PreFlightOptions): Promise<void> {
  if (opts.skipCheckLarkCli) return;
  if (isLarkCliInstalled()) return;

  console.log(
    [
      '',
      'ℹ️  lark-cli 未安装',
      '',
      'lark-cli 是飞书的命令行工具,装上后 Codex 可以:',
      '  • 主动发送交互卡片 / 表单',
      '  • 查询日历、文档、待办、OKR、考勤',
      '  • 200+ 飞书 API 命令',
      '',
    ].join('\n'),
  );

  // Non-TTY (daemon / launchd / nohup / CI): don't auto-install — users
  // running headless typically don't expect a long network install to fire
  // under them. Print manual hint and continue startup.
  if (!process.stdin.isTTY) {
    console.log(`(非交互模式,跳过自动安装)\n\n${MANUAL_INSTALL_HINT}\n`);
    return;
  }

  p.intro('Setting up lark-cli');

  // Step 1: install
  const sInstall = p.spinner();
  sInstall.start('Installing lark-cli');
  const installResult = await runCapture(
    'npm',
    ['install', '-g', '@larksuite/cli'],
    INSTALL_TIMEOUT_MS,
  );
  if (!installResult.success || !isLarkCliInstalled()) {
    sInstall.error('Install failed');
    if (installResult.output.trim()) {
      console.error(installResult.output);
    }
    p.outro('lark-cli 安装未完成');
    printInstallFailedWarning();
    return;
  }
  sInstall.stop('Installed');

  p.outro('Installed. Bridge will provision the current Bot profile on startup.');
}

function printInstallFailedWarning(): void {
  console.error(
    [
      '',
      `${BOLD}╔════════════════════════════════════════════════════════════════╗${RESET}`,
      `${BOLD}║  ⚠️  lark-cli 自动安装失败                                     ║${RESET}`,
      `${BOLD}╚════════════════════════════════════════════════════════════════╝${RESET}`,
      '',
      '原因可能是:网络不通 / npm 全局安装无权限 / registry 异常',
      '',
      'Bridge 仍会继续启动,但 Codex 工具调用会受限。',
      '请手动执行:',
      '',
      `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
      'Bridge 会在下次启动时为当前 Bot 自动创建独立的 lark-cli Profile。',
      '',
      '完整文档: https://github.com/larksuite/cli',
      '安装后请重启 bridge，让它为当前 Bot 创建独立 Profile。',
      '',
    ].join('\n'),
  );
}

function isLarkCliInstalled(): boolean {
  try {
    const command = commandFor('lark-cli', ['--version']);
    const result = spawnSync(command.cmd, command.args, {
      env: withWindowsNpmGlobalBin({ ...process.env }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

interface RunResult {
  success: boolean;
  /** Captured stdout + stderr from the child. Useful only on failure. */
  output: string;
}

/**
 * Run a child process, capture stdout/stderr to a buffer (keeps the
 * surrounding clack spinner UI clean), enforce a timeout. Used for the
 * npm install step in the preflight check.
 */
async function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  const onWindows = process.platform === 'win32';
  let captured = '';
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve) => {
    const command = commandFor(cmd, args);
    const child = spawn(command.cmd, command.args, {
      env: withWindowsNpmGlobalBin({ ...process.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: onWindows,
    });
    child.stdout?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return { success: !timedOut && exitCode === 0, output: captured };
}

function commandFor(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (process.platform !== 'win32') return { cmd, args };
  const command = [cmd, ...args].map(quoteCmdArg).join(' ');
  return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
}

function quoteCmdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["^&|<>()%])/g, '^$1')}"`;
}
