import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_NO_PROXY, ProxyManager, bypasses, envProxy, maskProxy, mergeNoProxy, normalizeProxyUrl, overrideNoProxy, pacProxy,
  parseProxyServer, parseProxySetting, parseRegValues, parseScutil, type ProxyDeps,
} from './proxy.js';

// What `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` prints with Clash's system proxy on.
const REG_CLASH = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    DisableCachingOfSSLPages    REG_DWORD    0x0
    MigrateProxy    REG_DWORD    0x1
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;127.*;10.*;172.16.*;192.168.*;*.corp.example;<local>
    AutoConfigURL    REG_SZ
`;

describe('reading the system proxy', () => {
  it('Windows Internet Settings: values, ProxyServer in each spelling, the override list', () => {
    const v = parseRegValues(REG_CLASH);
    expect(v.ProxyEnable).toBe('0x1');
    expect(v.ProxyServer).toBe('127.0.0.1:7890');
    expect(v.AutoConfigURL).toBe('');
    expect(parseProxyServer(v.ProxyServer)).toBe('http://127.0.0.1:7890');
    expect(parseProxyServer('http=127.0.0.1:10809;https=127.0.0.1:10810;socks=127.0.0.1:10808')).toBe('http://127.0.0.1:10810');
    expect(parseProxyServer('http=127.0.0.1:10809;socks=127.0.0.1:10808')).toBe('http://127.0.0.1:10809');
    expect(parseProxyServer('socks=127.0.0.1:10808')).toBeNull();
    expect(parseProxyServer('socks5://127.0.0.1:1080')).toBeNull();
    expect(parseProxyServer('')).toBeNull();
    expect(overrideNoProxy(v.ProxyOverride)).toEqual(['localhost', '.corp.example']);
  });

  it('a PAC file: the first HTTP proxy it hands out; SOCKS-only gives nothing', () => {
    expect(pacProxy('function FindProxyForURL(u,h){ if (isPlainHostName(h)) return "DIRECT"; return "PROXY 127.0.0.1:10809; DIRECT"; }')).toBe('http://127.0.0.1:10809');
    expect(pacProxy('var proxy = "SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808; DIRECT";')).toBeNull();
    expect(pacProxy('return "HTTPS proxy.example:443";')).toBe('https://proxy.example:443');
  });

  it('macOS scutil: the HTTPS proxy (else HTTP), the PAC URL, the exceptions', () => {
    const out = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : intranet.example
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}`;
    expect(parseScutil(out)).toEqual({ url: 'http://127.0.0.1:7891', pacUrl: null, noProxy: ['.local', 'intranet.example'] });
    expect(parseScutil('<dictionary> {\n  HTTPEnable : 0\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://127.0.0.1:1/pac\n}').pacUrl).toBe('http://127.0.0.1:1/pac');
  });

  it('the environment: https first, SOCKS ignored, credentials kept (masked for display)', () => {
    expect(envProxy({ HTTPS_PROXY: 'http://u:p@10.0.0.2:3128', HTTP_PROXY: 'http://x:1' })).toBe('http://u:p@10.0.0.2:3128');
    expect(envProxy({ http_proxy: '127.0.0.1:7890' })).toBe('http://127.0.0.1:7890');
    expect(envProxy({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' })).toBeNull();
    expect(maskProxy('http://u:p@10.0.0.2:3128')).toBe('http://u:***@10.0.0.2:3128');
    expect(maskProxy('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('the setting: default / off / an address; SOCKS and junk refused with a sentence', () => {
    expect(parseProxySetting(undefined)).toEqual({ mode: 'system' });
    expect(parseProxySetting('system')).toEqual({ mode: 'system' });
    expect(parseProxySetting('off')).toEqual({ mode: 'off' });
    expect(parseProxySetting('127.0.0.1:7890')).toEqual({ mode: 'custom', url: 'http://127.0.0.1:7890' });
    expect(() => parseProxySetting('socks5://127.0.0.1:1080')).toThrow(/SOCKS/);
    expect(() => parseProxySetting('::::')).toThrow(/无效/);
    expect(normalizeProxyUrl('ftp://x:1')).toBeNull();
  });
});

describe('what goes direct', () => {
  it('loopback, the LAN (incl. Tailscale), .local always; then NO_PROXY hosts, suffixes, CIDRs, ports', () => {
    for (const u of ['http://127.0.0.1:3090', 'http://localhost:1', 'http://[::1]:1/', 'http://192.168.1.5:8000', 'http://10.2.3.4', 'http://172.20.0.1', 'http://100.101.102.103', 'http://box.local', 'http://[fd00::1]/']) expect(bypasses(u, []), u).toBe(true);
    for (const u of ['https://api.anthropic.com', 'https://172.32.0.1', 'https://8.8.8.8']) expect(bypasses(u, []), u).toBe(false);
    const np = ['.corp.example', 'relay.example', '203.0.113.0/24', 'svc.example:8443', '*.wild.example'];
    expect(bypasses('https://a.b.corp.example/x', np)).toBe(true);
    expect(bypasses('https://corp.example', np)).toBe(true);
    expect(bypasses('https://api.relay.example', np)).toBe(true);
    expect(bypasses('https://notrelay.example', np)).toBe(false);
    expect(bypasses('https://203.0.113.9', np)).toBe(true);
    expect(bypasses('https://svc.example:8443', np)).toBe(true);
    expect(bypasses('https://svc.example', np)).toBe(false);
    expect(bypasses('https://x.wild.example', np)).toBe(true);
    expect(bypasses('https://anything', ['*'])).toBe(true);
  });

  it('NO_PROXY lists merge without duplicates, first spelling wins', () => {
    expect(mergeNoProxy('a.com,Localhost', ['localhost', '127.0.0.1'], undefined)).toBe('a.com,Localhost,127.0.0.1');
  });
});

describe('ProxyManager', () => {


  const make = (env: Record<string, string | undefined>, o: Partial<ProxyDeps> & { setting?: () => unknown } = {}) => {
    const dispatches: (string | null)[] = [];
    const m = new ProxyManager({
      env,
      platform: 'win32',
      detect: o.detect ?? (async () => ({ proxy: { url: 'http://127.0.0.1:7890', noProxy: ['.corp.example'], source: 'system' } })),
      reachable: o.reachable ?? (async () => true),
      onDispatcher: (via) => dispatches.push(via),
    });
    if (o.setting) m.configure(o.setting);

    return { m, env, dispatches };
  };

  it('the system proxy (user report: a ladder in rule mode): children get HTTP(S)_PROXY + NO_PROXY with loopback / LAN, fetch gets a dispatcher', async () => {
    const { m, env, dispatches } = make({ PATH: 'x' });
    const s = await m.refresh();
    expect(s).toMatchObject({ setting: 'system', active: 'http://127.0.0.1:7890', source: 'system', detected: 'http://127.0.0.1:7890' });
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    for (const e of [...LOCAL_NO_PROXY, '.corp.example']) expect(env.NO_PROXY!.split(','), e).toContain(e);
    expect(dispatches).toEqual(['http://127.0.0.1:7890']);
    expect(m.agentFor('https://api.anthropic.com/v1/models')).toBeDefined();
    expect(m.agentFor('http://127.0.0.1:3090/gateway')).toBeUndefined();
    expect(m.agentFor('https://git.corp.example')).toBeUndefined();
  });

  it('a system proxy that refuses connections (the ladder exited, its setting stayed) is not used, and says so', async () => {
    const { m, env, dispatches } = make({}, { reachable: async () => false });
    const s = await m.refresh();
    expect(s.active).toBeNull();
    expect(s.detected).toBe('http://127.0.0.1:7890');
    expect(s.note).toMatch(/连不上/);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(dispatches).toEqual([]);
  });

  it('the environment wins over the system; children keep it as given, loopback is added to their NO_PROXY', async () => {
    let detected = 0;
    const { m, env } = make({ HTTPS_PROXY: 'http://u:p@10.9.9.9:3128', NO_PROXY: 'intra.example' }, { detect: async () => { detected++; return { proxy: null }; } });
    const s = await m.refresh();
    expect(s).toMatchObject({ source: 'env', active: 'http://u:***@10.9.9.9:3128' });
    expect(detected).toBe(0);
    expect(env.HTTPS_PROXY).toBe('http://u:p@10.9.9.9:3128');
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NO_PROXY!.split(',').slice(0, 2)).toEqual(['intra.example', 'localhost']);
  });

  it('off: direct for everything, the environment\'s proxy removed from children; back to system restores it', async () => {
    let setting: unknown = 'off';
    const { m, env, dispatches } = make({ HTTPS_PROXY: 'http://10.9.9.9:3128', NO_PROXY: 'intra.example' }, { setting: () => setting });
    expect((await m.refresh()).active).toBeNull();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe('intra.example');
    expect(m.agentFor('https://api.anthropic.com')).toBeUndefined();
    setting = 'system';
    expect((await m.refresh(true)).active).toBe('http://10.9.9.9:3128');
    expect(env.HTTPS_PROXY).toBe('http://10.9.9.9:3128');
    expect(dispatches).toEqual(['http://10.9.9.9:3128']);
  });

  it('a custom address: used even when it does not answer (the user chose it), with a note; switching away undoes the env', async () => {
    let setting: unknown = 'http://127.0.0.1:7897';
    const { m, env, dispatches } = make({}, { setting: () => setting, reachable: async () => false, detect: async () => ({ proxy: null }) });
    const s = await m.refresh();
    expect(s).toMatchObject({ setting: 'custom', custom: 'http://127.0.0.1:7897', active: 'http://127.0.0.1:7897', source: 'setting' });
    expect(s.note).toMatch(/连不上/);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    setting = 'system';
    expect((await m.refresh(true)).active).toBeNull();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(dispatches).toEqual(['http://127.0.0.1:7897', null]);
  });

  it('looks again only after a minute (no polling, no process per call); concurrent callers share one look', async () => {
    let looks = 0;
    const { m } = make({}, { detect: async () => { looks++; await new Promise((r) => setTimeout(r, 20)); return { proxy: null }; } });
    await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
    await m.refresh();
    expect(looks).toBe(1);
    await m.refresh(true);
    expect(looks).toBe(2);
  });
});

describe('through a real proxy', () => {
  it('agentFor() tunnels node:http requests with CONNECT and leaves the request bytes alone', async () => {
    const seen: string[] = [];
    const target = http.createServer((req, res) => res.end(`${req.method} ${req.url} ${req.rawHeaders.join('|')}`));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const proxyServer = http.createServer((_q, s) => s.end('no forward proxying here'));
    proxyServer.on('connect', (req, sock, head) => {
      seen.push(req.url ?? '');
      const [h, p] = (req.url ?? '').split(':');
      const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
      up.on('error', () => sock.destroy());
    });
    await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
    const purl = `http://127.0.0.1:${(proxyServer.address() as net.AddressInfo).port}`;
    const m = new ProxyManager({ env: {}, platform: 'win32', detect: async () => ({ proxy: null }), reachable: async () => true });
    m.configure(() => purl);
    await m.refresh();
    // a public-looking name that resolves to the local target: the proxy sees the name, not the IP
    const port = (target.address() as net.AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/x', method: 'POST', setHost: false, headers: { Host: 'api.example.test', 'X-Api-Key': 'k', 'content-length': '0' }, agent: m.agentFor('http://api.example.test/v1/x') });
      req.on('response', (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve(t)); });
      req.on('error', reject);
      req.end();
    }).catch((e) => String(e));
    expect(m.agentFor('http://api.example.test/v1/x')).toBeDefined();
    expect(seen.length).toBe(1);
    expect(body).toMatch(/^POST \/v1\/x Host\|api\.example\.test\|X-Api-Key\|k\|content-length\|0/);
    target.close();
    proxyServer.close();
  });
});
