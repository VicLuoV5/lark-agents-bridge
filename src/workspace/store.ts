import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

interface WorkspaceData {
  chats: Record<string, { cwd: string }>;
  /** Legacy global named workspaces, retained for migration/readback. */
  named: Record<string, string>;
  namedByAccount?: Record<string, Record<string, string>>;
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.workspacesFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
        namedByAccount: parsed.namedByAccount ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.cwd;
  }

  setCwd(chatId: string, cwd: string): void {
    this.data.chats[chatId] = { cwd };
    this.schedulePersist();
  }

  /** Move a legacy chat key into its account namespace once, without loss. */
  migrateChatKey(legacyKey: string, scopedKey: string): void {
    if (legacyKey === scopedKey || this.data.chats[scopedKey] || !this.data.chats[legacyKey]) return;
    this.data.chats[scopedKey] = this.data.chats[legacyKey]!;
    delete this.data.chats[legacyKey];
    this.schedulePersist();
  }

  /** Assign pre-multi-account named workspaces to the formerly active app. */
  migrateLegacyNamed(accountId: string): void {
    if (Object.keys(this.data.named).length === 0 || this.data.namedByAccount?.[accountId]) return;
    this.data.namedByAccount ??= {};
    this.data.namedByAccount[accountId] = { ...this.data.named };
    this.data.named = {};
    this.schedulePersist();
  }

  listNamed(accountId?: string): Record<string, string> {
    if (!accountId) return { ...this.data.named };
    return { ...(this.data.namedByAccount?.[accountId] ?? {}) };
  }

  getNamed(name: string, accountId?: string): string | undefined {
    if (!accountId) return this.data.named[name];
    return this.data.namedByAccount?.[accountId]?.[name];
  }

  saveNamed(name: string, cwd: string, accountId?: string): void {
    if (!accountId) {
      this.data.named[name] = cwd;
    } else {
      this.data.namedByAccount ??= {};
      const scoped = (this.data.namedByAccount[accountId] ??= {});
      scoped[name] = cwd;
    }
    this.schedulePersist();
  }

  removeNamed(name: string, accountId?: string): boolean {
    const target = accountId ? this.data.namedByAccount?.[accountId] : this.data.named;
    if (!target || !(name in target)) return false;
    delete target[name];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      })
      .catch((err: unknown) => {
        log.fail('workspace', err, { step: 'persist' });
      });
  }
}
