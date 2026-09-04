import { describe, expect, it } from 'vitest';
import {
  buildInstallCommand,
  decodeConsoleOutput,
  withAccessDeniedGuidance,
} from '../src/daemon/schtasks';

describe('windows service install (non-admin Register-ScheduledTask)', () => {
  it('builds a logon-triggered command with no execution-time limit', () => {
    const cmd = buildInstallCommand('C:\\Users\\me\\.feishu-codex-bridge\\daemon-launcher.cmd');
    expect(cmd).toContain("Register-ScheduledTask -TaskName 'FeishuCodexBridge.Bot'");
    expect(cmd).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(cmd).toContain("New-ScheduledTaskAction -Execute 'C:\\Users\\me\\.feishu-codex-bridge\\daemon-launcher.cmd'");
    // The launcher's watchdog loop runs indefinitely — the default 72h
    // execution limit would kill the daemon mid-flight.
    expect(cmd).toContain('ExecutionTimeLimit ([TimeSpan]::Zero)');
    expect(cmd).toContain('-Force');
  });

  it('escapes single quotes in the launcher path', () => {
    const cmd = buildInstallCommand("C:\\Users\\o'brien\\.feishu-codex-bridge\\daemon-launcher.cmd");
    expect(cmd).toContain("Execute 'C:\\Users\\o''brien");
  });

  it('decodes GBK console output that UTF-8 mangles', () => {
    // 拒绝访问 ("access denied") in GBK — ground-truth bytes from
    // [System.Text.Encoding]::GetEncoding(936) on Windows.
    const gbk = Buffer.from([0xbe, 0xdc, 0xbe, 0xf8, 0xb7, 0xc3, 0xce, 0xca]);
    expect(decodeConsoleOutput(gbk)).toBe('拒绝访问');
  });

  it('passes clean UTF-8 through unchanged', () => {
    const utf8 = Buffer.from('成功创建计划任务', 'utf8');
    expect(decodeConsoleOutput(utf8)).toBe('成功创建计划任务');
  });

  it('appends elevation guidance when registration is access-denied', () => {
    const denied = { ok: false, stdout: '', stderr: 'Register-ScheduledTask : 拒绝访问。 HRESULT 0x80070005' };
    const guided = withAccessDeniedGuidance(denied);
    expect(guided.ok).toBe(false);
    expect(guided.stderr).toContain('以管理员身份运行');
    expect(guided.stderr).toContain('不再需要管理员');
  });

  it('leaves unrelated failures and successes untouched', () => {
    const unrelated = { ok: false, stdout: '', stderr: '参数无效' };
    expect(withAccessDeniedGuidance(unrelated)).toBe(unrelated);
    const ok = { ok: true, stdout: '', stderr: '' };
    expect(withAccessDeniedGuidance(ok)).toBe(ok);
  });
});
