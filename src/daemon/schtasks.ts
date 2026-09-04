import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  WINDOWS_TASK_NAME,
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsLauncherCmdPath,
} from './paths';

export interface LauncherInputs {
  /** Absolute path to node.exe. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry. */
  bridgeEntryPath: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  /**
   * Directory the daemon should run in — baked as a `cd /d` so the
   * bridge's default workspace root follows the dir `start` was run from,
   * not Task Scheduler's System32 default.
   */
  workingDir?: string;
}

/**
 * Generate the .cmd wrapper script that the scheduled task actually invokes.
 *
 * schtasks `/TR` can accept a direct command, but we need stdout/stderr
 * redirection + a PATH override so child tools (lark-cli, codex) resolve
 * correctly when the daemon runs under Task Scheduler. A `.cmd` script
 * is the natural place for both.
 *
 * `@echo off` keeps the script's own commands out of the daemon log.
 * `>>` / `2>>` append (not truncate) so log history is preserved across
 * daemon restarts.
 */
export function buildLauncherCmd(inputs: LauncherInputs): string {
  return [
    // cmd parses batch files in the OEM codepage (GBK on zh-CN systems).
    // The baked PATH and log paths contain the user profile — Chinese
    // usernames make those lines non-ASCII, and under GBK every redirect
    // to them fails with "系统找不到指定的路径". Switching the console to
    // UTF-8 first makes cmd read the rest of the file correctly (verified
    // empirically on Windows 11, 2026-09).
    'chcp 65001 >nul',
    '@echo off',
    ...(inputs.workingDir ? [`cd /d "${inputs.workingDir}"`] : []),
    `set "PATH=${inputs.envPath}"`,
    'if exist "%APPDATA%\\npm" set "PATH=%APPDATA%\\npm;%PATH%"',
    'set "BRIDGE_WATCHDOG_SECONDS=60"',
    ':watchdog',
    `>> "${daemonStdoutPath()}" echo [bridge-watchdog] starting bridge %DATE% %TIME%`,
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" run >> "${daemonStdoutPath()}" 2>> "${daemonStderrPath()}"`,
    'set "BRIDGE_EXIT_CODE=%ERRORLEVEL%"',
    'if "%BRIDGE_EXIT_CODE%"=="0" exit /b 0',
    `>> "${daemonStdoutPath()}" echo [bridge-watchdog] bridge exited with code %BRIDGE_EXIT_CODE%, restart in %BRIDGE_WATCHDOG_SECONDS% seconds`,
    'timeout /t 60 /nobreak >nul',
    'goto watchdog',
    '',
  ].join('\r\n');
}

async function writeLauncherCmd(): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    workingDir: process.cwd(),
  });
  const cmdPath = windowsLauncherCmdPath();
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(), { recursive: true });
  await writeFile(cmdPath, content, 'utf8');
}

interface SchtasksResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

/**
 * Windows console tools emit text in the ANSI codepage (GBK on zh-CN
 * systems), not UTF-8. Decode as UTF-8 first; replacement characters mean
 * we guessed wrong — retry with GBK.
 */
export function decodeConsoleOutput(buf: Buffer | undefined): string {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

function runSchtasks(args: string[]): SchtasksResult {
  const r = spawnSync('schtasks', args, { encoding: 'buffer' });
  return {
    ok: r.status === 0,
    stderr: decodeConsoleOutput(r.stderr),
    stdout: decodeConsoleOutput(r.stdout),
  };
}

/** Build the Register-ScheduledTask command for one launcher path. */
export function buildInstallCommand(launcherPath: string): string {
  const esc = (s: string): string => s.replace(/'/g, "''");
  return [
    'Register-ScheduledTask',
    `-TaskName '${esc(WINDOWS_TASK_NAME)}'`,
    '-Trigger (New-ScheduledTaskTrigger -AtLogOn)',
    `-Action (New-ScheduledTaskAction -Execute '${esc(launcherPath)}')`,
    '-Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable ' +
      '-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries ' +
      '-ExecutionTimeLimit ([TimeSpan]::Zero))',
    "-Description 'feishu-codex-bridge daemon: auto-start at logon with watchdog restart'",
    '-Force',
  ].join(' ');
}

const ACCESS_DENIED_RE = /0x80070005|拒绝访问|access is denied|access denied/i;

export const ELEVATION_GUIDANCE =
  '\n\n这台机器注册登录任务需要一次管理员权限（UAC 限制，两条注册通道都会被拒）。' +
  '一次性解决：右键 PowerShell「以管理员身份运行」→ 进入本项目目录 → 再执行一次 `start`。' +
  '注册成功后不再需要管理员——开机自启、崩溃自愈全自动。';

/** Append elevation guidance when both registration paths were denied. */
export function withAccessDeniedGuidance(r: SchtasksResult): SchtasksResult {
  if (r.ok || !ACCESS_DENIED_RE.test(r.stderr + r.stdout)) return r;
  return { ...r, stderr: r.stderr + ELEVATION_GUIDANCE };
}

/**
 * Register the logon task WITHOUT admin rights. `schtasks /SC ONLOGON`
 * requires an elevated console on modern Windows (拒绝访问 for normal
 * users), but the ScheduledTasks module registers per-user logon tasks
 * freely — and handles non-ASCII paths correctly. The task settings also
 * clear the default 72-hour execution limit (the launcher's watchdog loop
 * is meant to run indefinitely) and allow battery-powered starts.
 */
function installTaskViaPowerShell(): SchtasksResult {
  const ps = buildInstallCommand(windowsLauncherCmdPath());
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'buffer',
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    stderr: decodeConsoleOutput(r.stderr),
    stdout: decodeConsoleOutput(r.stdout),
  };
}

/**
 * Create (or overwrite) the logon task. Primary path: Register-ScheduledTask
 * (no elevation needed). Fallback: the legacy `schtasks /SC ONLOGON` for
 * environments where the ScheduledTasks module is unavailable (that path
 * needs an elevated console). If both fail, surface the PowerShell error —
 * it's the path modern machines should be able to use.
 */
export async function installTask(): Promise<SchtasksResult> {
  await writeLauncherCmd();
  const viaPowerShell = installTaskViaPowerShell();
  if (viaPowerShell.ok) return viaPowerShell;
  const legacy = runSchtasks([
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    WINDOWS_TASK_NAME,
    '/TR',
    `"${windowsLauncherCmdPath()}"`,
  ]);
  return withAccessDeniedGuidance(legacy.ok ? legacy : viaPowerShell);
}

/** Start the task now (regardless of trigger). */
export function runTask(): SchtasksResult {
  return runSchtasks(['/Run', '/TN', WINDOWS_TASK_NAME]);
}

/** End the running instance. Task stays registered for next logon. */
export function endTask(): SchtasksResult {
  return runSchtasks(['/End', '/TN', WINDOWS_TASK_NAME]);
}

/** Disable autostart (task stays registered but ONLOGON trigger won't fire). */
export function disableTask(): SchtasksResult {
  return runSchtasks(['/Change', '/TN', WINDOWS_TASK_NAME, '/Disable']);
}

/** Re-enable autostart. Called from installTask is unnecessary — /Create /F
 * resets the enabled flag. Only needed if you Disabled and want it back. */
export function enableTask(): SchtasksResult {
  return runSchtasks(['/Change', '/TN', WINDOWS_TASK_NAME, '/Enable']);
}

/** End + disable. The cross-platform "stop = stay stopped" semantic. */
export function endAndDisable(): SchtasksResult {
  const ended = endTask();
  // If the task wasn't running, /End fails; we still want to disable.
  const disabled = disableTask();
  // Surface whichever signal is more informative — disable result wins
  // because the autostart prevention is the user-visible effect.
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

/** Schtasks has no native restart — end, wait, run. */
export async function restartTask(): Promise<SchtasksResult> {
  endTask(); // best-effort; ignore if not running
  await waitUntilStopped();
  return runTask();
}

/**
 * `schtasks /Query` returns 0 iff the task is registered. We toss the
 * output (it's verbose); use describeTask for full state.
 */
export function isTaskRegistered(): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * Parse `/Query /V /FO LIST` output for the current run state. Looks for
 * `Status: Running` in the verbose listing. Other states include
 * "Ready" (registered, not currently running) and "Disabled".
 */
export function isTaskRunning(): boolean {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', WINDOWS_TASK_NAME]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}

export function describeTask(): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', WINDOWS_TASK_NAME]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]);
  // Remove the launcher script too; best-effort.
  if (existsSync(windowsLauncherCmdPath())) {
    await rm(windowsLauncherCmdPath(), { force: true });
  }
  return r;
}
