import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountAddCard,
  accountCurrentCard,
  accountEnrollSuccessCard,
  accountFailureCard,
  accountFormCard,
  accountListCard,
  accountQrCard,
  accountSwitchConnectedCard,
  accountSwitchFailedCard,
  accountSwitchProgressCard,
  accountTakeoverCard,
} from '../card/account-cards';
import { configCancelledCard, configFormCard, configSavedCard } from '../card/config-card';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { helpCard, resumeCard, statusCard, workspacesCard } from '../card/templates';
import type { AccountProfile, AgentConfig, AppConfig, MessageReplyMode, SecretInput, TenantBrand } from '../config/schema';
import {
  getAccountProfiles,
  accountScope,
  claimPendingAdminHandoff,
  ensureAccountProfiles,
  getAgentApiKeyRef,
  getAgentModel,
  getAgentPermissionMode,
  getAgentProvider,
  getAgentReasoningEffort,
  getAgentStopGraceMs,
  getAgentType,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isAgentType,
  isCodexPermissionMode,
  isAdmin,
  secretKeyForApp,
  switchActiveAccount,
  switchableAccountProfiles,
  upsertAccountProfile,
} from '../config/schema';
import { PROVIDER_PROFILES, secretKeyForProvider } from '../config/provider-profiles';
import { getSecret, removeSecret, setSecret } from '../config/keystore';
import { registerAppViaChat } from '../bot/wizard';
import { buildEncryptedAccountConfig, saveConfig } from '../config/store';
import { log, readRecentLogs, sanitizeLogsForDoctor } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime } from '../session/history';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import type { SessionStore } from '../session/store';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { isInsideWorkspaceRoot, resolveWorkspacePath, workspaceRoot } from '../workspace/guard';
import { createBoundChat, defaultChatName } from '../bot/group';

export interface Controls {
  /** Restart the bridge in-process. The replacement connects before the old
   * channel is disconnected; `beforeDisconnect` can therefore publish a
   * terminal handoff state through both applications. */
  restart(options?: RestartOptions): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  controls: Controls;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleReset,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/claim': handleClaim,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated on the configured admin allowlist;
 * empty list = no restriction (every allowed user can run them — see
 * `isAdmin` in config/schema).
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
  }
  return true;
}

export interface RestartOptions {
  beforeDisconnect?: (next: { channel: LarkChannel; cfg: AppConfig }) => Promise<void>;
}

async function handleClaim(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '❌ 管理员交接只能在与新 bot 的私聊中完成。');
    return;
  }
  const code = args.trim();
  if (!code || !claimPendingAdminHandoff(ctx.controls.cfg, code, ctx.msg.senderId)) {
    await reply(ctx, '❌ 交接码无效或已使用。请回到旧 bot 获取新的切换提示。');
    return;
  }
  try {
    await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
    await reply(
      ctx,
      '✅ 管理员交接完成。当前 bot 已连接并接管本机 Agent；你现在可以继续对话，并使用 `/account` 和 `/config`。',
    );
  } catch (err) {
    log.fail('command', err, { step: 'admin-handoff-claim' });
    await reply(ctx, '❌ 管理员交接保存失败，请重试。');
  }
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
  }
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // Historical behavior: /new [name] spins up a fresh group chat bound to a
  // fresh session. Keep /new chat [name] as a compatibility spelling.
  const rawName = trimmed === 'chat'
    ? ''
    : trimmed.startsWith('chat ')
      ? trimmed.slice(5).trim()
      : trimmed;
  return handleNewChat(rawName, ctx);
}

async function handleReset(_args: string, ctx: CommandContext): Promise<void> {
  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = ctx.workspaces.cwdFor(ctx.scope) ?? workspaceRoot();
  const name = rawName || defaultChatName();

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace.
  ctx.workspaces.setCwd(accountScope(ctx.controls.cfg.accounts.app.id, created.chatId), sourceCwd);

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`;
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, `用法：\`/cd <${workspaceRoot()} 下的路径>\``);
    return;
  }
  const absolute = resolveWorkspacePath(expandTilde(input));
  if (!isInsideWorkspaceRoot(absolute)) {
    await reply(
      ctx,
      `路径超出允许的工作根目录。\n\n允许根目录：\`${workspaceRoot()}\`\n请求路径：\`${absolute}\``,
    );
    return;
  }
  try {
    const st = await stat(absolute);
    if (!st.isDirectory()) {
      await reply(ctx, `路径不是目录：\`${absolute}\``);
      return;
    }
  } catch {
    await reply(ctx, `路径不存在：\`${absolute}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, absolute);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${absolute}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const accountId = ctx.controls.cfg.accounts.app.id;
  const named = ctx.workspaces.listNamed(accountId);
  const currentCwd = ctx.workspaces.cwdFor(ctx.scope) ?? workspaceRoot();
  const card = workspacesCard(currentCwd, named);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? workspaceRoot();
  ctx.workspaces.saveNamed(name, cwd, ctx.controls.cfg.accounts.app.id);
  await reply(ctx, `✓ 工作空间已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = ctx.workspaces.getNamed(name, ctx.controls.cfg.accounts.app.id);
  if (!cwd) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  if (!isInsideWorkspaceRoot(cwd)) {
    await reply(
      ctx,
      `工作空间 \`${name}\` 指向允许根目录外，已拒绝切换：\`${cwd}\``,
    );
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${cwd})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!ctx.workspaces.removeNamed(name, ctx.controls.cfg.accounts.app.id)) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作空间：\`${name}\``);
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  // Not every adapter can enumerate resumable sessions (Codex reads its
  // own ~/.codex jsonl; others have no such surface yet).
  if (!ctx.agent.history) {
    await reply(ctx, `当前 agent（${ctx.agent.displayName}）暂不支持 /resume。`);
    return;
  }

  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? workspaceRoot();
  const sessions = await ctx.agent.history.list(cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const entries = sessions.map((s) => ({
    sessionId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? workspaceRoot();
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd, ctx.agent.id);
  await reply(
    ctx,
    `✓ 已恢复会话 \`${sessionId.slice(0, 8)}…\`。接着发消息就行。`,
  );
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? workspaceRoot();
  const sess = ctx.sessions.getRaw(ctx.scope);
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    reasoningEffort: getAgentReasoningEffort(ctx.controls.cfg),
    permissionMode: getAgentPermissionMode(ctx.controls.cfg),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  const ok = ctx.activeRuns.interrupt(ctx.scope);
  log.info('command', 'stop', { interrupted: ok });
  // No reply: if there was a run, its in-flight render loop will mark the
  // card as 'interrupted' and re-render (`_⏹ 已被中断_`).
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!trimmed) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (trimmed === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(ctx.scope);
    log.info('command', 'timeout-clear', { scope: ctx.scope, cleared });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (trimmed === 'off' || trimmed === '0') {
    ctx.sessions.setIdleTimeoutMinutes(ctx.scope, 0);
    log.info('command', 'timeout-off', { scope: ctx.scope });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(ctx.scope, n);
  log.info('command', 'timeout-set', { scope: ctx.scope, minutes: n });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'reconnect');
  await reply(ctx, '⏳ 正在重连…');
  try {
    await ctx.controls.restart();
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

const DOCTOR_INSTRUCTIONS = `你是 feishu-codex-bridge 的诊断助理。下面会给你两段输入:
1. 用户的故障描述
2. 最近的运行日志(JSON line 格式,旧→新)

日志字段含义:
- ts: ISO 时间戳
- level: info | warn | error
- phase: 模块阶段。常见值: ws(WebSocket), intake(消息入站), queue(去抖队列), flush(批处理), media(附件下载), prompt(prompt 组装), session(会话), agent(codex 子进程), card(卡片渲染), comment(文档评论), cardAction(卡片回调), command(斜杠命令), sdk(飞书 SDK 内部)
- event: enter | exit | transition | fail | 各 phase 自定义事件
- traceId: 同一逻辑操作的串联 ID(同一条消息的多个日志会共享)
- chatId: 飞书聊天 ID(用 chatId 反查相关日志)

回复严格三段,markdown 标题用二级:

## 可能原因
1-3 条最有可能的原因,每条带具体日志的时间戳或 traceId 引用。

## 关键日志片段
3-5 条最重要的日志,直接贴 JSON 行原文,后跟一行说明为什么重要。

## 建议下一步
1-3 条具体可执行的动作(检查 X / 重启 Y / 等待 Z 之类)。

如果日志里没有任何相关线索,直接说"日志不足以判断,建议:"再列动作。回复要直接,不寒暄。`;

function buildDoctorPrompt(description: string, logs: string): string {
  const desc = description.trim() || '(用户没写描述,自行从日志找最显眼的异常。)';
  return `${DOCTOR_INSTRUCTIONS}

---

用户故障描述:
${desc}

最近的运行日志:
\`\`\`
${logs}
\`\`\``;
}

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });
  // Killing any in-flight run on this chat — /doctor is a "I'm stuck" call.
  ctx.activeRuns.interrupt(ctx.scope);

  const rawLogs = await readRecentLogs({ maxBytes: 60_000 });
  if (!rawLogs.trim()) {
    await ctx.channel.send(
      ctx.msg.chatId,
      { text: '没有找到日志文件 — bridge 可能刚启动或日志目录不可写。' },
      { replyTo: ctx.msg.messageId },
    );
    return;
  }
  // Scrub identifying / credential material before the logs (a) reach
  // Codex via the agent prompt, and (b) end up in any card payload
  // Lark may cache server-side.
  const logs = sanitizeLogsForDoctor(rawLogs);

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  const prompt = buildDoctorPrompt(args, logs);
  const run = ctx.agent.run({
    prompt,
    cwd: workspaceRoot(),
    reasoningEffort: getAgentReasoningEffort(ctx.controls.cfg),
    permissionMode: getAgentPermissionMode(ctx.controls.cfg),
    stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
  });
  const handle = ctx.activeRuns.register(ctx.scope, run);

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              const flush = (): Promise<void> => ctrl.update(renderCard(state));
              for await (const evt of handle.run.events) {
                if (handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  if (evt.costUsd !== undefined) {
                    log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
                  }
                  continue;
                }
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some agent versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
              await handle.run.stop();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      for await (const evt of handle.run.events) {
        if (handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          if (evt.costUsd !== undefined) {
            log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
          }
          continue;
        }
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      await handle.run.stop();
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: ctx.msg.senderId,
          msg_type: 'interactive',
          content: JSON.stringify(renderCard(state)),
        },
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
  } finally {
    ctx.activeRuns.unregister(ctx.scope, run);
  }
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard();
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'list':
      return showAccountList(ctx);
    case 'add':
      return showAddCard(ctx);
    case 'add.qr':
      return startAccountQrEnrollment(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'switch': {
      // Text-command switching: `/account switch <index|appId>` — works even
      // when card callbacks are intercepted (e.g. unbound lark-cli layers).
      const target = parts[1] ?? '';
      if (target) return switchAccountByTarget(ctx, target);
      return submitAccountSwitch(ctx);
    }
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account`、`/account add`、`/account list`、`/account switch <序号>` 或 `/account change`');
  }
}

/** Resolve a switch target by 1-based list index or appId, validate, swap. */
async function switchAccountByTarget(ctx: CommandContext, target: string): Promise<void> {
  const profiles = switchableAccountProfiles(ctx.controls.cfg);
  const byIndex = /^\d+$/.test(target) ? profiles[Number(target) - 1] : undefined;
  const profile = byIndex ?? profiles.find((p) => p.appId === target);
  if (!profile) {
    const list = profiles.map((p, i) => `${i + 1}. ${p.name}`).join('\n') || '（空）';
    await reply(ctx, `❌ 找不到账号「${target}」。当前档案：\n${list}`);
    return;
  }
  if (profile.appId === ctx.controls.cfg.accounts.app.id) {
    await reply(ctx, `ℹ️ ${profile.name} 已是当前账号。`);
    return;
  }
  await performAccountSwitch(ctx, profile);
}

/**
 * Shared switch: validate the target's stored credentials, swap the active
 * app, restart. Throws nothing — failures are reported via `reply`.
 */
async function performAccountSwitch(
  ctx: CommandContext,
  target: AccountProfile,
): Promise<void> {
  const secret = await getSecret(secretKeyForApp(target.appId)).catch(() => undefined);
  if (!secret) {
    await reply(ctx, `❌ ${target.name} 的 Secret 在本机 keystore 中缺失，请通过 /account add 重新录入。`);
    return;
  }
  const v = await validateAppCredentials(target.appId, secret, target.tenant);
  if (!v.ok) {
    await reply(ctx, `❌ 校验失败（${target.name}）：${v.reason ?? 'unknown'}`);
    return;
  }
  const fromName = ctx.channel.botIdentity?.name ?? ctx.controls.cfg.accounts.app.id;
  const toName = v.botName ?? target.name;
  const previousCfg = structuredClone(ctx.controls.cfg);
  const nextCfg = structuredClone(ctx.controls.cfg);
  const switched = switchActiveAccount(nextCfg, { ...target, name: toName }, {
    outgoingName: ctx.channel.botIdentity?.name,
  });
  try {
    await saveConfig(nextCfg, ctx.controls.configPath);
  } catch (err) {
    await reply(ctx, `❌ 保存配置失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const seedNote = switched.handoffCode
    ? `请私聊新 bot 发送：\`/claim ${switched.handoffCode}\`，完成管理员交接。`
    : undefined;
  await reply(
    ctx,
    `⏳ **正在切换**\n\n${fromName} → **${toName}**\n\n_正在建立连接，通常需要 3–8 秒。请等待最终结果。_` +
      (seedNote ? `\n\nℹ️ ${seedNote}` : ''),
  );
  try {
    await ctx.controls.restart({
      beforeDisconnect: async ({ channel: nextChannel, cfg }) => {
        await reply(
          ctx,
          `✅ **切换完成**\n\n${fromName} → **${toName}**\n\n连接已恢复，新 bot 已接管本机 Agent。请前往新 bot 的会话继续使用。` +
            (seedNote ? `\n\nℹ️ ${seedNote}` : ''),
        );
        await sendAccountTakeoverNotice(nextChannel, cfg, toName, fromName);
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const rollbackError = await restoreAccountConfig(previousCfg, ctx.controls.configPath);
    await reply(
      ctx,
      rollbackError
        ? `❌ **切换失败**：${reason}\n\n旧 bot 仍在线，但配置回滚失败：${rollbackError}\n请不要重启服务，并检查本机配置。`
        : `❌ **切换失败**：${reason}\n\n当前仍由 **${fromName}** 提供服务，原配置已恢复。`,
    );
  }
}

async function restoreAccountConfig(cfg: AppConfig, configPath: string): Promise<string | undefined> {
  try {
    await saveConfig(cfg, configPath);
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.fail('account', err, { step: 'switch-rollback' });
    return message;
  }
}

async function restoreAccountSecret(
  secretKey: string,
  previousSecret: string | undefined,
): Promise<string | undefined> {
  try {
    if (previousSecret === undefined) await removeSecret(secretKey);
    else await setSecret(secretKey, previousSecret);
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.fail('account', err, { step: 'switch-secret-rollback' });
    return message;
  }
}

async function sendAccountTakeoverNotice(
  channel: LarkChannel,
  cfg: AppConfig,
  toName: string,
  fromName: string,
): Promise<void> {
  const adminOpenId = cfg.preferences?.access?.admins?.[0];
  if (!adminOpenId) return;
  await channel.rawClient.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: adminOpenId,
      msg_type: 'interactive',
      content: JSON.stringify(accountTakeoverCard(toName, fromName)),
    },
  }).catch((err) => {
    log.warn('account', 'takeover-notice-failed', {
      appId: cfg.accounts.app.id,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has buttons (list / add / change) — never updated
  // in-place, so an inline card is sufficient (and avoids creating a
  // managed card we'd never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
    profiles: switchableAccountProfiles(ctx.controls.cfg),
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function showAccountList(ctx: CommandContext): Promise<void> {
  const card = accountListCard({
    currentAppId: ctx.controls.cfg.accounts.app.id,
    currentBotName: ctx.channel.botIdentity?.name,
    profiles: switchableAccountProfiles(ctx.controls.cfg),
  });
  // Do not recall the source card inside its own action callback. Feishu may
  // reject the callback acknowledgement with code 200530 if the carrier
  // message disappears before it confirms the click. Leave it as history and
  // await the new managed card so callback completion means send completion.
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function showAddCard(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await ctx.channel.send(ctx.msg.chatId, { card: accountAddCard() });
}

// ─── /account add — QR enrollment (agent-driven, no manual credentials) ──

let qrEnrollmentInFlight = false;

async function startAccountQrEnrollment(ctx: CommandContext): Promise<void> {
  if (qrEnrollmentInFlight) {
    await reply(ctx, '⚠️ 已有一个账号录入在进行中，请先完成或稍后再试。');
    return;
  }
  qrEnrollmentInFlight = true;
  const channel = ctx.channel;
  const chatId = ctx.msg.chatId;
  const cfg = ctx.controls.cfg;
  const configPath = ctx.controls.configPath;
  // The SDK promise resolves only after the user completes the scan; cap
  // the wait well beyond the QR expiry so a stalled flow can't hang forever.
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('录入超时：二维码已过期，请重发 /account add 重试。')), 15 * 60_000);
  });

  void (async () => {
    try {
      const result = await Promise.race([
        registerAppViaChat(async (update) => {
          await channel.send(chatId, { card: accountQrCard(update.url, update.expireMinutes) });
        }),
        timeout,
      ]);
      const appId = result.clientId;
      const v = await validateAppCredentials(appId, result.clientSecret, result.tenant);
      if (!v.ok) {
        await channel.send(chatId, {
          card: accountFailureCard(`扫码创建的应用校验失败：${v.reason ?? 'unknown'}`),
        });
        return;
      }
      await setSecret(secretKeyForApp(appId), result.clientSecret);
      upsertAccountProfile(cfg, {
        name: v.botName ?? appId,
        appId,
        tenant: result.tenant,
        access: result.operatorOpenId ? { admins: [result.operatorOpenId] } : {},
      });
      await saveConfig(cfg, configPath);
      await channel.send(chatId, { card: accountEnrollSuccessCard(v.botName ?? appId, appId) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await channel.send(chatId, { card: accountFailureCard(`录入失败：${msg}`) }).catch(() => {});
      // A late resolution after the timeout is intentionally discarded —
      // the user was told to retry and nothing was persisted.
    } finally {
      qrEnrollmentInFlight = false;
    }
  })().catch((err) => log.fail('command', err, { step: 'account-qr' }));
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  const restart = ctx.controls.restart;

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. The agent-visible lark-cli Profile is provisioned during
    // restart from this encrypted source; neither config.json nor logs carry
    // the plaintext.
    const previousCfg = structuredClone(ctx.controls.cfg);
    const secretKey = secretKeyForApp(appId);
    let previousSecret: string | undefined;
    let secretWritten = false;
    let newCfg: AppConfig;
    let handoffCode: string | undefined;
    try {
      // Capture the previous target secret before overwriting it so a failed
      // handshake can restore both config.json and the encrypted keystore.
      previousSecret = await getSecret(secretKey);
      ensureAccountProfiles(ctx.controls.cfg);
      const prevApp = ctx.controls.cfg.accounts.app;
      newCfg = await buildEncryptedAccountConfig(prevApp.id, prevApp.tenant, ctx.controls.cfg.preferences);
      await setSecret(secretKey, appSecret);
      secretWritten = true;
      newCfg.accounts.profiles = structuredClone(getAccountProfiles(ctx.controls.cfg));
      const existingTarget = getAccountProfiles(newCfg).find((profile) => profile.appId === appId);
      upsertAccountProfile(newCfg, {
        name: result.botName ?? appId,
        appId,
        tenant,
        // Re-entering credentials for an existing profile must not erase its
        // app-scoped admins/allowlists and force an unnecessary re-claim.
        ...(existingTarget?.access ? { access: existingTarget.access } : {}),
      });
      const target = getAccountProfiles(newCfg).find((p) => p.appId === appId);
      if (!target) throw new Error('new account profile missing after save');
      handoffCode = switchActiveAccount(newCfg, target, {
        outgoingName: ctx.channel.botIdentity?.name,
      }).handoffCode;
      await saveConfig(newCfg, configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rollbackError = secretWritten
        ? await restoreAccountSecret(secretKey, previousSecret)
        : undefined;
      await finishFailure(
        rollbackError
          ? `保存凭据失败：${msg}；旧 Secret 恢复失败：${rollbackError}`
          : `保存凭据失败：${msg}`,
      );
      return;
    }

    const fromName = channel.botIdentity?.name ?? previousCfg.accounts.app.id;
    const toName = result.botName ?? appId;
    const handoffNote = handoffCode
      ? `新 bot 的管理员尚未绑定。请私聊新 bot 发送：\`/claim ${handoffCode}\``
      : undefined;
    await waitForSettle();
    await updateManagedCard(
      channel,
      formMsgId,
      accountSwitchProgressCard(fromName, toName, handoffNote),
    ).catch((err) => log.warn('account', 'change-progress-update-failed', { err: String(err) }));
    try {
      await restart({
        beforeDisconnect: async ({ channel: nextChannel, cfg }) => {
          await updateManagedCard(
            channel,
            formMsgId,
            accountSwitchConnectedCard(fromName, toName, new Date(), handoffNote),
          ).catch((err) =>
            log.warn('account', 'change-connected-update-failed', { err: String(err) }),
          );
          forgetManagedCard(formMsgId);
          await sendAccountTakeoverNotice(nextChannel, cfg, toName, fromName);
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const rollbackErrors = [
        await restoreAccountConfig(previousCfg, configPath),
        await restoreAccountSecret(secretKey, previousSecret),
      ].filter((message): message is string => Boolean(message));
      await updateManagedCard(
        channel,
        formMsgId,
        accountSwitchFailedCard(
          fromName,
          toName,
          reason,
          rollbackErrors.length === 0,
          rollbackErrors.join('；'),
        ),
      ).catch((updateErr) =>
        log.warn('account', 'change-failed-update-failed', { err: String(updateErr) }),
      );
      forgetManagedCard(formMsgId);
    }
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ─── /account switch — text command (index) + profile-list form submit ───

async function submitAccountSwitch(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const targetId = String(fv.account_switch_target ?? '').trim();
  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  const restart = ctx.controls.restart;

  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };
    const freshList = (errorMessage?: string): object => {
      const cfg = ctx.controls.cfg;
      return accountListCard({
        currentAppId: cfg.accounts.app.id,
        currentBotName: channel.botIdentity?.name,
        profiles: switchableAccountProfiles(cfg),
        errorMessage,
      });
    };

    const target = switchableAccountProfiles(ctx.controls.cfg).find((p) => p.appId === targetId);
    const fail = async (message: string, resendList: boolean): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(message)).catch((err) =>
        log.warn('account', 'switch-update-failed', { err: String(err) }),
      );
      forgetManagedCard(formMsgId);
      if (resendList) {
        await channel
          .send(ctx.msg.chatId, { card: freshList() })
          .catch((err) => log.warn('account', 'switch-list-send-failed', { err: String(err) }));
      }
    };

    if (!target) {
      await fail('账号档案不存在，请刷新列表。', true);
      return;
    }
    if (target.appId === ctx.controls.cfg.accounts.app.id) {
      await fail('该账号已是当前账号。', false);
      return;
    }
    const secret = await getSecret(secretKeyForApp(target.appId)).catch(() => undefined);
    if (!secret) {
      await fail(
        '该账号的 Secret 在本机 keystore 中缺失，请通过「绑定已有应用」重新录入。',
        true,
      );
      return;
    }
    const v = await validateAppCredentials(target.appId, secret, target.tenant);
    if (!v.ok) {
      await fail(`校验失败：${v.reason ?? 'unknown'}`, true);
      return;
    }

    const fromName = channel.botIdentity?.name ?? ctx.controls.cfg.accounts.app.id;
    const toName = v.botName ?? target.name;
    const previousCfg = structuredClone(ctx.controls.cfg);
    const nextCfg = structuredClone(ctx.controls.cfg);
    const result = switchActiveAccount(nextCfg, { ...target, name: toName }, {
      outgoingName: channel.botIdentity?.name,
    });
    try {
      await saveConfig(nextCfg, configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await fail(`保存配置失败：${msg}`, false);
      return;
    }
    const seedNote = result.handoffCode
      ? `新 bot 的管理员尚未绑定。请私聊新 bot 发送：\`/claim ${result.handoffCode}\``
      : undefined;
    await waitForSettle();
    await updateManagedCard(channel, formMsgId, accountSwitchProgressCard(fromName, toName, seedNote)).catch(
      (err) => log.warn('account', 'switch-update-failed', { err: String(err) }),
    );
    try {
      await restart({
        beforeDisconnect: async ({ channel: nextChannel, cfg }) => {
          await updateManagedCard(
            channel,
            formMsgId,
            accountSwitchConnectedCard(fromName, toName, new Date(), seedNote),
          ).catch((err) =>
            log.warn('account', 'switch-connected-update-failed', { err: String(err) }),
          );
          forgetManagedCard(formMsgId);
          await sendAccountTakeoverNotice(nextChannel, cfg, toName, fromName);
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const rollbackError = await restoreAccountConfig(previousCfg, configPath);
      await updateManagedCard(
        channel,
        formMsgId,
        accountSwitchFailedCard(fromName, toName, reason, !rollbackError, rollbackError),
      ).catch((updateErr) =>
        log.warn('account', 'switch-failed-update-failed', { err: String(updateErr) }),
      );
      forgetManagedCard(formMsgId);
    }
  })();
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.cfg.preferences?.access ?? {};
  const card = configFormCard({
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    agentReasoningEffort: getAgentReasoningEffort(ctx.controls.cfg),
    effortOptions: ctx.agent.effortOptions ? [...ctx.agent.effortOptions] : undefined,
    agentType: getAgentType(ctx.controls.cfg),
    agentPermissionMode: getAgentPermissionMode(ctx.controls.cfg),
    agentProvider: getAgentProvider(ctx.controls.cfg),
    agentModel: getAgentModel(ctx.controls.cfg),
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    allowedUsers: (access.allowedUsers ?? []).join(', '),
    allowedChats: (access.allowedChats ?? []).join(', '),
    admins: (access.admins ?? []).join(', '),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, configCancelledCard()).catch((err) =>
        log.warn('command', 'config-cancel-update-failed', { err: String(err) }),
      );
      forgetManagedCard(formMsgId);
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : 'card';
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);

  // Form field names are agent_reasoning_effort / agent_permission_mode;
  // legacy codex_* names still accepted so cards rendered by an older
  // bridge keep submitting correctly across an upgrade.
  // Reasoning effort is opaque per adapter (vocabularies differ) — accept
  // the submitted value verbatim; the adapter warns and ignores unknown
  // values at run time.
  const rawReasoningEffort = String(fv.agent_reasoning_effort ?? fv.codex_reasoning_effort ?? '').trim();
  let agentReasoningEffort = getAgentReasoningEffort(ctx.controls.cfg);
  if (rawReasoningEffort === 'default') {
    agentReasoningEffort = undefined;
  } else if (rawReasoningEffort) {
    agentReasoningEffort = rawReasoningEffort;
  }

  const rawPermissionMode = String(fv.agent_permission_mode ?? fv.codex_permission_mode ?? '').trim();
  let agentPermissionMode = getAgentPermissionMode(ctx.controls.cfg);
  if (rawPermissionMode === 'default') {
    agentPermissionMode = undefined;
  } else if (isCodexPermissionMode(rawPermissionMode)) {
    agentPermissionMode = rawPermissionMode;
  }

  // Agent type switch. The config vocabulary (AGENT_TYPES) is validated
  // here; the registry stays the source of implementations. Takes effect
  // through the standard post-save restart, which re-resolves the adapter.
  const rawAgentType = String(fv.agent_type ?? '').trim();
  const nextAgentType = isAgentType(rawAgentType) ? rawAgentType : getAgentType(ctx.controls.cfg);
  // Adapter identity lives in the spawned agent instance, not in per-run
  // config reads — a change here needs controls.restart() to take effect.
  // Snapshot BEFORE the config object below is mutated in place.
  const prevAgentType = getAgentType(ctx.controls.cfg);
  const prevProvider = getAgentProvider(ctx.controls.cfg);
  const prevKeyRefId = (getAgentApiKeyRef(ctx.controls.cfg) as { id?: unknown } | undefined)?.id;

  // Provider / model / provider API key (claude adapter). Empty key input =
  // keep whatever is configured; switching back to 官方登录 drops the ref.
  const rawProvider = String(fv.agent_provider ?? '').trim();
  const prevAgent = ctx.controls.cfg.preferences?.agent ?? {};
  let agentProvider: string | undefined = getAgentProvider(ctx.controls.cfg);
  if (rawProvider === 'anthropic') {
    agentProvider = undefined;
  } else if (rawProvider in PROVIDER_PROFILES) {
    agentProvider = rawProvider;
  }
  const agentModel = String(fv.agent_model ?? '').trim() || getAgentModel(ctx.controls.cfg);
  const rawApiKey = String(fv.agent_api_key ?? '').trim();
  let agentKeyConfigured = false;
  let agentApiKeyRef: SecretInput | undefined = prevAgent.apiKey;
  if (rawApiKey && agentProvider) {
    // Plaintext goes into the keystore; config.json only carries an exec
    // SecretRef (same pattern as the bot's App Secret).
    await setSecret(secretKeyForProvider(agentProvider), rawApiKey);
    agentApiKeyRef = { source: 'exec', provider: 'bridge', id: secretKeyForProvider(agentProvider) };
  }
  // A stored ref is only valid for the provider it was minted for — keep it
  // across /config submits only when the provider didn't change (or a fresh
  // key was just entered). Switching providers without a new key drops it,
  // otherwise the new vendor would receive the old vendor's key.
  const refId = (agentApiKeyRef as { id?: unknown } | undefined)?.id;
  const refValidForProvider =
    typeof refId === 'string' && agentProvider !== undefined && refId === secretKeyForProvider(agentProvider);
  agentApiKeyRef = agentProvider && (rawApiKey || refValidForProvider) ? agentApiKeyRef : undefined;
  agentKeyConfigured = Boolean(agentApiKeyRef);
  const agentProviderNote = agentProvider
    ? PROVIDER_PROFILES[agentProvider]?.note
    : undefined;

  // Parse access lists. Comma-separated; trim each, drop empties, dedupe.
  // Empty list = unrestricted (back-compat).
  const parseList = (raw: unknown): string[] => {
    return [...new Set(
      String(raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )];
  };
  const allowedUsers = parseList(fv.allowed_users);
  const allowedChats = parseList(fv.allowed_chats);
  const admins = parseList(fv.admins);

  // Self-lockout guard: if the submitter sets a non-empty admins list that
  // doesn't include themselves, they immediately lose the ability to reopen
  // /config. Refuse the submit and tell them what's wrong.
  if (admins.length > 0 && !admins.includes(ctx.msg.senderId)) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'admins',
      sender: ctx.msg.senderId.slice(-6),
      proposedAdmins: admins.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的管理员列表,但其中不包含你自己的 open_id (\`${ctx.msg.senderId}\`)。这会立即把你自己锁出 /config。请把自己的 open_id 加进去再提交。`,
    );
    return;
  }

  // Symmetrical guard for chat allowlist: if the submitter restricts chats
  // but the chat they're currently in isn't on the list, every message
  // (including the next /config) is silently dropped at intake. Common
  // mistake: filling in *another* chat's id and forgetting the current one.
  //
  // Skipped for p2p: `allowedChats` is group-only (see intakeMessage), so
  // submitting from a DM never locks the submitter out regardless of the
  // chat list contents. Using `chatMode` not `msg.chatType` because card
  // submissions arrive with a synthesized msg that always has chatType='p2p'.
  if (
    ctx.chatMode !== 'p2p' &&
    allowedChats.length > 0 &&
    !allowedChats.includes(ctx.msg.chatId)
  ) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'chats',
      currentChat: ctx.msg.chatId.slice(-6),
      proposedChats: allowedChats.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的群白名单,但其中不包含当前会话的 chat_id (\`${ctx.msg.chatId}\`)。提交后这个会话的消息会被 intake 静默丢弃,bot 不再响应。要么把当前 chat_id 加进白名单,要么清空"群白名单"留待空(=所有会话都响应)。`,
    );
    return;
  }

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // In-place mutation — the cfg object is shared by reference with
    // runAgentBatch's reads, so this takes effect on the next message.
    ctx.controls.cfg.preferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      agent: {
        type: nextAgentType,
        provider: agentProvider,
        model: agentModel,
        reasoningEffort: agentReasoningEffort,
        permissionMode: agentPermissionMode,
        ...(agentApiKeyRef ? { apiKey: agentApiKeyRef } : {}),
      } satisfies AgentConfig,
      requireMentionInGroup,
      // Empty arrays serialize fine but read identically to omitted ones
      // (isUserAllowed / isAdmin both treat length===0 as unrestricted).
      access: { allowedUsers, allowedChats, admins },
    };
    // `preferences.access` is the live view for the selected application.
    // Keep the saved profile in sync so switching away and back never
    // restores stale rules or an old app's open_ids.
    ensureAccountProfiles(ctx.controls.cfg);
    const currentProfile = getAccountProfiles(ctx.controls.cfg).find(
      (profile) => profile.appId === ctx.controls.cfg.accounts.app.id,
    );
    if (currentProfile) currentProfile.access = { allowedUsers, allowedChats, admins };
    // The agent section now owns reasoning/permission values — drop the
    // legacy top-level fields so the config carries one source of truth.
    delete ctx.controls.cfg.preferences.codexReasoningEffort;
    delete ctx.controls.cfg.preferences.codexPermissionMode;

    try {
      await saveConfig(ctx.controls.cfg, configPath);
    } catch (err) {
      log.fail('command', err, { step: 'config.save' });
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, configCancelledCard()).catch(() => {});
      forgetManagedCard(formMsgId);
      return;
    }

    log.info('command', 'config-saved', {
      messageReply,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      agentType: nextAgentType,
      agentProvider: agentProvider ?? 'anthropic',
      agentModel: agentModel ?? 'default',
      agentKeyConfigured,
      agentReasoningEffort: agentReasoningEffort ?? 'default',
      agentPermissionMode: agentPermissionMode ?? 'default',
      requireMentionInGroup,
      allowedUsersCount: allowedUsers.length,
      allowedChatsCount: allowedChats.length,
      adminsCount: admins.length,
    });
    await waitForSettle();
    await updateManagedCard(
      channel,
      formMsgId,
      configSavedCard({
        messageReply,
        showToolCalls,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        agentType: nextAgentType,
        agentProvider,
        agentProviderNote,
        agentKeyConfigured,
        agentModel,
        agentReasoningEffort,
        agentPermissionMode,
        requireMentionInGroup,
        allowedUsers: allowedUsers.join(', '),
        allowedChats: allowedChats.join(', '),
        admins: admins.join(', '),
      }),
    ).catch((err) =>
      log.warn('command', 'config-save-update-failed', { err: String(err) }),
    );

    // Adapter-identity changes (agent type / provider / provider key) only
    // take effect through a restart — the run path reads config per-run, but
    // the adapter instance itself was resolved at start/restart time.
    const newKeyRefId = (agentApiKeyRef as { id?: unknown } | undefined)?.id;
    const agentIdentityChanged =
      nextAgentType !== prevAgentType ||
      agentProvider !== prevProvider ||
      newKeyRefId !== prevKeyRefId;
    if (agentIdentityChanged) {
      log.info('command', 'config-agent-restart', { from: prevAgentType, to: nextAgentType });
      try {
        await ctx.controls.restart();
      } catch (err) {
        log.warn('command', 'config-agent-restart-failed', { err: String(err) });
        await reply(ctx, `⚠️ 配置已保存，但切换 agent 重连失败：${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
    }
    forgetManagedCard(formMsgId);
  })();
}
