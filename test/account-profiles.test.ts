import { describe, expect, it } from 'vitest';
import {
  accountScope,
  claimPendingAdminHandoff,
  ensureAccountProfiles,
  getAccountProfiles,
  isAdmin,
  larkCliProfileName,
  switchActiveAccount,
  switchableAccountProfiles,
  upsertAccountProfile,
  type AccountProfile,
  type AppConfig,
} from '../src/config/schema';

function makeCfg(appId = 'cli_aaa', profiles?: AccountProfile[]): AppConfig {
  return {
    accounts: {
      app: { id: appId, secret: 'plain-secret', tenant: 'feishu' },
      ...(profiles ? { profiles } : {}),
    },
    preferences: { access: { admins: ['ou_old_admin'] } },
  } as AppConfig;
}

const PROFILE_B: AccountProfile = {
  name: 'Bot B',
  appId: 'cli_bbb',
  tenant: 'feishu',
  adminOpenId: 'ou_admin_b',
};

describe('account profiles', () => {
  it('migrates a legacy config into a complete account registry', () => {
    const cfg = makeCfg('cli_aaa', [PROFILE_B]);
    expect(ensureAccountProfiles(cfg)).toBe(true);
    expect(getAccountProfiles(cfg)).toEqual([
      {
        name: 'Bot B',
        appId: 'cli_bbb',
        tenant: 'feishu',
        larkCliProfile: 'bridge-cli_bbb',
        access: { admins: ['ou_admin_b'] },
      },
      {
        name: 'cli_aaa',
        appId: 'cli_aaa',
        tenant: 'feishu',
        larkCliProfile: 'bridge-cli_aaa',
        access: { admins: ['ou_old_admin'] },
      },
    ]);
  });

  it('upserts by appId without duplicating the active profile', () => {
    const cfg = makeCfg();
    upsertAccountProfile(cfg, {
      name: 'Bot B (renamed)',
      appId: 'cli_bbb',
      tenant: 'lark',
      access: { admins: ['ou_new_admin'] },
    });
    expect(getAccountProfiles(cfg)).toHaveLength(2);
    expect(getAccountProfiles(cfg).find((p) => p.appId === 'cli_bbb')).toMatchObject({
      name: 'Bot B (renamed)',
      tenant: 'lark',
      larkCliProfile: 'bridge-cli_bbb',
      access: { admins: ['ou_new_admin'] },
    });
  });

  it('keeps every account and restores app-scoped admins when switching', () => {
    const cfg = makeCfg('cli_aaa', [PROFILE_B]);
    const switched = switchActiveAccount(cfg, PROFILE_B, { outgoingName: 'Bot A' });

    expect(switched.handoffCode).toBeUndefined();
    expect(cfg.accounts.app).toEqual({
      id: 'cli_bbb',
      secret: { source: 'exec', provider: 'bridge', id: 'app-cli_bbb' },
      tenant: 'feishu',
    });
    expect(cfg.preferences?.access?.admins).toEqual(['ou_admin_b']);
    expect(switchableAccountProfiles(cfg).map((p) => p.appId)).toEqual(['cli_aaa']);
    expect(getAccountProfiles(cfg).find((p) => p.appId === 'cli_aaa')).toMatchObject({
      name: 'Bot A',
      access: { admins: ['ou_old_admin'] },
    });
  });

  it('requires a one-time code to claim a manually-bound app', () => {
    const cfg = makeCfg('cli_aaa', [
      { name: 'Bot C', appId: 'cli_ccc', tenant: 'feishu' },
    ]);
    const { handoffCode } = switchActiveAccount(cfg, {
      name: 'Bot C', appId: 'cli_ccc', tenant: 'feishu',
    });
    expect(handoffCode).toMatch(/^[A-F0-9]{20}$/);
    expect(isAdmin(cfg, 'ou_attacker')).toBe(false);
    expect(claimPendingAdminHandoff(cfg, 'wrong', 'ou_attacker')).toBe(false);
    expect(claimPendingAdminHandoff(cfg, handoffCode!, 'ou_new_admin')).toBe(true);
    expect(isAdmin(cfg, 'ou_new_admin')).toBe(true);
    expect(claimPendingAdminHandoff(cfg, handoffCode!, 'ou_second')).toBe(false);
    expect(cfg.preferences?.access?.admins).toEqual(['ou_new_admin']);
    expect(getAccountProfiles(cfg).find((p) => p.appId === 'cli_ccc')?.access?.admins).toEqual([
      'ou_new_admin',
    ]);
  });

  it('uses deterministic profile and state namespaces', () => {
    expect(larkCliProfileName('cli_aaa')).toBe('bridge-cli_aaa');
    expect(accountScope('cli_aaa', 'oc_chat:thread')).toBe('app:cli_aaa:oc_chat:thread');
  });
});
