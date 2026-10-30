import { describe, it, expect } from 'vitest';
import { runScript, fingerprint } from './precheck.js';

const win = process.platform === 'win32';

describe('runScript', () => {
  it('captures stdout and exit code', async () => {
    const r = await runScript(win ? 'Write-Output hi' : 'echo hi', { cwd: process.cwd() });
    expect(r.ok).toBe(true); expect(r.stdout.trim()).toBe('hi'); expect(r.code).toBe(0);
  });
  it('a failing script is not ok', async () => {
    const r = await runScript('exit 3', { cwd: process.cwd() });
    expect(r.ok).toBe(false); expect(r.code).toBe(3);
  });
  it('times out', async () => {
    const r = await runScript(win ? 'Start-Sleep 5' : 'sleep 5', { cwd: process.cwd(), timeoutMs: 300 });
    expect(r.ok).toBe(false); expect(r.timedOut).toBe(true);
  });
  it('a timeout does not wait for a background child that still holds stdout', async () => {
    const script = win
      ? "Start-Process -NoNewWindow -FilePath ping.exe -ArgumentList '-n','10','127.0.0.1'; Start-Sleep 10"
      : 'sleep 10 & sleep 10';
    const t0 = Date.now();
    const r = await runScript(script, { cwd: process.cwd(), timeoutMs: 800 });
    expect(r.timedOut).toBe(true); expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);
  it('an abort signal stops the script', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const r = await runScript(win ? 'Start-Sleep 10' : 'sleep 10', { cwd: process.cwd(), signal: ac.signal });
    expect(r.ok).toBe(false); expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);
  it('an already aborted signal never runs to completion', async () => {
    const ac = new AbortController(); ac.abort();
    const r = await runScript(win ? 'Write-Output hi' : 'echo hi', { cwd: process.cwd(), signal: ac.signal });
    expect(r.ok).toBe(false);
  });
  it.runIf(win)('keeps non-ASCII output intact on Windows', async () => {
    const r = await runScript("Write-Output '无新邮件'; cmd /c echo 有新邮件", { cwd: process.cwd() });
    expect(r.ok).toBe(true);
    expect(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual(['无新邮件', '有新邮件']);
    expect(fingerprint('无新邮件')).not.toBe(fingerprint('有新邮件'));
  });
  it('fingerprint ignores surrounding whitespace', () => {
    expect(fingerprint(' a\n')).toBe(fingerprint('a'));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});
