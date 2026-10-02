import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PAGE_KEY, sha256Hex, shellKey, verifiedShellFile, type ShellHashes } from './integrity';

const enc = new TextEncoder();
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const SCOPE = 'https://claude-web-shell.github.io/';
const JS = 'assets/shell-A1.js';
const HASHES: ShellHashes = { [PAGE_KEY]: hex('<html>shell</html>'), 'index.html': hex('<html>shell</html>'), [JS]: hex('console.log(1)') };

function source(o: { key: string | null; cached?: string | null }) {
  const net = new Response('from the network');
  const calls = { cached: 0, drop: 0, network: 0 };
  return {
    calls,
    net,
    src: {
      key: o.key,
      hashes: HASHES,
      cached: async () => {
        calls.cached++;
        return o.cached === null || o.cached === undefined ? undefined : new Response(o.cached);
      },
      drop: async () => {
        calls.drop++;
        return true;
      },
      network: async () => {
        calls.network++;
        return net;
      },
    },
  };
}

describe('verifiedShellFile (F3: a cached shell file is served only with the bytes the build hashed)', () => {
  it('a copy that matches: served from the cache, the network not asked', async () => {
    const t = source({ key: JS, cached: 'console.log(1)' });
    const r = await verifiedShellFile(t.src);
    expect(await r.text()).toBe('console.log(1)');
    expect(t.calls).toEqual({ cached: 1, drop: 0, network: 0 });
  });

  it('a copy that differs (rewritten by a script on this origin): dropped, the network answers', async () => {
    const t = source({ key: JS, cached: 'console.log(1); stealTokens()' });
    expect(await verifiedShellFile(t.src)).toBe(t.net);
    expect(t.calls).toEqual({ cached: 1, drop: 1, network: 1 });
  });

  it('no copy: the network', async () => {
    const t = source({ key: JS, cached: null });
    expect(await verifiedShellFile(t.src)).toBe(t.net);
    expect(t.calls).toEqual({ cached: 1, drop: 0, network: 1 });
  });

  it('not a file of this build (an entry someone added): the cache is not even read', async () => {
    for (const key of ['evil.html', null, '__proto__', 'constructor']) {
      const t = source({ key, cached: 'anything' });
      expect(await verifiedShellFile(t.src)).toBe(t.net);
      expect(t.calls.cached).toBe(0);
    }
  });

  it('the page: its folder entry checked against index.html’s hash', async () => {
    const good = source({ key: PAGE_KEY, cached: '<html>shell</html>' });
    expect(await (await verifiedShellFile(good.src)).text()).toBe('<html>shell</html>');
    const bad = source({ key: PAGE_KEY, cached: '<html>shell</html><script>x()</script>' });
    expect(await verifiedShellFile(bad.src)).toBe(bad.net);
    expect(bad.calls.drop).toBe(1);
  });

  it('a body that cannot be read counts as wrong', async () => {
    const t = source({ key: JS, cached: 'x' });
    t.src.cached = async () => {
      const r = new Response('console.log(1)');
      vi.spyOn(r, 'clone').mockImplementation(() => {
        throw new TypeError('body used');
      });
      return r;
    };
    expect(await verifiedShellFile(t.src)).toBe(t.net);
    expect(t.calls.drop).toBe(1);
  });

  it('sha256Hex is the hex of SHA-256', async () => {
    expect(await sha256Hex(enc.encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('shellKey', () => {
  it('the path under the scope; the page and the bare folder are the page entry; outside the scope: null', () => {
    expect(shellKey(new URL(`${SCOPE}${JS}`), SCOPE, false)).toBe(JS);
    expect(shellKey(new URL(`${SCOPE}index.html`), SCOPE, true)).toBe(PAGE_KEY);
    expect(shellKey(new URL(SCOPE), SCOPE, false)).toBe(PAGE_KEY);
    expect(shellKey(new URL('https://me.github.io/claude-web/assets/x.css'), '/claude-web/', false)).toBe('assets/x.css');
    expect(shellKey(new URL('https://evil.example/assets/x.css'), SCOPE, false)).toBeNull();
    expect(shellKey(new URL('https://me.github.io/other/x.css'), '/claude-web/', false)).toBeNull();
  });
});

describe('the built shell (npm run build -w web)', () => {
  const DIST = path.resolve(__dirname, '../../dist-shell');
  const SW = path.join(DIST, 'sw.js');
  it.skipIf(!fs.existsSync(SW))('sw.js carries the sha256 of every file it precaches, the page included', () => {
    const sw = fs.readFileSync(SW, 'utf8');
    const walk = (rel: string): string[] => fs.readdirSync(path.join(DIST, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(rel, e.name)) : [path.join(rel, e.name)]));
    const files = walk('').filter((f) => f !== 'sw.js');
    expect(files).toContain('index.html');
    for (const f of files) expect(sw, f).toContain(createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex'));
  });
});
