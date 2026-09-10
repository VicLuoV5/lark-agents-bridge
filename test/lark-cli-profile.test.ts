import { describe, expect, it } from 'vitest';
import { profileInitArgs } from '../src/runtime/lark-cli-profile';

describe('lark-cli profile provisioning', () => {
  it('uses a named profile and stdin secret instead of global bind', () => {
    expect(profileInitArgs({
      profile: 'bridge-cli_abc',
      appId: 'cli_abc',
      tenant: 'feishu',
    })).toEqual([
      'config',
      'init',
      '--name', 'bridge-cli_abc',
      '--app-id', 'cli_abc',
      '--app-secret-stdin',
      '--brand', 'feishu',
    ]);
  });
});
