import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { tr } from '../i18n/index.js';

/** Where new secrets go. `plain` = no OS store on this machine (base64 marker only). */
export type SecretScheme = 'dpapi' | 'keychain' | 'libsecret' | 'plain';
const PREFIX = 'enc:';
const SERVICE = 'claude-web';
const TIMEOUT = 20_000;

/**
 * Runs a helper. The secret only ever travels in `input` (the child's stdin) — never in `args`,
 * which every local user can read with `ps` / Task Manager (SEC-10).
 */
export type SecretRunner = (cmd: string, args: string[], input?: string) => Promise<{ stdout: string; stderr: string }>;

const runChild: SecretRunner = (cmd, args, input) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out`)); }, TIMEOUT);
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve({ stdout, stderr });
    else reject(Object.assign(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 300)}`), { code, stdout, stderr }));
  });
  child.stdin.on('error', () => { /* child exited early; 'close' reports it */ });
  child.stdin.end(input ?? '');
});

/** `security -i` reads one command per line from a 4096-byte buffer; a longer line is silently cut and the cut prefix stored. */
const SECURITY_LINE_MAX = 4000;
const SAFE_ACCOUNT = /^[A-Za-z0-9._:@/+=-]{1,200}$/;

/** `security -i` command line that stores `data` (as hex, so no quoting rules apply to the value). */
export function keychainAddLine(account: string, data: Buffer, service = SERVICE): string {
  return `add-generic-password -U -s ${service} -a ${account} -X ${data.toString('hex')}`;
}

/** Parse the `password:` line of `security find-generic-password -g` (stderr): `"raw"` for plain printable text, `0xHEX  "…"` otherwise. */
export function parseKeychainPassword(stderr: string): Buffer {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith('password:'));
  if (line === undefined) throw new Error('no password in keychain output');
  const rest = line.slice('password:'.length).trim();
  if (!rest) return Buffer.alloc(0);
  const hex = /^0x([0-9A-Fa-f]*)(?:\s|$)/.exec(rest);
  if (hex) return Buffer.from(hex[1]!, 'hex');
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return Buffer.from(rest.slice(1, -1), 'utf8');
  throw new Error('unrecognised keychain output');
}

/** PowerShell script for DPAPI. The input (plaintext or ciphertext, base64) comes on stdin, not in -Command. */
export function dpapiScript(op: 'Protect' | 'Unprotect'): string {
  return `$i=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($i);Add-Type -AssemblyName System.Security;$p=[System.Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser');[Convert]::ToBase64String($p)`;
}

/**
 * At-rest protection for provider API keys in meta.json.
 * Windows → DPAPI (CurrentUser, via PowerShell ProtectedData — no native module needed),
 * macOS → login keychain (`security -i`, value on stdin as hex), Linux → libsecret (`secret-tool`, value on stdin)
 * when it's installed and a Secret Service answers, elsewhere → base64 marker only (`scheme === 'plain'`, shown in settings).
 * Values on disk look like `enc:<scheme>:<payload>`; anything else is treated as legacy plaintext.
 * Every scheme ever written stays readable on its platform (old `keychain` items were written with `-w`, old `dpapi`
 * with the plaintext in -Command — same storage, only the way in changed).
 */
export class SecretService {
  private _scheme: SecretScheme;
  private readonly platform: NodeJS.Platform;
  private readonly run: SecretRunner;
  private readonly service: string;
  private cache = new Map<string, string>();
  private probe: Promise<void> | null = null;

  constructor(opts: { platform?: NodeJS.Platform; run?: SecretRunner; service?: string } = {}) {
    this.service = opts.service ?? SERVICE;
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? runChild;
    this._scheme = this.platform === 'win32' ? 'dpapi' : this.platform === 'darwin' ? 'keychain' : 'plain';
    if (this.platform === 'linux') this.probe = this.probeSecretTool();
  }

  /** The scheme new secrets get. On Linux it is `plain` until `secret-tool` is found, and drops back to `plain` if storing fails. */
  get scheme(): SecretScheme { return this._scheme; }

  /** Wait for the Linux `secret-tool` probe (no-op elsewhere). */
  async ready(): Promise<SecretScheme> { if (this.probe) await this.probe; return this._scheme; }

  private async probeSecretTool(): Promise<void> {
    try { await this.run('secret-tool', ['--version']); this._scheme = 'libsecret'; } catch (e) {
      // no args / unknown flag → usage + exit 2, which still means it's installed; only ENOENT means it isn't
      if (typeof (e as { code?: unknown }).code === 'number') this._scheme = 'libsecret';
    }
  }

  isProtected(v: string | undefined): boolean {
    return !!v && v.startsWith(PREFIX);
  }

  async protect(plain: string, id: string): Promise<string> {
    if (!plain) return plain;
    if (this.isProtected(plain)) return plain;
    await this.ready();
    let out: string | null = null;
    try {
      if (this._scheme === 'dpapi') {
        const { stdout } = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapiScript('Protect')], Buffer.from(plain, 'utf8').toString('base64'));
        if (!stdout.trim()) throw new Error('empty DPAPI output');
        out = `${PREFIX}dpapi:${stdout.trim()}`;
      } else if (this._scheme === 'keychain') {
        out = await this.keychainStore(accountFor(id), Buffer.from(plain, 'utf8'));
      } else if (this._scheme === 'libsecret') {
        const account = accountFor(id);
        try {
          await this.run('secret-tool', ['store', `--label=${this.service} ${account}`, 'service', this.service, 'account', account], plain);
          out = `${PREFIX}libsecret:${account}`;
        } catch (e) {
          // installed but no Secret Service (headless / no D-Bus session): say so in settings instead of retrying every time
          this._scheme = 'plain';
          throw e;
        }
      }
    } catch (e) {
      console.error('[secrets] protect failed, storing base64:', (e as Error).message);
    }
    out ??= `${PREFIX}plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
    this.cache.set(out, plain);
    return out;
  }

  /** One item when the `security -i` line fits, else `<account>#0..n-1` and `enc:keychain-parts:<n>:<account>`. */
  private async keychainStore(account: string, data: Buffer): Promise<string> {
    const room = Math.floor((SECURITY_LINE_MAX - keychainAddLine(`${account}#99999`, Buffer.alloc(0), this.service).length) / 2);
    if (data.length <= room) {
      await this.securityInteractive(keychainAddLine(account, data, this.service));
      return `${PREFIX}keychain:${account}`;
    }
    const n = Math.ceil(data.length / room);
    for (let i = 0; i < n; i++) await this.securityInteractive(keychainAddLine(`${account}#${i}`, data.subarray(i * room, (i + 1) * room), this.service));
    return `${PREFIX}keychain-parts:${n}:${account}`;
  }

  /** `security -i` exits with the LAST command's status and reports errors on stderr — one command per run, and check both. */
  private async securityInteractive(line: string): Promise<void> {
    if (line.length > SECURITY_LINE_MAX) throw new Error('keychain command too long');
    const { stderr } = await this.run('security', ['-i'], `${line}\n`);
    if (/returned \d+|unknown command|error/i.test(stderr)) throw new Error(stderr.trim().slice(0, 300));
  }

  private async keychainRead(account: string): Promise<Buffer> {
    const { stderr } = await this.run('security', ['find-generic-password', '-s', this.service, '-a', account, '-g']);
    return parseKeychainPassword(stderr);
  }

  async reveal(v: string | undefined): Promise<string> {
    if (!v) return '';
    if (!this.isProtected(v)) return v; // legacy plaintext
    const hit = this.cache.get(v);
    if (hit !== undefined) return hit;
    const scheme = v.slice(PREFIX.length).split(':', 1)[0]!;
    const rest = v.slice(PREFIX.length + scheme.length + 1);
    let plain = '';
    try {
      if (scheme === 'dpapi') {
        if (!/^[A-Za-z0-9+/=]*$/.test(rest)) throw new Error(tr('密文格式无效'));
        const { stdout } = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapiScript('Unprotect')], rest);
        plain = Buffer.from(stdout.trim(), 'base64').toString('utf8');
      } else if (scheme === 'keychain') {
        plain = (await this.keychainRead(rest)).toString('utf8');
      } else if (scheme === 'keychain-parts') {
        const m = /^(\d{1,4}):(.+)$/.exec(rest);
        if (!m) throw new Error(tr('密文格式无效'));
        const parts: Buffer[] = [];
        for (let i = 0; i < Number(m[1]); i++) parts.push(await this.keychainRead(`${m[2]}#${i}`));
        plain = Buffer.concat(parts).toString('utf8');
      } else if (scheme === 'libsecret') {
        const { stdout } = await this.run('secret-tool', ['lookup', 'service', this.service, 'account', rest]);
        plain = stdout;
      } else {
        plain = Buffer.from(rest, 'base64').toString('utf8');
      }
    } catch (e) {
      throw new Error(tr('无法解密密钥（{scheme}）：{message}', { scheme, message: (e as Error).message }));
    }
    this.cache.set(v, plain);
    return plain;
  }

  /** Short fingerprint for display without revealing the key. */
  fingerprint(plain: string): string {
    return crypto.createHash('sha256').update(plain).digest('hex').slice(0, 8);
  }
}

/** Keychain / libsecret account name. Ids with odd characters are hashed so they can't break the `security -i` line. */
function accountFor(id: string): string {
  const a = `provider-${id}`;
  return SAFE_ACCOUNT.test(a) ? a : `provider-h${crypto.createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
}
