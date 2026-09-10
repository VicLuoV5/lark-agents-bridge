import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';

/** Days of `YYYY-MM-DD.log` history to keep. Override via env. */
const LOG_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LARK_CHANNEL_LOG_DAYS ?? 7) || 7,
);

/**
 * Stdout is for humans tailing the terminal. Only these noisy-but-meaningful
 * events bubble up; everything else lives in the JSON log file.
 *
 * Add `phase.event` keys here to surface a new line, but keep the list
 * short — every entry adds noise.
 */
const STDOUT_INFO_ALLOWLIST = new Set<string>([
  'ws.connected',
  'ws.reconnecting',
  'ws.reconnected',
  'intake.enter',
  'card.final',
]);

/**
 * Structured logger.
 *
 * Two destinations on every call:
 *  1. JSON line into `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` — the durable
 *     record `/doctor` greps over.
 *  2. Compact human-readable line on stdout/stderr — for live tailing in dev.
 *
 * Per-message context (traceId, chatId, msgId) is propagated automatically
 * via AsyncLocalStorage; call `withTrace()` once at the entry point and any
 * downstream `log.*` calls pick up the same fields.
 */

export interface LogContext {
  traceId?: string;
  chatId?: string;
  msgId?: string;
}

const als = new AsyncLocalStorage<LogContext>();

let stream: WriteStream | null = null;
let currentDate = '';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function logsDir(): string {
  return join(paths.appDir, 'logs');
}

function getStream(): WriteStream | null {
  const today = todayKey();
  if (stream && currentDate === today) return stream;
  if (stream) {
    try {
      stream.end();
    } catch {
      /* noop */
    }
  }
  try {
    mkdirSync(logsDir(), { recursive: true });
    const next = createWriteStream(join(logsDir(), `${today}.log`), { flags: 'a' });
    // createWriteStream can report permission / sharing failures after this
    // function returns. Without an error listener Node treats that as an
    // unhandled stream error and can crash an otherwise healthy bridge (or a
    // test process using a read-only home directory).
    next.on('error', () => {
      if (stream === next) {
        stream = null;
        currentDate = '';
      }
    });
    stream = next;
    currentDate = today;
    return stream;
  } catch {
    return null;
  }
}

type Level = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/**
 * Field keys we own — callers MUST NOT clobber these via the `fields` arg.
 * If they try (e.g. `log.fail('comment', err, { phase: 'postCommentReply' })`),
 * the caller-supplied value is renamed to `_<key>` so the info isn't lost
 * but `grep '"phase":"comment"'` still finds the entry.
 */
const RESERVED_KEYS = new Set([
  'ts',
  'level',
  'phase',
  'event',
  'traceId',
  'chatId',
  'msgId',
]);

function emit(level: Level, phase: string, event: string, fields: LogFields = {}): void {
  const ctx = als.getStore() ?? {};
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    phase,
    event,
    ...ctx,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(k)) {
      entry[`_${k}`] = v;
    } else {
      entry[k] = v;
    }
  }
  const s = getStream();
  if (s) {
    try {
      s.write(`${JSON.stringify(entry)}\n`);
    } catch {
      /* swallow disk errors — logging should never crash the bot */
    }
  }

  // Stdout is the user-facing tail: warns, errors, and a curated list
  // of info events (WS lifecycle, message intake, run final). The full
  // detail always lives in the file regardless.
  const showOnStdout =
    level !== 'info' || STDOUT_INFO_ALLOWLIST.has(`${phase}.${event}`);
  if (!showOnStdout) return;

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(formatStdout(level, phase, event, ctx, fields));
}

function formatStdout(
  level: Level,
  phase: string,
  event: string,
  ctx: LogContext,
  fields: LogFields,
): string {
  // Friendly shapes for the few events users actually see.
  if (phase === 'ws') {
    if (event === 'connected') {
      const bot = fields.bot ?? '-';
      const appId = fields.appId ? ` (${fields.appId})` : '';
      const agent = fields.agent ?? '-';
      const proc = fields.procId ? `  进程: ${fields.procId}` : '';
      return `✓ 已连接  bot: ${bot}${appId}  agent: ${agent}${proc}`;
    }
    if (event === 'reconnecting') return '↻ 正在重连…';
    if (event === 'reconnected') return '✓ 已重连';
    if (event === 'fail') return `✗ WS 错误: ${fields.err ?? ''}`;
  }
  if (phase === 'intake' && event === 'enter') {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : '-';
    const sender = fields.sender ?? '-';
    const preview = fields.preview ?? '';
    return `▸ ${fields.chatType ?? '?'}/${c} ${sender}: ${preview}`;
  }
  if (phase === 'card' && event === 'final') {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : '-';
    const t = fields.terminal;
    const mark = t === 'done' ? '✓' : t === 'interrupted' ? '⏹' : '✗';
    return `  ${mark} ${c} ${t}`;
  }

  // Generic compact form for warns / errors / unmatched info.
  const ctxBits: string[] = [];
  if (ctx.traceId) ctxBits.push(`t=${ctx.traceId}`);
  if (ctx.chatId) ctxBits.push(`c=${ctx.chatId.slice(-6)}`);
  const ctxStr = ctxBits.length > 0 ? ` ${ctxBits.join(' ')}` : '';
  const summary = formatFields(fields);
  const tag = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '·';
  return `${tag} [${phase}.${event}]${ctxStr}${summary ? ` ${summary}` : ''}`;
}

function formatFields(fields: LogFields): string {
  const keys = Object.keys(fields);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = fields[k];
    if (v === undefined || v === null) continue;
    if (k === 'stack') continue; // skip in stdout, kept in JSON
    if (typeof v === 'string') {
      parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 80)}…` : v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else {
      try {
        const s = JSON.stringify(v);
        parts.push(`${k}=${s.length > 80 ? `${s.slice(0, 80)}…` : s}`);
      } catch {
        parts.push(`${k}=?`);
      }
    }
  }
  return parts.join(' ');
}

export const log = {
  info(phase: string, event: string, fields?: LogFields): void {
    emit('info', phase, event, fields);
  },
  warn(phase: string, event: string, fields?: LogFields): void {
    emit('warn', phase, event, fields);
  },
  fail(phase: string, err: unknown, fields?: LogFields): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // Axios errors carry the Feishu API response at err.response.data — that's
    // where { code, msg, ... } lives. Surface it explicitly so log.fail
    // captures the *actual* server-side reason, not just "status code 400".
    const apiData = (err as { response?: { data?: unknown } })?.response?.data;
    const apiStatus = (err as { response?: { status?: unknown } })?.response?.status;
    emit('error', phase, 'fail', {
      ...fields,
      err: message,
      apiStatus,
      apiData,
      stack,
    });
  },
};

/**
 * Run `fn` inside a logging context. All `log.*` calls inside (including
 * across awaits) pick up `traceId` / `chatId` / `msgId` automatically.
 */
export function withTrace<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  const traceId = ctx.traceId ?? newTraceId();
  return als.run({ ...ctx, traceId }, fn);
}

export function newTraceId(): string {
  // Short, easy-to-grep, base36 random.
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Scrub a log buffer of identifying / credential material before it leaves
 * the local machine — specifically, before /doctor feeds it to the agent (the
 * agent prompt will see it) and before the analysis card lands in a
 * Feishu chat (the Lark server may cache card contents).
 *
 * Conservative: keeps log structure intact so the agent can still correlate by
 * traceId / phase / event. Only the *values* of identifying fields shrink
 * to a last-6-char suffix, and known credential fields become [REDACTED].
 *
 * Pattern-based on purpose — parsing each line as JSON would skip lines the
 * scrubber doesn't fully understand and is much slower for ~60KB of input.
 */
export function sanitizeLogsForDoctor(logs: string): string {
  let out = logs;
  // ID-like JSON fields → last 6 chars only. The 8-char minimum on the
  // value avoids matching short metadata that happens to share a key name.
  out = out.replace(
    /"(chatId|senderId|sender|openId|operatorId|userId|msgId|messageId)":"([^"]{8,})"/g,
    (_, key: string, val: string) => `"${key}":"…${val.slice(-6)}"`,
  );
  // Credential fields → fully redacted. Case-insensitive on the key.
  out = out.replace(
    /"(secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)":"[^"]*"/gi,
    (_, key: string) => `"${key}":"[REDACTED]"`,
  );
  // URL-style tokens in error messages: `?access_token=t-xxx`.
  out = out.replace(
    /\b(access_token|tenant_access_token|app_access_token)=[A-Za-z0-9._\-+/=]+/g,
    '$1=[REDACTED]',
  );
  // HTTP Authorization headers embedded in stringified errors.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer [REDACTED]');
  out = out.replace(/\bAuthorization\s*[:=]\s*\S+/gi, 'Authorization=[REDACTED]');
  return out;
}

/**
 * Read the tail of today's (and optionally yesterday's) log file.
 *
 * Returns up to `maxBytes` of complete JSON lines, oldest-first. If the
 * tail starts mid-line we drop the partial leader.
 */
export async function readRecentLogs(opts: { maxBytes: number }): Promise<string> {
  const today = todayKey();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const todayPath = join(logsDir(), `${today}.log`);
  const yesterdayPath = join(logsDir(), `${yesterday}.log`);

  const tail = await readTail(todayPath, opts.maxBytes);
  if (tail.length >= opts.maxBytes / 2) return tail;

  // Top up from yesterday's file if today's is sparse.
  const remaining = opts.maxBytes - Buffer.byteLength(tail, 'utf8');
  const earlier = await readTail(yesterdayPath, remaining);
  return earlier + tail;
}

/**
 * Delete log files older than the retention window. Best-effort, called
 * on bridge startup. Returns the number of files removed.
 */
export async function gcOldLogs(): Promise<number> {
  const dir = logsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const name of entries) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    const fileMs = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(fileMs) || fileMs >= cutoff) continue;
    try {
      await rm(join(dir, name));
      removed++;
    } catch {
      /* skip */
    }
  }
  if (removed > 0) {
    log.info('logger', 'gc', { removed, retentionDays: LOG_RETENTION_DAYS });
  }
  return removed;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const st = await stat(path);
    const start = Math.max(0, st.size - maxBytes);
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await handle.read(buf, 0, buf.length, start);
      let content = buf.toString('utf8');
      if (start > 0) {
        const nl = content.indexOf('\n');
        if (nl !== -1) content = content.slice(nl + 1);
      }
      return content;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
