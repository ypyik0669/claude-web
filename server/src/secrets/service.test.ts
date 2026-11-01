import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { SecretService, parseKeychainPassword, keychainAddLine, dpapiScript, type SecretRunner } from './service.js';

type Call = { cmd: string; args: string[]; input?: string };

/** Records every spawn; `handler` plays the OS helper. */
function recorder(handler: (c: Call) => { stdout?: string; stderr?: string } | Error) {
  const calls: Call[] = [];
  const run: SecretRunner = async (cmd, args, input) => {
    const c = { cmd, args, input };
    calls.push(c);
    const r = handler(c);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { calls, run };
}

/** The secret must not be in argv in any form a `ps` reader could undo. */
function expectNotInArgs(calls: Call[], secret: string) {
  const forms = [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')];
  for (const c of calls) for (const a of [c.cmd, ...c.args]) for (const f of forms) expect(a.includes(f), `${c.cmd} ${c.args.join(' ')}`).toBe(false);
}

/** In-memory keychain behind `security -i` / `find-generic-password -g`. */
function fakeKeychain() {
  const items = new Map<string, Buffer>();
  return recorder((c) => {
    if (c.cmd !== 'security') return new Error('unexpected ' + c.cmd);
    if (c.args[0] === '-i') {
      const line = c.input!.replace(/\n$/, '');
      expect(line.length).toBeLessThanOrEqual(4000);
      const m = /^add-generic-password -U -s (\S+) -a (\S+) -X ([0-9a-f]*)$/.exec(line);
      if (!m) return { stderr: `security: unknown command "${line}"` };
      items.set(`${m[1]}/${m[2]}`, Buffer.from(m[3]!, 'hex'));
      return {};
    }
    if (c.args[0] === 'find-generic-password') {
      const b = items.get(`${c.args[2]}/${c.args[4]}`);
      if (!b) return Object.assign(new Error('not found'), { code: 44 });
      return { stderr: `keychain: "x"\npassword: 0x${b.toString('hex').toUpperCase()}  "…"\n` };
    }
    return new Error('unexpected args');
  });
}

describe('SecretService — macOS keychain', () => {
  it('stores through security -i on stdin, never -w <value> in argv', async () => {
    const kc = fakeKeychain();
    const s = new SecretService({ platform: 'darwin', run: kc.run });
    const secret = 'sk-ant-api03-a"b\'c\\d $x 中文';
    const enc = await s.protect(secret, 'p1');
    expect(enc).toBe('enc:keychain:provider-p1');
    expectNotInArgs(kc.calls, secret);
    expect(kc.calls[0]!.args).toEqual(['-i']);
    expect(await new SecretService({ platform: 'darwin', run: kc.run }).reveal(enc)).toBe(secret);
  });

  it('splits values too long for one security -i line, and joins them back', async () => {
    const kc = fakeKeychain();
    const s = new SecretService({ platform: 'darwin', run: kc.run });
    const secret = crypto.randomBytes(6000).toString('base64');
    const enc = await s.protect(secret, 'up:long');
    expect(enc).toMatch(/^enc:keychain-parts:\d+:provider-up:long$/);
    expectNotInArgs(kc.calls, secret);
    expect(await new SecretService({ platform: 'darwin', run: kc.run }).reveal(enc)).toBe(secret);
  });

  it('hashes ids that would not be a single token on the security -i line', async () => {
    const kc = fakeKeychain();
    const enc = await new SecretService({ platform: 'darwin', run: kc.run }).protect('k', 'a b"c');
    expect(enc).toMatch(/^enc:keychain:provider-h[0-9a-f]{24}$/);
  });

  it('falls back to the plain marker when security reports an error (exit 0 from -i)', async () => {
    const { run } = recorder(() => ({ stderr: 'security: SecKeychainItemCreateFromContent: returned 1' }));
    const enc = await new SecretService({ platform: 'darwin', run }).protect('k1', 'x');
    expect(enc).toBe(`enc:plain:${Buffer.from('k1').toString('base64')}`);
  });

  it('parses both forms of the -g password line', () => {
    expect(parseKeychainPassword('password: "abc"').toString()).toBe('abc');
    expect(parseKeychainPassword('x\npassword: 0x736B0A  "sk\\012"\n').toString()).toBe('sk\n');
    expect(parseKeychainPassword('password: ').length).toBe(0);
    expect(() => parseKeychainPassword('nothing')).toThrow();
  });

  it('keychainAddLine carries the value as hex only', () => {
    expect(keychainAddLine('acc', Buffer.from('ab'), 'svc')).toBe('add-generic-password -U -s svc -a acc -X 6162');
  });
});

describe('SecretService — Windows DPAPI', () => {
  it('passes the plaintext on stdin, not inside -Command', async () => {
    const { calls, run } = recorder((c) => ({ stdout: c.args[3] === dpapiScript('Protect') ? 'Q0lQSEVS\r\n' : Buffer.from('sk-win-secret').toString('base64') }));
    const s = new SecretService({ platform: 'win32', run });
    const enc = await s.protect('sk-win-secret', 'p');
    expect(enc).toBe('enc:dpapi:Q0lQSEVS');
    expect(calls[0]!.cmd).toBe('powershell.exe');
    expect(calls[0]!.input).toBe(Buffer.from('sk-win-secret').toString('base64'));
    expect(await new SecretService({ platform: 'win32', run }).reveal(enc)).toBe('sk-win-secret');
    expect(calls[1]!.input).toBe('Q0lQSEVS');
    expectNotInArgs(calls, 'sk-win-secret');
  });

  it('still refuses a tampered ciphertext', async () => {
    const { run } = recorder(() => ({ stdout: '' }));
    await expect(new SecretService({ platform: 'win32', run }).reveal("enc:dpapi:abc');calc;'")).rejects.toThrow();
  });
});

describe('SecretService — Linux', () => {
  it('uses secret-tool with the value on stdin when it is installed', async () => {
    const store = new Map<string, string>();
    const { calls, run } = recorder((c) => {
      if (c.args[0] === '--version') return Object.assign(new Error('usage'), { code: 1 });
      if (c.args[0] === 'store') { store.set(c.args.at(-1)!, c.input!); return {}; }
      if (c.args[0] === 'lookup') return { stdout: store.get(c.args.at(-1)!) ?? '' };
      return new Error('?');
    });
    const s = new SecretService({ platform: 'linux', run });
    expect(await s.ready()).toBe('libsecret');
    const enc = await s.protect('sk-linux secret\n', 'p');
    expect(enc).toBe('enc:libsecret:provider-p');
    expect(await new SecretService({ platform: 'linux', run }).reveal(enc)).toBe('sk-linux secret\n');
    expectNotInArgs(calls, 'sk-linux secret\n');
  });

  it('stays plain (and says so) without secret-tool', async () => {
    const { run } = recorder(() => Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }));
    const s = new SecretService({ platform: 'linux', run });
    expect(await s.ready()).toBe('plain');
    expect(await s.protect('k', 'p')).toBe(`enc:plain:${Buffer.from('k').toString('base64')}`);
  });

  it('drops to plain when secret-tool is there but no Secret Service answers', async () => {
    const { run } = recorder((c) => (c.args[0] === '--version' ? {} : Object.assign(new Error('Cannot autolaunch D-Bus'), { code: 1 })));
    const s = new SecretService({ platform: 'linux', run });
    expect(await s.ready()).toBe('libsecret');
    expect(await s.protect('k', 'p')).toMatch(/^enc:plain:/);
    expect(s.scheme).toBe('plain');
  });
});

describe('SecretService — old values', () => {
  it('reads legacy plaintext and enc:plain on any platform', async () => {
    const { run } = recorder(() => new Error('no helper should run'));
    const s = new SecretService({ platform: 'linux', run });
    expect(await s.reveal('sk-legacy')).toBe('sk-legacy');
    expect(await s.reveal(`enc:plain:${Buffer.from('sk-old').toString('base64')}`)).toBe('sk-old');
  });
});
