import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../src/bot/active-runs';
import { installCardActionAckDispatcher } from '../src/bot/channel';
import {
  accountAddCard,
  accountCurrentCard,
  accountFormCard,
  accountListCard,
} from '../src/card/account-cards';
import { sendManagedCard } from '../src/card/managed';
import { runCommandHandler, type CommandContext } from '../src/commands';
import * as keystore from '../src/config/keystore';
import type { AppConfig } from '../src/config/schema';
import * as configStore from '../src/config/store';
import { SessionStore } from '../src/session/store';
import * as feishuAuth from '../src/utils/feishu-auth';
import { WorkspaceStore } from '../src/workspace/store';

describe('account card callbacks', () => {
  it('returns an immediate empty ACK while dispatching the action through safety', async () => {
    let cardActionHandler: ((raw: unknown) => unknown) | undefined;
    const businessHandler = vi.fn(async () => undefined);
    const pushAction = vi.fn(
      async (_eventId: string, _scope: string, handler: () => Promise<void>) => handler(),
    );
    const channel = {
      dispatcher: {
        register: (handlers: Record<string, (raw: unknown) => unknown>) => {
          cardActionHandler = handlers['card.action.trigger'];
        },
      },
      safety: { pushAction },
      handlers: { cardAction: businessHandler },
    } as unknown as Parameters<typeof installCardActionAckDispatcher>[0];

    installCardActionAckDispatcher(channel);
    expect(cardActionHandler).toBeTypeOf('function');
    const response = cardActionHandler?.({
      context: { open_message_id: 'om_test', open_chat_id: 'oc_test' },
      operator: { open_id: 'ou_test' },
      action: { tag: 'button', name: 'account_list', value: { cmd: 'account.list' } },
    });

    expect(response).toEqual({});
    await vi.waitFor(() => expect(businessHandler).toHaveBeenCalledOnce());
    expect(pushAction).toHaveBeenCalledOnce();
  });

  it('gives every interactive button a stable name', () => {
    const profile = { name: 'Bot B', appId: 'cli_b', tenant: 'feishu' as const };
    const cards = [
      accountCurrentCard({ appId: 'cli_a', tenant: 'feishu', profiles: [profile] }),
      accountAddCard(),
      accountListCard({ currentAppId: 'cli_a', profiles: [profile] }),
      accountFormCard(),
    ];

    const buttons = cards.flatMap(collectButtons);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => typeof button.name === 'string' && button.name.length > 0)).toBe(true);
  });

  it('sends a managed account list without recalling the card being clicked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'account-card-test-'));
    const recall = vi.fn();
    const createCard = vi.fn(async () => ({ data: { card_id: 'card_list' } }));
    const createMessage = vi.fn(async () => ({ data: { message_id: 'om_list' } }));
    const cfg: AppConfig = {
      accounts: {
        app: { id: 'cli_a', secret: 'secret', tenant: 'feishu' },
        profiles: [{ name: 'Bot B', appId: 'cli_b', tenant: 'feishu' }],
      },
    };
    const ctx = {
      channel: {
        botIdentity: { name: 'Bot A' },
        rawClient: {
          cardkit: { v1: { card: { create: createCard } } },
          im: { v1: { message: { create: createMessage, delete: recall } } },
        },
      },
      msg: { chatId: 'oc_chat', messageId: 'om_source', senderId: 'ou_admin', content: '' },
      scope: 'app:cli_a:oc_chat',
      chatMode: 'p2p',
      sessions: new SessionStore(join(dir, 'sessions.json')),
      workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
      agent: { displayName: 'Codex', run: vi.fn() },
      activeRuns: new ActiveRuns(),
      controls: { cfg, configPath: join(dir, 'config.json'), processId: 'p', restart: vi.fn(), exit: vi.fn() },
      fromCardAction: true,
    } as unknown as CommandContext;

    await expect(runCommandHandler('account', 'list', ctx)).resolves.toBe(true);
    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(recall).not.toHaveBeenCalled();
  });

  it('moves the source card from switching to connected and notifies the target admin', async () => {
    const fixture = await makeSwitchFixture();
    vi.spyOn(keystore, 'getSecret').mockResolvedValue('target-secret');
    vi.spyOn(feishuAuth, 'validateAppCredentials').mockResolvedValue({ ok: true, botName: 'Bot B' });
    fixture.restart.mockImplementation(async (options) => {
      const saved = JSON.parse(await readFile(fixture.configPath, 'utf8')) as AppConfig;
      await options?.beforeDisconnect?.({ channel: fixture.targetChannel, cfg: saved });
    });

    await expect(runCommandHandler('account', 'switch', fixture.ctx)).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.updateCard).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    const updates = fixture.updateCard.mock.calls.map((call) =>
      JSON.parse(call[0].data.card.data) as { body: { elements: Array<{ content?: string }> } },
    );
    expect(updates[0]?.body.elements[0]?.content).toContain('正在切换');
    expect(updates[1]?.body.elements[0]?.content).toContain('切换完成');
    expect(updates[1]?.body.elements[0]?.content).toContain('连接已恢复');
    expect(fixture.targetSend).toHaveBeenCalledWith(expect.objectContaining({
      params: { receive_id_type: 'open_id' },
      data: expect.objectContaining({ receive_id: 'ou_admin_b', msg_type: 'interactive' }),
    }));
    const saved = JSON.parse(await readFile(fixture.configPath, 'utf8')) as AppConfig;
    expect(saved.accounts.app.id).toBe('cli_b');
  });

  it('shows a terminal failure and restores the old config when the target cannot connect', async () => {
    const fixture = await makeSwitchFixture();
    vi.spyOn(keystore, 'getSecret').mockResolvedValue('target-secret');
    vi.spyOn(feishuAuth, 'validateAppCredentials').mockResolvedValue({ ok: true, botName: 'Bot B' });
    fixture.restart.mockRejectedValue(new Error('handshake timeout'));

    await expect(runCommandHandler('account', 'switch', fixture.ctx)).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.updateCard).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    const finalCard = JSON.parse(fixture.updateCard.mock.calls[1]![0].data.card.data) as {
      body: { elements: Array<{ content?: string }> };
    };
    expect(finalCard.body.elements[0]?.content).toContain('切换失败');
    expect(finalCard.body.elements[0]?.content).toContain('原配置已恢复');
    expect(fixture.targetSend).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(fixture.configPath, 'utf8')) as AppConfig;
    expect(saved.accounts.app.id).toBe('cli_a');
  });

  it('restores the prior encrypted secret when binding credentials cannot reconnect', async () => {
    const fixture = await makeSwitchFixture();
    fixture.ctx.controls.cfg.accounts.profiles = [
      { name: 'Bot B', appId: 'cli_b', tenant: 'feishu' },
    ];
    fixture.ctx.formValue = {
      app_id: 'cli_b',
      app_secret: 'new-target-secret',
      tenant: 'feishu',
    };
    const getSecret = vi.spyOn(keystore, 'getSecret').mockResolvedValue('old-target-secret');
    const setSecret = vi.spyOn(keystore, 'setSecret').mockResolvedValue(undefined);
    vi.spyOn(keystore, 'removeSecret').mockResolvedValue(true);
    vi.spyOn(feishuAuth, 'validateAppCredentials').mockResolvedValue({ ok: true, botName: 'Bot B' });
    vi.spyOn(configStore, 'buildEncryptedAccountConfig').mockResolvedValue({
      accounts: {
        app: { id: 'cli_a', secret: 'old-active-secret', tenant: 'feishu' },
      },
      preferences: { access: { admins: ['ou_admin_a'] } },
    });
    fixture.restart.mockRejectedValue(new Error('handshake timeout'));

    await expect(runCommandHandler('account', 'submit', fixture.ctx)).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.updateCard).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    expect(getSecret).toHaveBeenCalledWith('app-cli_b');
    expect(setSecret).toHaveBeenNthCalledWith(1, 'app-cli_b', 'new-target-secret');
    expect(setSecret).toHaveBeenNthCalledWith(2, 'app-cli_b', 'old-target-secret');
    const finalCard = JSON.parse(fixture.updateCard.mock.calls[1]![0].data.card.data) as {
      body: { elements: Array<{ content?: string }> };
    };
    expect(finalCard.body.elements[0]?.content).toContain('切换失败');
    expect(finalCard.body.elements[0]?.content).toContain('原配置已恢复');
    const saved = JSON.parse(await readFile(fixture.configPath, 'utf8')) as AppConfig;
    expect(saved.accounts.app.id).toBe('cli_a');
  });

  it('preserves an existing target profile admin when its credentials are replaced', async () => {
    const fixture = await makeSwitchFixture();
    fixture.ctx.formValue = {
      app_id: 'cli_b',
      app_secret: 'replacement-secret',
      tenant: 'feishu',
    };
    vi.spyOn(keystore, 'getSecret').mockResolvedValue('old-target-secret');
    vi.spyOn(keystore, 'setSecret').mockResolvedValue(undefined);
    vi.spyOn(feishuAuth, 'validateAppCredentials').mockResolvedValue({ ok: true, botName: 'Bot B' });
    vi.spyOn(configStore, 'buildEncryptedAccountConfig').mockResolvedValue({
      accounts: {
        app: { id: 'cli_a', secret: 'old-active-secret', tenant: 'feishu' },
      },
      preferences: { access: { admins: ['ou_admin_a'] } },
    });
    let candidateCfg: AppConfig | undefined;
    fixture.restart.mockImplementation(async (options) => {
      candidateCfg = JSON.parse(await readFile(fixture.configPath, 'utf8')) as AppConfig;
      await options?.beforeDisconnect?.({ channel: fixture.targetChannel, cfg: candidateCfg });
    });

    await expect(runCommandHandler('account', 'submit', fixture.ctx)).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.updateCard).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    expect(candidateCfg?.preferences?.access?.admins).toEqual(['ou_admin_b']);
    expect(candidateCfg?.preferences?.pendingAdminHandoff).toBeUndefined();
  });
});

async function makeSwitchFixture(): Promise<{
  ctx: CommandContext;
  configPath: string;
  restart: ReturnType<typeof vi.fn>;
  updateCard: ReturnType<typeof vi.fn>;
  targetSend: ReturnType<typeof vi.fn>;
  targetChannel: CommandContext['channel'];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'account-switch-test-'));
  const configPath = join(dir, 'config.json');
  const updateCard = vi.fn(async () => ({ data: {} }));
  const createCard = vi.fn(async () => ({ data: { card_id: 'card_switch' } }));
  const createMessage = vi.fn(async () => ({ data: { message_id: 'om_switch' } }));
  const targetSend = vi.fn(async () => ({ data: { message_id: 'om_takeover' } }));
  const restart = vi.fn();
  const cfg: AppConfig = {
    accounts: {
      app: { id: 'cli_a', secret: 'old-secret', tenant: 'feishu' },
      profiles: [{
        name: 'Bot B',
        appId: 'cli_b',
        tenant: 'feishu',
        access: { admins: ['ou_admin_b'] },
      }],
    },
    preferences: { access: { admins: ['ou_admin_a'] } },
  };
  const channel = {
    botIdentity: { name: 'Bot A' },
    rawClient: {
      cardkit: { v1: { card: { create: createCard, update: updateCard } } },
      im: { v1: { message: { create: createMessage } } },
    },
  } as unknown as CommandContext['channel'];
  const targetChannel = {
    rawClient: { im: { v1: { message: { create: targetSend } } } },
  } as unknown as CommandContext['channel'];
  const sent = await sendManagedCard(channel, 'oc_chat', accountListCard({
    currentAppId: 'cli_a',
    currentBotName: 'Bot A',
    profiles: cfg.accounts.profiles!,
  }));
  const ctx = {
    channel,
    msg: { chatId: 'oc_chat', messageId: sent.messageId, senderId: 'ou_admin_a', content: '' },
    scope: 'app:cli_a:oc_chat',
    chatMode: 'p2p',
    sessions: new SessionStore(join(dir, 'sessions.json')),
    workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
    agent: { displayName: 'Codex', run: vi.fn() },
    activeRuns: new ActiveRuns(),
    controls: { cfg, configPath, processId: 'p', restart, exit: vi.fn() },
    formValue: { account_switch_target: 'cli_b' },
    fromCardAction: true,
  } as unknown as CommandContext;
  return { ctx, configPath, restart, updateCard, targetSend, targetChannel };
}

function collectButtons(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectButtons);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...(record.tag === 'button' ? [record] : []),
    ...Object.values(record).flatMap(collectButtons),
  ];
}
