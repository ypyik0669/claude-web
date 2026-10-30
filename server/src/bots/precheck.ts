import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_OUT = 64 * 1024;

/** A pre-check or acceptance script: shell on Unix, PowerShell on Windows. Its stdout is what the caller compares. */
export function runScript(script: string, o: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'powershell.exe' : 'sh', win ? ['-NoProfile', '-NonInteractive', '-Command', script] : ['-c', script], { cwd: o.cwd, env: { ...process.env, ...o.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); // a multi-byte character split across chunks stays whole
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out = (out + String(d)).slice(0, MAX_OUT); });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT) err = (err + String(d)).slice(0, MAX_OUT); });
    const t = setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs ?? 60_000);
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, stdout: out, stderr: `${err}${e.message}`, code: null, timedOut }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: !timedOut && code === 0, stdout: out, stderr: err, code, timedOut }); });
  });
}

export const fingerprint = (stdout: string) => createHash('sha1').update(stdout.trim()).digest('hex');
