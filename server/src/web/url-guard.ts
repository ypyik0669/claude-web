import net from 'node:net';

/**
 * Where the browser tools may go. Two callers with different reach:
 *  - the built-in browser in a desktop window (`reach: 'browser'`): the user's own browser on the user's own machine —
 *    any http(s) address except link-local ones and cloud metadata hosts;
 *  - this server fetching a page itself (`reach: 'server'`, no desktop window): a model reading web pages must not be
 *    talked into reading the LAN through us, so private networks are refused too. Loopback stays allowed — agents
 *    open the dev server they just started — except this server's own ports (in browser mode without a token,
 *    loopback is trusted there: /api/file would hand out any file).
 * Text in, a sentence out (the model reads it); null = allowed.
 */
export type Reach = 'browser' | 'server';
export type HostClass = 'public' | 'loopback' | 'private' | 'linklocal' | 'metadata';

/** Names cloud platforms answer instance metadata on (the addresses are link-local / CGNAT and caught by class). */
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data', 'metadata.azure.internal', 'metadata.tencentyun.com']);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']);

function v4Class(ip: string): HostClass {
  const [a, b] = ip.split('.').map(Number);
  if (METADATA_IPS.has(ip)) return 'metadata';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'linklocal';
  // 0.0.0.0/8 reaches this host on most systems; 100.64/10 is carrier-grade NAT (Tailscale, Alibaba's metadata)
  if (a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

/** The class of an IP literal (v4, v6, v4-mapped v6). */
export function ipClass(ip: string): HostClass {
  if (net.isIPv4(ip)) return v4Class(ip);
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!net.isIPv6(v6)) return 'public';
  if (METADATA_IPS.has(v6)) return 'metadata';
  if (v6 === '::1') return 'loopback';
  if (v6 === '::') return 'private';
  // ::ffff:a.b.c.d, or the same as two hex groups (how URL writes it): judge the IPv4 address inside
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (dotted) return v4Class(dotted);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return v4Class(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  const first = parseInt(v6.split(':')[0] || '0', 16);
  if ((first & 0xffc0) === 0xfe80) return 'linklocal'; // fe80::/10
  if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  return 'public';
}

/** The class a host NAME has without resolving it (an IP literal is classed by `ipClass`). */
export function hostClass(hostname: string): HostClass {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const bare = h.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return ipClass(bare);
  if (METADATA_HOSTS.has(h)) return 'metadata';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  return 'public';
}

const REFUSED: Record<Exclude<HostClass, 'public' | 'loopback'>, string> = {
  metadata: '这个地址是云平台的实例元数据服务，不能打开',
  linklocal: '这个地址在链路本地网段（169.254.* / fe80::），不能打开',
  private: '这个地址在内网（10.* / 172.16–31.* / 192.168.* / 100.64–127.*）。没有桌面版的内置浏览器时只能打开公网网页和本机（localhost）的开发服务',
};

export interface GuardOptions { reach: Reach; ownPorts?: number[] }

/** Why `raw` may not be opened, or null. Looks at the address as written: `resolvedRefusal` checks what a name resolves to. */
export function urlRefusal(raw: string, o: GuardOptions): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return `「${String(raw).slice(0, 200)}」不是一个完整的网址（要以 http:// 或 https:// 开头）`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `只能打开 http / https 网址，不能打开 ${u.protocol}`;
  if (u.username || u.password) return '网址里带了用户名 / 密码，不能打开';
  return classRefusal(hostClass(u.hostname), u, o);
}

function classRefusal(c: HostClass, u: URL, o: GuardOptions): string | null {
  if (c === 'metadata' || c === 'linklocal') return REFUSED[c];
  if (o.reach !== 'server') return null;
  if (c === 'private') return REFUSED.private;
  if (c === 'loopback') {
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (o.ownPorts?.includes(port)) return '这个地址是 Claude Web 自己，不能打开';
  }
  return null;
}

/**
 * The same judgement on what a host name resolves to (a public-looking name pointing into the LAN). `addresses` come
 * from a DNS lookup; any refused one refuses the URL. Not for IP literals (already judged).
 */
export function resolvedRefusal(raw: string, addresses: string[], o: GuardOptions): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  for (const a of addresses) {
    const why = classRefusal(ipClass(a), u, o);
    if (why) return why;
  }
  return null;
}
