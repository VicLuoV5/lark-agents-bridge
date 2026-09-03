import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/agent/codex/adapter';
import { resolveAgent } from '../src/agent/registry';
import {
  getAgentModel,
  getAgentPermissionMode,
  getAgentReasoningEffort,
  getAgentType,
  type AppConfig,
} from '../src/config/schema';

function makeCfg(preferences: Record<string, unknown>): AppConfig {
  return {
    accounts: {
      app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
    },
    preferences,
  } as unknown as AppConfig;
}

describe('agent config resolution', () => {
  it('defaults the agent type to codex', () => {
    expect(getAgentType(makeCfg({}))).toBe('codex');
  });

  it('reads the agent section with legacy codex fields as fallback', () => {
    const legacy = makeCfg({ codexPermissionMode: 'acceptEdits', codexReasoningEffort: 'high' });
    expect(getAgentPermissionMode(legacy)).toBe('acceptEdits');
    expect(getAgentReasoningEffort(legacy)).toBe('high');

    const modern = makeCfg({
      agent: { type: 'codex', model: 'gpt-5.3-codex', permissionMode: 'bypassPermissions', reasoningEffort: 'low' },
      codexPermissionMode: 'acceptEdits',
      codexReasoningEffort: 'high',
    });
    expect(getAgentType(modern)).toBe('codex');
    expect(getAgentModel(modern)).toBe('gpt-5.3-codex');
    expect(getAgentPermissionMode(modern)).toBe('bypassPermissions');
    expect(getAgentReasoningEffort(modern)).toBe('low');
  });

  it('ignores invalid permission modes in both sections', () => {
    const cfg = makeCfg({
      agent: { permissionMode: 'yolo' },
      codexPermissionMode: 'nonsense',
    });
    expect(getAgentPermissionMode(cfg)).toBeUndefined();
  });

  it('keeps opaque reasoning efforts at the agent level', () => {
    const cfg = makeCfg({ agent: { reasoningEffort: 'max' } });
    expect(getAgentReasoningEffort(cfg)).toBe('max');
  });
});

describe('codex adapter run options', () => {
  it('ignores unsupported opaque reasoning efforts at spawn time', () => {
    const args = buildArgs({ prompt: 'hi', reasoningEffort: 'max' });
    expect(args).not.toContain('-c');
  });
});

describe('agent registry', () => {
  it('rejects unknown agent types with a readable error', async () => {
    const r = await resolveAgent('does-not-exist');
    expect(r.adapter).toBeUndefined();
    expect(r.error).toContain('未知的 agent 类型');
    expect(r.error).toContain('codex');
  });
});
