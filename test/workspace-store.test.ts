import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/workspace/store';

describe('workspace store account isolation', () => {
  it('moves legacy named workspaces to the formerly active app', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-test-'));
    const file = join(dir, 'workspaces.json');
    await writeFile(file, JSON.stringify({ chats: {}, named: { main: 'D:\\old' } }), 'utf8');
    const store = new WorkspaceStore(file);
    await store.load();
    store.migrateLegacyNamed('cli_a');
    expect(store.getNamed('main', 'cli_a')).toBe('D:\\old');
    expect(store.getNamed('main', 'cli_b')).toBeUndefined();
  });
});
