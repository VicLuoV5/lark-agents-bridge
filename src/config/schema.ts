import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside this file — keeps secrets out
 * of `config.json` so backups / accidental git commits / log dumps don't
 * leak the bot's App Secret. Mirrors openclaw's `SecretRef` shape so one
 * generic resolver can serve bridge and agent-provider credentials.
 *
 *   - `env`:  value is in process env at `id` (optionally allowlisted via provider)
 *   - `file`: value is at the path `id` (or `provider.path` if provider config)
 *   - `exec`: spawn `provider.command`, send JSON over stdin, read JSON from stdout
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

/** A secret field can be either a plain string (potentially a `${VAR}`
 * template) or a SecretRef. JSON deserializer accepts both forms. */
export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

/**
 * `secrets.providers` is openclaw-compatible: each named provider declares
 * how SecretRefs resolve to plaintext (env allowlist, file path, exec
 * command). Only the fields actually consumed by bridge's resolver are
 * typed here; lark-cli reads the same JSON via its richer Go types.
 */
export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  /** env: allowlist of env var names that ref.id is allowed to be in. */
  allowlist?: string[];
  /** file: optional base path; ref.id is joined onto it. */
  path?: string;
  /** exec: command to spawn + args. */
  command?: string;
  args?: string[];
  /** exec: explicit env to inject (key=value pairs). */
  env?: Record<string, string>;
  /** exec: env var names to pass through from parent env. */
  passEnv?: string[];
  /** exec: max ms to wait for the child. */
  noOutputTimeoutMs?: number;
  /** exec: max stdout bytes accepted before treating as runaway. */
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/**
 * How replies are rendered in IM chats:
 *   - `card`: full interactive card (tool panels, ⏹ button, footer status)
 *   - `markdown`: lightweight streaming markdown card (typewriter, no buttons)
 *   - `text`: plain markdown post sent once at run completion (no streaming)
 *
 * Pre-0.1.27 only had `card` and `text`, where `text` meant what's now called
 * `markdown`. See `messageReplyMigrated` for the auto-coercion logic.
 */
export type MessageReplyMode = 'card' | 'markdown' | 'text';

export const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/**
 * Bridge-level permission vocabulary (Claude-style names). Each adapter maps
 * these onto its own CLI's flags (Codex: read-only/workspace-write/
 * danger-full-access; Claude Code: --permission-mode; ...).
 */
export const AGENT_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

/**
 * Agent ids allowed in `preferences.agent.type` — the config vocabulary.
 * Must stay in sync with src/agent/registry's REGISTRY keys (a test guards
 * this); the registry owns the implementations, this list owns the config
 * surface so the card/command layers never import from src/agent.
 */
export const AGENT_TYPES = ['codex', 'claude', 'qwen', 'kimi', 'codebuddy', 'dsh'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (AGENT_TYPES as readonly string[]).includes(value);
}

/** Legacy name kept so older imports keep compiling. */
export const CODEX_PERMISSION_MODES = AGENT_PERMISSION_MODES;
export type CodexPermissionMode = AgentPermissionMode;

/**
 * Which agent CLI the bridge spawns and its run knobs. `reasoningEffort` is
 * an opaque string validated by the selected adapter (vocabularies differ:
 * Codex minimal..xhigh, dsh off/low/high/max, ...). Unknown/invalid values
 * are ignored by the adapter with a warning.
 */
export interface AgentConfig {
  /** Adapter id from src/agent/registry. Default 'codex'. */
  type?: string;
  /**
   * Model provider profile id (claude adapter: 'anthropic' = own login,
   * or a vendor id from src/agent/providers). Other adapters ignore it.
   */
  provider?: string;
  /** Model override handed to the adapter, if it supports one. */
  model?: string;
  /**
   * Where the provider API key lives (keystore exec ref / env template /
   * literal). Resolved at spawn time; never written as plaintext here by
   * /config (it goes into secrets.enc).
   */
  apiKey?: SecretInput;
  permissionMode?: AgentPermissionMode;
  reasoningEffort?: string;
}

/**
 * Access control settings. All three lists default to "no restriction" when
 * empty / undefined, so existing deployments are not broken on upgrade.
 * Operators that want a hardened deployment fill these in via
 * `~/.feishu-codex-bridge/config.json` (no CLI surface yet — by design, since
 * persisting the lists requires the operator to look up open_ids/chat_ids
 * out-of-band anyway).
 */
export interface AppAccess {
  /** open_id whitelist for who can interact with the bot (DM + group @bot).
   * Empty/undefined = allow everyone. */
  allowedUsers?: string[];
  /** chat_id whitelist for chats the bot responds in. Empty/undefined =
   * respond in all chats it's invited to. */
  allowedChats?: string[];
  /** open_id list with admin privileges. Gates sensitive commands
   * (/account, /config, /exit, /reconnect, /doctor, /cd, /ws). Empty /
   * undefined = no admin restriction (every allowed user is an admin). */
  admins?: string[];
}

export interface AppPreferences {
  /** Reply rendering mode for IM (group/p2p) messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /**
   * One-time handoff for a manually-bound account. The plaintext code is
   * shown only on the old bot's success card; config stores just its digest.
   */
  pendingAdminHandoff?: { digest: string };
  /**
   * Internal marker: pre-0.1.27 the value `'text'` meant "lightweight
   * streaming markdown card" (what's now called `'markdown'`). On upgrade
   * we'd silently switch those users to true plain-text behavior unless we
   * coerce; this flag is set the first time the user submits `/config`
   * after the rename, indicating their `messageReply` value is in the
   * new semantic.
   */
  messageReplyMigrated?: boolean;
  /**
   * Whether to render tool-call blocks (Bash / Read / Edit / ...) in the
   * output. Default true. Turn off if you only care about Codex's final
   * text answer and want to hide the "工具调用过程".
   */
  showToolCalls?: boolean;
  /**
   * Cap on concurrent agent runs across all chats / topics. Excess runs
   * queue FIFO. Default 10. Mostly relevant for topic groups where each
   * topic can spawn its own run; capping protects RAM / token spend.
   */
  maxConcurrentRuns?: number;
  /**
   * Global default idle-timeout for agent runs, in minutes. When set,
   * if the agent emits no stream event for this long the bridge kills the
   * run as presumed-hung. Undefined / 0 = no timeout (the default — runs
   * can hang indefinitely). Per-scope `/timeout` overrides this.
   */
  runIdleTimeoutMinutes?: number;
  /**
   * Agent selection and run knobs. When absent, falls back to the legacy
   * `codexReasoningEffort` / `codexPermissionMode` fields below (and the
   * 'codex' adapter).
   */
  agent?: AgentConfig;
  /**
   * Optional bridge-scoped override for Codex CLI reasoning effort. When
   * unset, Codex inherits `model_reasoning_effort` from CODEX_HOME config.
   *
   * Legacy (pre-multi-agent) field — superseded by `agent.reasoningEffort`;
   * kept as a read-fallback and written by nothing newer than /config's
   * agent-section submit.
   */
  codexReasoningEffort?: CodexReasoningEffort;
  /**
   * Bridge-scoped Codex permission mode. `default` / unset keeps Codex in
   * read-only sandbox. `acceptEdits` enables workspace-write for trusted
   * personal deployments. `bypassPermissions` maps to Codex
   * danger-full-access and should only be used briefly on a trusted machine.
   *
   * Legacy (pre-multi-agent) field — superseded by `agent.permissionMode`.
   */
  codexPermissionMode?: CodexPermissionMode;
  /**
   * Whether the bot only responds to messages that @-mention it in groups
   * (regular and topic groups). p2p is always unrestricted. Default true:
   * groups are quiet unless the user @bot. Set false to let any group
   * message reach Codex (the 0.1.21-and-earlier behavior).
   *
   * @全员 is never responded to regardless (SDK `respondToMentionAll: false`).
   * Cloud-doc comments still require @-mention unconditionally.
   */
  requireMentionInGroup?: boolean;
  /** Access control — user/chat allowlists + admin gating. See AppAccess. */
  access?: AppAccess;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when killing the agent
   * subprocess. Bumped from a hardcoded 500ms because agents often have their
   * own subprocesses (e.g. lark-cli mid-OAuth) that need a moment to clean
   * up — too short a window and the SIGKILL cascade kills the descendants
   * before they can finish what the user is waiting on. Default 5000ms.
   * Range 100-30000; out-of-range values fall back to default.
   */
  agentStopGraceMs?: number;
}

/**
 * Top-level config shape on disk.
 *
 * `accounts` is a namespace for credential-flavored fields (currently just
 * the bot app, room for OAuth / alternate apps later). `preferences`
 * holds user-tunable behavior knobs. Other future sections (mcp, etc.)
 * belong at this top level alongside them.
 */
/**
 * A saved Feishu app account for in-chat switching. Secrets are NOT stored
 * here — they live in the keystore under `secretKeyForApp(appId)`; a
 * profile only carries metadata.
 */
export interface AccountProfile {
  /** Display name — the app's name as reported by the Feishu API. */
  name: string;
  appId: string;
  tenant: TenantBrand;
  /** Stable lark-cli profile selected for agent-originated API calls. */
  larkCliProfile?: string;
  /** Access rules are app-scoped because Feishu open_ids are app-scoped. */
  access?: AppAccess;
  /** @deprecated Legacy QR enrollment seed; migrated to access.admins. */
  adminOpenId?: string;
}

export interface AppConfig {
  accounts: {
    app: AppCredentials;
    /** Metadata for every known account, including the currently active one. */
    profiles?: AccountProfile[];
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

/** True iff this credential's secret is stored externally (env/file/exec). */
export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** Account/keystore key for the bot's App Secret. lark-cli also uses a
 * similar `appsecret:` convention so audit/grep is consistent. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

/** Saved account profiles (empty for configs created before multi-account). */
export function getAccountProfiles(cfg: Partial<AppConfig>): AccountProfile[] {
  const profiles = cfg.accounts?.profiles;
  return Array.isArray(profiles) ? profiles : [];
}

/** A deterministic, shell-safe lark-cli profile name for an app. */
export function larkCliProfileName(appId: string): string {
  return `bridge-${appId}`;
}

/** Namespace all per-chat state by the receiving app. */
export function accountScope(appId: string, scope: string): string {
  return `app:${appId}:${scope}`;
}

function normalizeAccess(access: AppAccess | undefined, legacyAdmin?: string): AppAccess {
  const uniq = (values: string[] | undefined): string[] | undefined => {
    if (!values) return undefined;
    return [...new Set(values.filter((v) => typeof v === 'string' && v.trim()))];
  };
  const admins = uniq(access?.admins) ?? (legacyAdmin ? [legacyAdmin] : undefined);
  return {
    ...(uniq(access?.allowedUsers) ? { allowedUsers: uniq(access?.allowedUsers) } : {}),
    ...(uniq(access?.allowedChats) ? { allowedChats: uniq(access?.allowedChats) } : {}),
    ...(admins ? { admins } : {}),
  };
}

/**
 * Upgrade the original "inactive profiles only" layout to a complete account
 * registry. Old active-account access rules become that account's profile.
 */
export function ensureAccountProfiles(cfg: AppConfig): boolean {
  const current = cfg.accounts.app;
  const source = getAccountProfiles(cfg);
  let changed = false;
  const profiles: AccountProfile[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    if (!raw?.appId || seen.has(raw.appId)) {
      changed = true;
      continue;
    }
    seen.add(raw.appId);
    const access = normalizeAccess(raw.access, raw.adminOpenId);
    const normalized: AccountProfile = {
      name: raw.name || raw.appId,
      appId: raw.appId,
      tenant: raw.tenant,
      larkCliProfile: raw.larkCliProfile ?? larkCliProfileName(raw.appId),
      ...(Object.keys(access).length > 0 ? { access } : {}),
    };
    if (JSON.stringify(normalized) !== JSON.stringify(raw)) changed = true;
    profiles.push(normalized);
  }
  if (!seen.has(current.id)) {
    profiles.push({
      name: current.id,
      appId: current.id,
      tenant: current.tenant,
      larkCliProfile: larkCliProfileName(current.id),
      access: normalizeAccess(cfg.preferences?.access),
    });
    changed = true;
  }
  if (changed) cfg.accounts.profiles = profiles;
  return changed;
}

export function activeAccountProfile(cfg: AppConfig): AccountProfile {
  ensureAccountProfiles(cfg);
  const profile = getAccountProfiles(cfg).find((p) => p.appId === cfg.accounts.app.id);
  if (!profile) throw new Error(`active account profile missing for ${cfg.accounts.app.id}`);
  return profile;
}

export function switchableAccountProfiles(cfg: AppConfig): AccountProfile[] {
  ensureAccountProfiles(cfg);
  return getAccountProfiles(cfg).filter((p) => p.appId !== cfg.accounts.app.id);
}

/**
 * Add or update a profile (dedupe by appId; re-enrollment refreshes its
 * metadata and app-scoped access rules).
 */
export function upsertAccountProfile(cfg: AppConfig, profile: AccountProfile): void {
  ensureAccountProfiles(cfg);
  const profiles = getAccountProfiles(cfg).filter((p) => p.appId !== profile.appId);
  const access = normalizeAccess(profile.access, profile.adminOpenId);
  profiles.push({
    ...profile,
    name: profile.name || profile.appId,
    larkCliProfile: profile.larkCliProfile ?? larkCliProfileName(profile.appId),
    ...(Object.keys(access).length > 0 ? { access } : {}),
    adminOpenId: undefined,
  });
  cfg.accounts.profiles = profiles;
}

/**
 * Switch the active app to a saved profile. Every account remains in the
 * registry; its access rules are copied into the active runtime preferences.
 * A manually-bound profile without an admin gets a one-time handoff code.
 */
export function switchActiveAccount(
  cfg: AppConfig,
  target: AccountProfile,
  opts: { outgoingName?: string } = {},
): { handoffCode?: string } {
  const current = cfg.accounts.app;
  ensureAccountProfiles(cfg);
  if (current.id === target.appId) return {};
  const profiles = getAccountProfiles(cfg);
  const currentProfile = profiles.find((p) => p.appId === current.id);
  if (currentProfile) {
    currentProfile.name = opts.outgoingName ?? currentProfile.name ?? current.id;
    currentProfile.access = normalizeAccess(cfg.preferences?.access);
  }
  const targetProfile = profiles.find((p) => p.appId === target.appId);
  if (!targetProfile) throw new Error(`account profile not found: ${target.appId}`);
  cfg.accounts.app = {
    id: target.appId,
    secret: { source: 'exec', provider: 'bridge', id: secretKeyForApp(target.appId) },
    tenant: target.tenant,
  };
  const targetAccess = normalizeAccess(targetProfile.access, target.adminOpenId);
  const hasAdmin = Boolean(targetAccess.admins && targetAccess.admins.length > 0);
  let handoffCode: string | undefined;
  if (!hasAdmin) {
    handoffCode = createAdminHandoffCode();
  }
  cfg.preferences = {
    ...cfg.preferences,
    access: targetAccess,
    ...(handoffCode
      ? { pendingAdminHandoff: { digest: handoffDigest(handoffCode) } }
      : { pendingAdminHandoff: undefined }),
  };
  return handoffCode ? { handoffCode } : {};
}

function createAdminHandoffCode(): string {
  // 80 bits of entropy. The displayed form is short enough to type, but is
  // still infeasible to guess before the old bot's success card disappears.
  return randomBytes(10).toString('hex').toUpperCase();
}

function handoffDigest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function claimPendingAdminHandoff(cfg: AppConfig, code: string, senderId: string): boolean {
  const pending = cfg.preferences?.pendingAdminHandoff;
  if (!pending) return false;
  const supplied = Buffer.from(handoffDigest(code.trim().toUpperCase()), 'utf8');
  const expected = Buffer.from(pending.digest, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  const profile = activeAccountProfile(cfg);
  const access = normalizeAccess(profile.access);
  access.admins = [senderId];
  profile.access = access;
  cfg.preferences = {
    ...cfg.preferences,
    access,
    pendingAdminHandoff: undefined,
  };
  return true;
}

/**
 * Resolve the message-reply preference with default fallback + legacy coerce.
 *
 * Pre-0.1.27 users with `messageReply: 'text'` actually wanted the streaming
 * markdown card (the new `'markdown'`). Until they re-submit `/config`
 * (which sets `messageReplyMigrated: true`), we map their `text` →
 * `markdown` so the behavior stays the same after upgrade.
 *
 * Default for fresh configs (no `messageReply` set) is `'markdown'`.
 */
export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'text' && cfg.preferences?.messageReplyMigrated !== true) {
    return 'markdown';
  }
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'markdown';
}

/** Resolve the show-tool-calls preference with default fallback. */
export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls !== false;
}

/** Resolve the max-concurrent-runs preference with default + sanity clamp. */
export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  // Reasonable upper bound — at 50+ concurrent runs the bot box is
  // probably already RAM-starved. Clamp to keep typos from killing the box.
  return Math.min(Math.floor(raw), 50);
}

/**
 * Resolve the require-mention-in-group preference. Default `true` — the
 * `!== false` check makes "undefined" (older configs that don't have the
 * field) inherit the new safer default automatically.
 */
export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  return cfg.preferences?.requireMentionInGroup !== false;
}

/**
 * Resolve the global default idle-timeout in ms. Returns `undefined` when
 * disabled (the default). Clamps to [1, 120] minutes when set so a typo
 * can't lock the bot into a 1-second kill loop or wait forever to a number
 * the user didn't really mean.
 */
/**
 * Grace period before SIGKILL fallback when stopping an agent subprocess.
 * Returns ms. Defaults to 5000 (5 seconds). Clamps to [100, 30000] so a
 * typo can't either make stop() effectively SIGKILL-immediate or hang for
 * minutes.
 */
export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

/** True when `senderId` may interact with the bot. Empty list = allow all. */
export function isUserAllowed(cfg: AppConfig, senderId: string): boolean {
  const list = cfg.preferences?.access?.allowedUsers;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

/** True when `chatId` is one the bot will respond in. Empty list = allow all. */
export function isChatAllowed(cfg: AppConfig, chatId: string): boolean {
  const list = cfg.preferences?.access?.allowedChats;
  if (!list || list.length === 0) return true;
  return list.includes(chatId);
}

/** True when `senderId` has admin privileges. Empty list = no admin
 * restriction (every allowed user can run admin commands). */
export function isAdmin(cfg: AppConfig, senderId: string): boolean {
  // A manually bound app has no trusted app-scoped open_id until its
  // one-time handoff is claimed. Treat that transitional state as deny-all
  // for sensitive commands; `/claim` itself is intentionally not admin-gated.
  if (cfg.preferences?.pendingAdminHandoff) return false;
  const list = cfg.preferences?.access?.admins;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

export function getCodexReasoningEffort(cfg: Partial<AppConfig>): CodexReasoningEffort | undefined {
  const raw = cfg.preferences?.codexReasoningEffort;
  return isCodexReasoningEffort(raw) ? raw : undefined;
}

export function isCodexPermissionMode(value: unknown): value is CodexPermissionMode {
  return typeof value === 'string' && CODEX_PERMISSION_MODES.includes(value as CodexPermissionMode);
}

export function getCodexPermissionMode(cfg: Partial<AppConfig>): CodexPermissionMode | undefined {
  const raw = cfg.preferences?.codexPermissionMode;
  return isCodexPermissionMode(raw) ? raw : undefined;
}

/** Which adapter the bridge should spawn. Default 'codex'. */
export function getAgentType(cfg: Partial<AppConfig>): string {
  const raw = cfg.preferences?.agent?.type;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'codex';
}

/** Model override for the selected adapter, if configured. */
export function getAgentModel(cfg: Partial<AppConfig>): string | undefined {
  const raw = cfg.preferences?.agent?.model;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** Provider profile id for the claude adapter ('anthropic' = own login). */
export function getAgentProvider(cfg: Partial<AppConfig>): string | undefined {
  const raw = cfg.preferences?.agent?.provider;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** SecretInput reference for the provider API key, if configured. */
export function getAgentApiKeyRef(cfg: Partial<AppConfig>): SecretInput | undefined {
  return cfg.preferences?.agent?.apiKey;
}

/**
 * Permission mode for the selected adapter. Falls back to the legacy
 * `codexPermissionMode` field when the agent section doesn't carry one.
 */
export function getAgentPermissionMode(cfg: Partial<AppConfig>): AgentPermissionMode | undefined {
  const raw = cfg.preferences?.agent?.permissionMode;
  if (isCodexPermissionMode(raw)) return raw;
  return getCodexPermissionMode(cfg);
}

/**
 * Reasoning effort for the selected adapter (opaque; the adapter validates).
 * Falls back to the legacy `codexReasoningEffort` field.
 */
export function getAgentReasoningEffort(cfg: Partial<AppConfig>): string | undefined {
  const raw = cfg.preferences?.agent?.reasoningEffort;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return getCodexReasoningEffort(cfg);
}
