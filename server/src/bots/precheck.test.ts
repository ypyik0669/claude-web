import { describe, it, expect } from 'vitest';
import { runScript, fingerprint } from './precheck.js';

describe('runScript', () => {
  it('captures stdout and exit code', async () => {
    const r = await runScript(process.platform === 'win32' ? 'Write-Output hi' : 'echo hi', { cwd: process.cwd() });
    expect(r.ok).toBe(true); expect(r.stdout.trim()).toBe('hi'); expect(r.code).toBe(0);
  });
  it('a failing script is not ok', async () => {
    const r = await runScript(process.platform === 'win32' ? 'exit 3' : 'exit 3', { cwd: process.cwd() });
    expect(r.ok).toBe(false); expect(r.code).toBe(3);
  });
  it('times out', async () => {
    const r = await runScript(process.platform === 'win32' ? 'Start-Sleep 5' : 'sleep 5', { cwd: process.cwd(), timeoutMs: 300 });
    expect(r.ok).toBe(false); expect(r.timedOut).toBe(true);
  });
  it('fingerprint ignores surrounding whitespace', () => {
    expect(fingerprint(' a\n')).toBe(fingerprint('a'));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});
