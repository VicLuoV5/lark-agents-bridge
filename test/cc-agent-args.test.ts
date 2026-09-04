import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/agent/claude/adapter';
import { applyProviderEnv } from '../src/agent/claude/provider-env';
import { buildCodeBuddyArgs } from '../src/agent/codebuddy/adapter';
import { buildQwenArgs } from '../src/agent/qwen/adapter';
import { PROVIDER_PROFILES } from '../src/config/provider-profiles';

const EXTRA_DIR = 'D:\\workspace\\.feishu-codex-bridge-tools';

describe('claude args', () => {
  it('builds headless stream-json args with partial messages', () => {
    const args = buildClaudeArgs({ prompt: 'hi' });
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']);
  });

  it('maps the bridge permission vocabulary 1:1 and resumes by id', () => {
    const args = buildClaudeArgs({
      prompt: 'hi',
      permissionMode: 'bypassPermissions',
      model: 'claude-opus-5',
      sessionId: 'sess-9',
    });
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-5');
    expect(args).toContain('--resume');
    expect(args).toContain('sess-9');
  });

  it('adds the lark-cli shim dir via --add-dir', () => {
    const args = buildClaudeArgs({ prompt: 'hi' }, [EXTRA_DIR]);
    expect(args).toContain('--add-dir');
    expect(args).toContain(EXTRA_DIR);
  });
});

describe('claude provider env', () => {
  it('injects nothing for the default anthropic login', () => {
    expect(applyProviderEnv(undefined, undefined, undefined)).toEqual({});
    expect(applyProviderEnv('anthropic', undefined, undefined)).toEqual({});
  });

  it('injects base url, token env, and model tiers for a vendor', () => {
    const env = applyProviderEnv('deepseek', 'sk-test', 'deepseek-v4-pro[1m]');
    expect(env.ANTHROPIC_BASE_URL).toBe(PROVIDER_PROFILES.deepseek?.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]');
  });
});

describe('qwen args (verified against shipped CLI 0.22.3)', () => {
  it('passes the lark-cli dir via stdin only — no directory flags exist', () => {
    const args = buildQwenArgs({ prompt: 'hi' }, [EXTRA_DIR]);
    expect(args).toEqual(['-p', '--output-format', 'stream-json']);
    expect(args).not.toContain('--include-directories');
    expect(args).not.toContain('--add-dir');
    // The docs site advertises these; the shipped binary rejects them.
    expect(args).not.toContain('--include-partial-messages');
    expect(args).not.toContain('--approval-mode');
  });

  it('resumes by session id and passes the model flag', () => {
    const args = buildQwenArgs({ prompt: 'hi', sessionId: 'q1', model: 'qwen3-coder-plus' });
    expect(args).toContain('--resume');
    expect(args).toContain('q1');
    expect(args).toContain('--model');
    expect(args).toContain('qwen3-coder-plus');
  });
});

describe('codebuddy args', () => {
  it('mirrors the claude flag surface', () => {
    const args = buildCodeBuddyArgs(
      { prompt: 'hi', permissionMode: 'acceptEdits', sessionId: 'cb1', model: 'm1' },
      [EXTRA_DIR],
    );
    expect(args).toContain('--add-dir');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).toContain('--resume');
    expect(args).toContain('cb1');
    expect(args).toContain('--model');
    expect(args).toContain('m1');
  });
});
