import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentHistoryEntry } from '../types';

/**
 * Claude Code persists each session as a JSONL file under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the cwd is
 * encoded by replacing every non-alphanumeric character with `-`
 * (e.g. `D:\a\b` → `D--a-b`). Each line carries the session cwd, so the
 * directory itself scopes the listing.
 */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/** Return the most recent `limit` Claude Code sessions for the given cwd, newest first. */
export async function listRecentClaudeSessions(
  cwd: string,
  limit = 5,
): Promise<AgentHistoryEntry[]> {
  const dir = join(claudeConfigDir(), 'projects', encodeClaudeCwd(cwd));
  let files: string[];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => join(dir, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const withStats = await Promise.all(
    files.map(async (path) => {
      try {
        const st = await stat(path);
        return { path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withStats
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);

  const out: AgentHistoryEntry[] = [];
  for (const entry of sorted.slice(0, limit)) {
    const sessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
      entry.path,
    )?.[1];
    if (!sessionId) continue;
    const summary = await summarize(entry.path);
    out.push({ sessionId, mtime: entry.mtime, ...summary });
  }
  return out;
}

/** First user text becomes the preview; count lines while we're there. */
async function summarize(
  path: string,
): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview) {
        try {
          const obj = JSON.parse(line) as {
            type?: string;
            message?: { content?: unknown };
          };
          if (obj.type === 'user') {
            preview = firstText(obj.message?.content);
          }
        } catch {
          /* malformed line */
        }
      } else if (lineCount > 20_000) {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount };
}

function firstText(content: unknown): string {
  if (typeof content === 'string') return content.trim().slice(0, 80);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const text = (block as { type?: string; text?: unknown }).text;
        if ((block as { type?: string }).type === 'text' && typeof text === 'string' && text.trim()) {
          return text.trim().slice(0, 80);
        }
      } else if (typeof block === 'string' && block.trim()) {
        return block.trim().slice(0, 80);
      }
    }
  }
  return '';
}
