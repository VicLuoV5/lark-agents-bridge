import dns from 'node:dns';
import { createInterface } from 'node:readline';
import pkg from '../../../package.json';
import { select } from '@clack/prompts';
import { knownAgentTypes, resolveAgent, type AgentCreateOptions } from '../../agent/registry';
import { startChannel, type BridgeChannel } from '../../bot/channel';
import { runRegistrationWizard } from '../../bot/wizard';
import type { Controls } from '../../commands';
import { setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import type { AppConfig } from '../../config/schema';
import {
  activeAccountProfile,
  ensureAccountProfiles,
  getAgentPermissionMode,
  getAgentProvider,
  getAgentType,
  isComplete,
  secretKeyForApp,
} from '../../config/schema';
import { resolveAgentSecret, resolveAppSecret } from '../../config/secret-resolver';
import {
  buildEncryptedAccountConfig,
  ensureSecretsGetterWrapper,
  loadConfig,
  saveConfig,
} from '../../config/store';
import { gcOldLogs, log } from '../../core/logger';
import { gcMediaCache } from '../../media/cache';
import { preFlightChecks } from '../preflight';
import {
  cleanupTmpFiles,
  register,
  sameAppOthers,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from '../../runtime/registry';
import { SessionStore } from '../../session/store';
import { WorkspaceStore } from '../../workspace/store';
import { workspaceRoot } from '../../workspace/guard';
import { ensureLarkCliProfile } from '../../runtime/lark-cli-profile';

// Prefer IPv4 — Node 20+ defaults to "verbatim" which respects whatever
// the resolver returns first; in IPv6-broken networks (WSL2, certain VPNs,
// some hotel WiFi) this lands on a dead v6 route and stalls. Explicitly
// prefer v4 avoids that whole class of issue.
dns.setDefaultResultOrder('ipv4first');

// Process-level safety net: never let a stray SDK call / axios timeout
// take the whole bot down. Most outbound calls (channel.send / rawClient.*)
// are async; if any callsite misses a try/catch (or fires an update after
// its enclosing scope returned), the rejection bubbles to here. Log and
// keep the bot alive — losing a single reply is better than crashing.
process.on('unhandledRejection', (reason) => {
  log.fail('process', reason, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  log.fail('process', err, { kind: 'uncaughtException' });
});

const MEDIA_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Ask the operator which agent CLI to bridge on first run. Skipped when
 * only one agent is registered (no real choice to make) or stdin isn't a
 * TTY (daemonized starts can't answer).
 */
async function chooseAgentInteractively(): Promise<string | undefined> {
  const types = knownAgentTypes();
  if (types.length <= 1 || !process.stdin.isTTY) return undefined;
  // Probe every CLI in parallel — each probe spawns `<cli> --version`
  // (up to a few seconds on Windows), and serial probing stalls first run.
  const resolutions = await Promise.all(types.map((t) => resolveAgent(t)));
  const options: { value: string; label: string; hint: string }[] = types.map((t, i) => ({
    value: t,
    label: t,
    hint: resolutions[i]?.adapter ? '✓ 已检测到 CLI' : '未检测到（安装后可用）',
  }));
  const picked = await select({
    message: '选择要桥接的 agent CLI（回车确认）',
    options,
  });
  if (typeof picked !== 'string') return undefined;
  return picked;
}

/** Registry create-options from the active config (provider profile + key). */
async function agentCreateOptions(cfg: AppConfig): Promise<AgentCreateOptions> {
  return {
    provider: getAgentProvider(cfg),
    apiKey: await resolveAgentSecret(cfg),
    permissionMode: getAgentPermissionMode(cfg),
  };
}

export interface StartOptions {
  config?: string;
  skipCheckLarkCli?: boolean;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const configPath = opts.config ?? paths.configFile;
  const existing = await loadConfig(configPath);

  let cfg: AppConfig;
  if (isComplete(existing)) {
    cfg = existing;
    // Migrate legacy plaintext configs: any time we see a raw string in
    // accounts.app.secret that isn't a "${VAR}" template, move it into
    // the encrypted keystore and rewrite config.json with an exec ref.
    // Idempotent — already-encrypted configs (SecretRef) pass through.
    cfg = await maybeMigratePlaintextSecret(cfg, configPath);
  } else {
    const fresh = await runRegistrationWizard();
    // First run: if more than one agent CLI is registered, let the operator
    // pick which one to bridge (default codex). Probing marks which CLIs
    // are actually installed so the choice isn't blind.
    const agentType = await chooseAgentInteractively();
    if (agentType) {
      fresh.preferences = {
        ...fresh.preferences,
        agent: { ...fresh.preferences?.agent, type: agentType },
      };
      console.log(`  agent: ${agentType}\n`);
    }
    // Fresh credentials from the wizard arrive as a plaintext secret;
    // immediately encrypt before persisting so disk never holds the raw value.
    cfg = await persistEncrypted(fresh, configPath);
    console.log(`配置已保存到 ${configPath}\n`);
  }

  // Upgrade the legacy "current app + inactive accounts" layout before any
  // command handler can mutate it. Persist this harmless metadata migration
  // once so restarts and watchdog recovery see the same registry.
  if (ensureAccountProfiles(cfg)) await saveConfig(cfg, configPath);

  await preFlightChecks({ skipCheckLarkCli: opts.skipCheckLarkCli });
  await provisionActiveLarkCliProfile(cfg);

  // Resolve the configured agent (preferences.agent.type, default codex)
  // and verify its CLI exists before wiring the bridge.
  let createOptions: AgentCreateOptions;
  try {
    createOptions = await agentCreateOptions(cfg);
  } catch (err) {
    console.error(`✗ agent 配置解析失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const resolution = await resolveAgent(getAgentType(cfg), createOptions);
  if (resolution.error || !resolution.adapter) {
    console.error(`✗ ${resolution.error ?? 'agent 不可用'}`);
    process.exit(1);
  }
  const agent = resolution.adapter;

  const sessions = new SessionStore();
  await sessions.load();
  const workspaces = new WorkspaceStore();
  await workspaces.load();

  await gcMediaCache(MEDIA_GC_MAX_AGE_MS);
  await gcOldLogs();

  // Same-app conflict detection. Open-platform routes events to one of the
  // long-connections at random, so two `start` of the same app makes "who
  // answered me" unpredictable. Warn + interactive triage before connecting.
  const conflicts = sameAppOthers(cfg.accounts.app.id);
  if (conflicts.length > 0) {
    const proceed = await resolveConflict(cfg, conflicts);
    if (!proceed) {
      console.log('已取消启动。');
      process.exit(0);
    }
  }

  // Register self in the process registry. Cleanup is wired via stop() and
  // 'exit' below — both paths run unregisterSync so stale entries don't
  // poison the next start.
  const entry = await register({
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    configPath,
    version: pkg.version,
  });
  log.info('registry', 'registered', { id: entry.id, pid: process.pid });

  // `bridge` is mutable so /account can swap it on restart. `controls` carries
  // restart() and a snapshot of the current cfg so command handlers can read
  // and replace credentials without plumbing through the whole runStart scope.
  let bridge: BridgeChannel;
  let restarting = false;

  let stopping = false;
  const stop = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${sig}，正在关闭...`);
    try {
      await bridge.disconnect();
    } catch (err) {
      console.error('[disconnect-failed]', err);
    }
    // unregister is best-effort sync — we're about to exit anyway.
    unregisterSync(entry.id);
    process.exit(0);
  };

  const controls: Controls = {
    configPath,
    cfg,
    processId: entry.id,
    async exit() {
      await stop('exit-command');
    },
    async restart(options) {
      if (restarting) throw new Error('bridge restart already in progress');
      restarting = true;
      const oldBridge = bridge;
      const oldConfig = controls.cfg;
      let candidateBridge: BridgeChannel | undefined;
      oldBridge.drain();
      try {
        const next = await loadConfig(configPath);
        if (!isComplete(next)) throw new Error('config incomplete after change');
        if (ensureAccountProfiles(next)) await saveConfig(next, configPath);
        await provisionActiveLarkCliProfile(next);
        console.log(
          `[restart] connecting new bridge with appId=${next.accounts.app.id} tenant=${next.accounts.app.tenant}...`,
        );
        // Connect-before-disconnect: if the new bridge fails to come up
        // (e.g. network outage during a force-reconnect), throwing here
        // leaves the old bridge — and its keepalive timer — untouched, so
        // the next keepalive tick (~15s later) can retry restart. Without
        // this ordering, a failed restart would tear down the only
        // keepalive in the process and the bot would never recover until
        // someone manually restarts it.
        // Re-resolve the agent so /config changes to agent.type / provider
        // / API key take effect without a full process restart.
        const nextResolution = await resolveAgent(getAgentType(next), await agentCreateOptions(next));
        if (nextResolution.error || !nextResolution.adapter) {
          throw new Error(nextResolution.error ?? 'agent 不可用');
        }
        // New handlers must observe the candidate account while they start.
        // The old bridge is drained, so temporarily swapping this shared
        // snapshot cannot route old-app events into the new account scope.
        controls.cfg = next;
        const next_bridge = await startChannel({
          cfg: next,
          agent: nextResolution.adapter,
          sessions,
          workspaces,
          controls,
        });
        candidateBridge = next_bridge;
        await options?.beforeDisconnect?.({ channel: next_bridge.channel, cfg: next });
        bridge = next_bridge;
        candidateBridge = undefined;
        console.log('[restart] disconnecting old bridge...');
        try {
          await oldBridge.disconnect();
        } catch (err) {
          console.warn('[restart] old disconnect failed:', err);
        }
        // Keep the registry in sync so /ps reflects the new app after an
        // /account change. Same process id, new app fields.
        await updateEntry(entry.id, {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          configPath,
          botName: bridge.channel.botIdentity?.name,
        }).catch((err) =>
          log.warn('registry', 'update-failed', { err: String(err) }),
        );
        console.log('✓ 已用新凭据重连');
      } catch (err) {
        if (candidateBridge) {
          await candidateBridge.disconnect().catch((disconnectErr) =>
            log.warn('restart', 'candidate-disconnect-failed', { err: String(disconnectErr) }),
          );
        }
        controls.cfg = oldConfig;
        oldBridge.resume();
        throw err;
      } finally {
        restarting = false;
      }
    },
  };

  bridge = await startChannel({ cfg, agent, sessions, workspaces, controls });

  // Backfill the bot's display name into the registry once WS handshake is
  // done — future starts conflicting on this app can show it in the prompt
  // ("bot 尼莫 (cli_xxx)") instead of just a short id.
  const botName = bridge.channel.botIdentity?.name;
  if (botName) {
    await updateEntry(entry.id, { botName }).catch((err) =>
      log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
    );
  }

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  // Last-ditch sync unregister in case something exits without going through
  // stop() (e.g. uncaughtException with process.exit(1)).
  process.on('exit', () => {
    unregisterSync(entry.id);
    cleanupTmpFiles();
  });

  // keep the event loop alive until a signal arrives
  await new Promise<void>(() => {});
}

async function provisionActiveLarkCliProfile(cfg: AppConfig): Promise<void> {
  const profile = activeAccountProfile(cfg);
  const secret = await resolveAppSecret(cfg);
  const result = await ensureLarkCliProfile({
    workspace: workspaceRoot(),
    profile: profile.larkCliProfile!,
    appId: cfg.accounts.app.id,
    appSecret: secret,
    tenant: cfg.accounts.app.tenant,
  });
  if (result.configured) {
    log.info('lark-cli', 'profile-ready', { profile: profile.larkCliProfile, appId: cfg.accounts.app.id });
  } else {
    // `lark-cli` is optional for regular bot messages. Keep the bridge up,
    // but make agent-originated API calls diagnosable without exposing secret.
    log.warn('lark-cli', 'profile-unavailable', {
      profile: profile.larkCliProfile,
      appId: cfg.accounts.app.id,
      reason: result.reason,
    });
  }
}

/**
 * Print the same-app conflict, then ask the user how to proceed. Returns
 * true to continue starting (after killing the old ones), false to cancel.
 *
 * Non-TTY (launchd / systemd / piped) skips the prompt and warns — a service
 * manager can't answer questions, and erroring out by default would surprise
 * users running a daemon.
 */
async function resolveConflict(
  cfg: AppConfig,
  conflicts: ProcessEntry[],
): Promise<boolean> {
  console.log(
    `⚠️  检测到这个飞书应用已经有 ${conflicts.length} 个 bot 正在运行:`,
  );
  for (const e of conflicts) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    // botName 只在 WS 连上后才回填,刚启动 / 连接失败的旧 entry 可能没有。
    const label = e.botName ? `bot ${e.botName} (${e.appId})` : `bot ${e.appId}`;
    console.log(`   - ${label},进程 ${e.id},${ago}启动`);
  }
  console.log('');

  if (!process.stdin.isTTY) {
    console.warn(
      '⚠️  当前不是交互式启动,已自动取消。如需替换,先用 `kill <bot id>` 关掉旧的。\n',
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));
  try {
    const verb = conflicts.length > 1 ? '它们' : '那个';
    const answer = (await ask(`继续启动会先关掉${verb},是否继续? [y/N]: `))
      .trim()
      .toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      return false;
    }
    for (const e of conflicts) {
      try {
        process.kill(e.pid, 'SIGTERM');
        console.log(`✓ 已关掉 bot ${e.id}`);
      } catch (err) {
        console.warn(`✗ 关掉 bot ${e.id} 失败:${(err as Error).message}`);
      }
    }
    // Brief wait so targets unregister themselves before we register on top.
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  } finally {
    rl.close();
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

/**
 * If `cfg.accounts.app.secret` is a literal plaintext string (not a
 * "${VAR}" template, not a SecretRef), move it into the encrypted keystore
 * and rewrite `config.json` with an exec-provider SecretRef pointing at
 * the bridge. Returns the (possibly rewritten) cfg.
 *
 * Idempotent: configs already in the encrypted form return unchanged.
 */
async function maybeMigratePlaintextSecret(
  cfg: AppConfig,
  configPath: string,
): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;

  // Path A: still plaintext → encrypt + rewrite config.
  if (typeof s === 'string' && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(s)) {
    try {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
      );
      await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
      await saveConfig(next, configPath);
      console.log('🔒 已把 App Secret 加密迁移到 ~/.feishu-codex-bridge/secrets.enc');
      return next;
    } catch (err) {
      log.warn('config', 'migrate-encrypted-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Migration failure isn't fatal — runtime resolver still handles
      // the plaintext path.
      return cfg;
    }
  }

  // Path B: env-template — leave entirely alone.
  if (typeof s === 'string') return cfg;

  // Path C: already a SecretRef. Two things to keep fresh:
  //   1. The wrapper script content (node / bridge paths may have moved).
  //   2. The config's `secrets.providers.bridge` block — older bridge
  //      versions wrote `command: <node path>`; the new format points
  //      at the wrapper. Rewrite if out of date so lark-cli's audit
  //      sees a user-owned, non-symlinked command path.
  try {
    const wrapperPath = await ensureSecretsGetterWrapper();
    if (needsProviderRewrite(cfg, wrapperPath)) {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
      );
      await saveConfig(next, configPath);
      console.log('🔒 已把 secrets provider 切到 wrapper 形态');
      return next;
    }
  } catch (err) {
    log.warn('config', 'wrapper-refresh-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return cfg;
}

function needsProviderRewrite(cfg: AppConfig, wrapperPath: string): boolean {
  const provider = cfg.secrets?.providers?.bridge;
  if (!provider) return true;
  if (provider.command !== wrapperPath) return true;
  if (!Array.isArray(provider.args) || provider.args.length !== 0) return true;
  return false;
}

/** Encrypt the (plaintext) secret from a freshly-wizard'd cfg and persist. */
async function persistEncrypted(cfg: AppConfig, configPath: string): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;
  if (typeof s !== 'string') {
    // Wizard returns plaintext today; if that ever changes, just save as-is.
    await saveConfig(cfg, configPath);
    return cfg;
  }
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
  await saveConfig(next, configPath);
  return next;
}

