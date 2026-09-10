import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session/store';

describe('session store agent scoping', () => {
  it('does not resume a session created by a different agent runtime', async () => {
    const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'sess-test-')), 'sessions.json'));
    store.set('chat-1', 'codex-sess-1', 'D:\\w', 'codex');
    expect(store.resumeFor('chat-1', 'D:\\w', 'codex')).toBe('codex-sess-1');
    // dsh asking for the same chat/cwd gets nothing — ids don't transfer.
    expect(store.resumeFor('chat-1', 'D:\\w', 'dsh')).toBeUndefined();
    // Switching back after dsh overwrites the entry:
    store.set('chat-1', 'dsh-sess-1', 'D:\\w', 'dsh');
    expect(store.resumeFor('chat-1', 'D:\\w', 'codex')).toBeUndefined();
    expect(store.resumeFor('chat-1', 'D:\\w', 'dsh')).toBe('dsh-sess-1');
  });

  it('treats legacy entries without an agent field as codex', async () => {
    const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'sess-test-')), 'sessions.json'));
    // Simulate a pre-multi-agent sessions.json on disk.
    const fs = await import('node:fs/promises');
    const file = join(await mkdtemp(join(tmpdir(), 'sess-test-')), 'sessions.json');
    await fs.writeFile(
      file,
      `${JSON.stringify({ 'chat-legacy': { sessionId: 'old-1', cwd: 'D:\\w', updatedAt: 1 } })}\n`,
      'utf8',
    );
    const loaded = new SessionStore(file);
    await loaded.load();
    expect(loaded.resumeFor('chat-legacy', 'D:\\w')).toBe('old-1');
    expect(loaded.resumeFor('chat-legacy', 'D:\\w', 'codex')).toBe('old-1');
    expect(loaded.resumeFor('chat-legacy', 'D:\\w', 'dsh')).toBeUndefined();
  });

  it('still requires the cwd to match', async () => {
    const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'sess-test-')), 'sessions.json'));
    store.set('chat-1', 's1', 'D:\\w', 'dsh');
    expect(store.resumeFor('chat-1', 'D:\\other', 'dsh')).toBeUndefined();
  });

  it('migrates a legacy chat key into the current app namespace once', async () => {
    const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'sess-test-')), 'sessions.json'));
    store.set('chat-1', 's1', 'D:\\w', 'codex');
    store.migrateKey('chat-1', 'app:cli_a:chat-1');
    expect(store.getRaw('chat-1')).toBeUndefined();
    expect(store.resumeFor('app:cli_a:chat-1', 'D:\\w', 'codex')).toBe('s1');
    // An app that already has state must never overwrite it from legacy data.
    store.set('chat-2', 'legacy', 'D:\\w', 'codex');
    store.set('app:cli_b:chat-2', 'owned', 'D:\\w', 'codex');
    store.migrateKey('chat-2', 'app:cli_b:chat-2');
    expect(store.resumeFor('app:cli_b:chat-2', 'D:\\w', 'codex')).toBe('owned');
  });
});
