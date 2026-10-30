import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { killTree } from '../agents/kill-tree.js';

const MAX_OUT_BYTES = 64 * 1024;
/** after the tree kill was issued, how long to wait for the shell's 'exit' before giving up on it */
const EXIT_GRACE_MS = 3000;
/**
 * Windows PowerShell 5.1 writes redirected output in the console code page, so 中文 came out as "??" and
 * fingerprints could not tell 无新邮件 from 有新邮件. UTF-8 without a BOM, for both cmdlets and native programs.
 */
const PS_UTF8 = '$__u=New-Object System.Text.UTF8Encoding $false;[Console]::OutputEncoding=$__u;$OutputEncoding=$__u;';

export interface ScriptResult { ok: boolean; stdout: string; stderr: string; code: number | null; timedOut: boolean }

/** Keeps the first MAX_OUT_BYTES bytes of a stream; decoded once at the end so a split character stays whole. */
function collector() {
  const parts: Buffer[] = []; let size = 0;
  return {
    push(d: Buffer) { if (size >= MAX_OUT_BYTES) return; const b = d.subarray(0, MAX_OUT_BYTES - size); parts.push(b); size += b.length; },
    text() { return Buffer.concat(parts).toString('utf8'); },
  };
}

/**
 * A pre-check or acceptance script: shell on Unix, PowerShell on Windows. Its stdout is what the caller compares.
 * A timeout or `signal` aborting kills the whole process tree and resolves as soon as the shell is gone — a
 * background child still holding the pipes does not keep the run waiting.
 */
export function runScript(script: string, o: { cwd: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const out = collector(); const err = collector();
    let timedOut = false; let stopped = false; let settled = false;
    const finish = (code: number | null, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve({ ok: !stopped && code === 0, stdout: out.text(), stderr: err.text() + extraErr, code, timedOut });
    };
    const stop = () => {
      if (settled || stopped) return;
      stopped = true;
      void killTree(child).then(() => {
        if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
        else setTimeout(() => finish(child.exitCode), EXIT_GRACE_MS).unref?.();
      });
    };
    const onAbort = () => stop();

    const child = spawn(
      win ? 'powershell.exe' : 'sh',
      win ? ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + script] : ['-c', script],
      { cwd: o.cwd, env: { ...process.env, ...o.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const t = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs ?? 60_000);
    child.on('error', (e) => finish(null, e.message));
    // once stopped, the shell exiting is the end: a surviving grandchild may hold stdout open and delay 'close'
    child.on('exit', (code) => { if (stopped) finish(code); });
    child.on('close', (code) => finish(code));
    if (o.signal?.aborted) stop(); else o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const fingerprint = (stdout: string) => createHash('sha1').update(stdout.trim()).digest('hex');
