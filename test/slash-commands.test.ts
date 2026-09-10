import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../src/bot/active-runs';
import { tryHandleCommand, type CommandContext } from '../src/commands';
import type { AppConfig } from '../src/config/schema';
import { accountScope } from '../src/config/schema';
import { SessionStore } from '../src/session/store';
import { WorkspaceStore } from '../src/workspace/store';

const cfg: AppConfig = {
  accounts: {
    app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
  },
};

async function makeContext(content: string): Promise<{
  ctx: CommandContext;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  chatCreate: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-codex-bridge-test-'));
  const sessions = new SessionStore(join(dir, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
  const chatCreate = vi.fn(async () => ({ data: { chat_id: 'oc_new_chat' } }));
  const send = vi.fn(async () => undefined);

  const ctx = {
    channel: {
      send,
      rawClient: {
        im: {
          v1: {
            chat: {
              create: chatCreate,
            },
          },
        },
      },
    },
    msg: {
      content,
      chatId: 'oc_source_chat',
      messageId: 'om_msg',
      senderId: 'ou_sender',
    },
    scope: 'oc_source_chat',
    chatMode: 'p2p',
    sessions,
    workspaces,
    agent: { displayName: 'Codex', run: vi.fn() },
    activeRuns: new ActiveRuns(),
    controls: {
      restart: vi.fn(),
      exit: vi.fn(),
      configPath: join(dir, 'config.json'),
      cfg,
      processId: 'proc',
    },
  } as unknown as CommandContext;

  return { ctx, sessions, workspaces, chatCreate, send };
}

describe('slash commands', () => {
  it('creates a new chat for /new and keeps the current session intact', async () => {
    const { ctx, sessions, workspaces, chatCreate, send } = await makeContext('/new 新任务');
    workspaces.setCwd(ctx.scope, 'D:\\Works\\MetaPulse\\Codexwork');
    sessions.set(ctx.scope, 'thread-1', 'D:\\Works\\MetaPulse\\Codexwork');

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(chatCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: '新任务',
        user_id_list: ['ou_sender'],
      }),
      params: { user_id_type: 'open_id' },
    });
    expect(workspaces.cwdFor(accountScope('cli_test', 'oc_new_chat'))).toBe('D:\\Works\\MetaPulse\\Codexwork');
    expect(sessions.getRaw(ctx.scope)?.sessionId).toBe('thread-1');
    expect(send).toHaveBeenCalledWith(
      'oc_new_chat',
      expect.objectContaining({ markdown: expect.stringContaining('cwd 继承自原群') }),
    );
    expect(send).toHaveBeenCalledWith(
      'oc_source_chat',
      expect.objectContaining({ markdown: expect.stringContaining('已创建群') }),
      { replyTo: 'om_msg' },
    );
  });

  it('clears the current session for /reset', async () => {
    const { ctx, sessions, chatCreate, send } = await makeContext('/reset');
    sessions.set(ctx.scope, 'thread-1', 'D:\\Works\\MetaPulse\\Codexwork');

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(chatCreate).not.toHaveBeenCalled();
    expect(sessions.getRaw(ctx.scope)).toBeUndefined();
    expect(send).toHaveBeenCalledWith(
      'oc_source_chat',
      expect.objectContaining({ markdown: '已开始新会话。' }),
      { replyTo: 'om_msg' },
    );
  });

  it('denies sensitive commands until a manual account handoff is claimed', async () => {
    const { ctx, send } = await makeContext('/account');
    ctx.controls.cfg = {
      accounts: {
        app: { id: 'cli_manual', secret: 'secret', tenant: 'feishu' },
      },
      preferences: {
        access: {},
        pendingAdminHandoff: { digest: 'pending' },
      },
    };

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(
      'oc_source_chat',
      expect.objectContaining({ markdown: '❌ 此命令仅管理员可用。' }),
      { replyTo: 'om_msg' },
    );
  });
});
