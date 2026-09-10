import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../config/paths';

/**
 * Logical service name — used as the launchd label AND as the systemd
 * unit name. Single-instance for now; if we ever support multiple bots
 * per machine the suffix can grow `.{appid}` without breaking installs.
 */
export const SERVICE_NAME = 'feishu-codex-bridge.bot';

// === macOS launchd ===

export const LAUNCH_AGENT_LABEL = `ai.${SERVICE_NAME}`;

/**
 * macOS convention: user LaunchAgents under `~/Library/LaunchAgents/`.
 * launchd discovers plists only from a few well-known paths.
 */
export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

// === Linux systemd (user units) ===

export const SYSTEMD_UNIT_NAME = `${SERVICE_NAME}.service`;

/**
 * Linux convention: user systemd units under
 * `$XDG_CONFIG_HOME/systemd/user/`, defaulting to
 * `~/.config/systemd/user/` when XDG_CONFIG_HOME isn't set.
 */
export function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

// === Windows Task Scheduler ===

/**
 * schtasks task name. Backslashes turn into Task Scheduler "folders" so
 * `FeishuCodexBridge\Bot` would create a Bot task under a FeishuCodexBridge
 * folder. We keep it flat for now.
 */
export const WINDOWS_TASK_NAME = 'FeishuCodexBridge.Bot';

/**
 * The wrapper .cmd script schtasks invokes. schtasks `/TR` accepts a
 * command line directly, but we want stdout/stderr redirection + a PATH
 * override, which means wrapping in a script.
 */
export function windowsLauncherCmdPath(): string {
  return join(paths.appDir, 'daemon-launcher.cmd');
}

/** Hidden-window VBS wrapper handed to the scheduled task (UTF-16 written). */
export function windowsLauncherVbsPath(): string {
  return join(paths.appDir, 'daemon-launcher.vbs');
}

/** Register-ScheduledTask script executed by the service installer. */
export function windowsInstallPs1Path(): string {
  return join(paths.appDir, 'daemon-install.ps1');
}

// === Daemon log paths (platform-agnostic) ===

/**
 * Daemon stdout/stderr go alongside the bridge's own structured logs in
 * `~/.feishu-codex-bridge/logs/` so users only need to remember one path. Filenames
 * are `daemon-*` to keep them distinct from the rolling per-day JSON files.
 */
export function daemonLogDir(): string {
  return join(paths.appDir, 'logs');
}

export function daemonStdoutPath(): string {
  return join(daemonLogDir(), 'daemon-stdout.log');
}

export function daemonStderrPath(): string {
  return join(daemonLogDir(), 'daemon-stderr.log');
}
