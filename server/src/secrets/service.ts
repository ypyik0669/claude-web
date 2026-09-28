import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

export type SecretScheme = 'dpapi' | 'keychain' | 'plain';
const PREFIX = 'enc:';

/**
 * At-rest protection for provider API keys in meta.json.
 * Windows → DPAPI (CurrentUser, via PowerShell ProtectedData — no native module needed),
 * macOS → login keychain (`security`), elsewhere → base64 marker only (documented fallback).
 * Values on disk look like `enc:<scheme>:<payload>`; anything else is treated as legacy plaintext.
 */
export class SecretService {
  readonly scheme: SecretScheme = process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'plain';
  private cache = new Map<string, string>();

  isProtected(v: string | undefined): boolean {
    return !!v && v.startsWith(PREFIX);
  }

  async protect(plain: string, id: string): Promise<string> {
    if (!plain) return plain;
    if (this.isProtected(plain)) return plain;
    try {
      if (this.scheme === 'dpapi') {
        const b64 = Buffer.from(plain, 'utf8').toString('base64');
        const script = `$b=[Convert]::FromBase64String('${b64}');Add-Type -AssemblyName System.Security;$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Convert]::ToBase64String($p)`;
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
        const out = `${PREFIX}dpapi:${stdout.trim()}`;
        this.cache.set(out, plain);
        return out;
      }
      if (this.scheme === 'keychain') {
        const account = `provider-${id}`;
        await execFileAsync('security', ['add-generic-password', '-U', '-s', 'claude-web', '-a', account, '-w', plain], { windowsHide: true, timeout: 20_000 });
        const out = `${PREFIX}keychain:${account}`;
        this.cache.set(out, plain);
        return out;
      }
    } catch (e) {
      console.error('[secrets] protect failed, storing base64:', (e as Error).message);
    }
    const out = `${PREFIX}plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
    this.cache.set(out, plain);
    return out;
  }

  async reveal(v: string | undefined): Promise<string> {
    if (!v) return '';
    if (!this.isProtected(v)) return v; // legacy plaintext
    const hit = this.cache.get(v);
    if (hit !== undefined) return hit;
    const [, scheme, payload] = v.split(':', 3) as [string, SecretScheme, string];
    const rest = v.slice(PREFIX.length + scheme.length + 1);
    let plain = '';
    try {
      if (scheme === 'dpapi') {
        // spliced into a PowerShell string literal: a tampered meta.json must not be able to break out of it
        if (!/^[A-Za-z0-9+/=]*$/.test(rest)) throw new Error('密文格式无效');
        const script = `$b=[Convert]::FromBase64String('${rest}');Add-Type -AssemblyName System.Security;$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Convert]::ToBase64String($p)`;
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
        plain = Buffer.from(stdout.trim(), 'base64').toString('utf8');
      } else if (scheme === 'keychain') {
        const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'claude-web', '-a', rest, '-w'], { windowsHide: true, timeout: 20_000 });
        plain = stdout.replace(/\n$/, '');
      } else {
        plain = Buffer.from(payload ?? rest, 'base64').toString('utf8');
      }
    } catch (e) {
      throw new Error(`无法解密密钥（${scheme}）：${(e as Error).message}`);
    }
    this.cache.set(v, plain);
    return plain;
  }

  /** Short fingerprint for display without revealing the key. */
  fingerprint(plain: string): string {
    return crypto.createHash('sha256').update(plain).digest('hex').slice(0, 8);
  }
}
