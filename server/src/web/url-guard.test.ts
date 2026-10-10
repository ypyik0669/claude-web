import { describe, expect, it } from 'vitest';
import { hostClass, ipClass, resolvedRefusal, urlRefusal } from './url-guard.js';

describe('url-guard', () => {
  it('only http(s) addresses, written in full, without credentials', () => {
    for (const reach of ['browser', 'server'] as const) {
      expect(urlRefusal('https://example.com/a?b=1#c', { reach })).toBeNull();
      expect(urlRefusal('http://example.com', { reach })).toBeNull();
      expect(urlRefusal('file:///C:/Users/x/.ssh/id_rsa', { reach })).toContain('file:');
      expect(urlRefusal('javascript:alert(1)', { reach })).toContain('javascript:');
      expect(urlRefusal('chrome://settings', { reach })).toContain('chrome:');
      expect(urlRefusal('data:text/html,<h1>x</h1>', { reach })).toContain('data:');
      expect(urlRefusal('ftp://example.com/x', { reach })).toContain('ftp:');
      expect(urlRefusal('example.com/page', { reach })).toContain('不是一个完整的网址');
      expect(urlRefusal('', { reach })).toContain('不是一个完整的网址');
      expect(urlRefusal('https://user:pw@example.com/', { reach })).toContain('用户名');
    }
  });

  it('link-local addresses and cloud metadata hosts are refused for everyone', () => {
    for (const reach of ['browser', 'server'] as const) {
      for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://169.254.10.20/', 'http://[fe80::1]/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://100.100.100.200/latest/meta-data', 'http://[fd00:ec2::254]/', 'http://2852039166/' /* 169.254.169.254 as one number */]) {
        expect(urlRefusal(u, { reach }), u).not.toBeNull();
      }
    }
  });

  it('the desktop browser may go anywhere else: it is the user\'s own browser', () => {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1:5173/app', 'http://192.168.1.10:8080/', 'http://10.0.0.5/', 'http://[::1]:3000/', 'http://nas.local/']) {
      expect(urlRefusal(u, { reach: 'browser' }), u).toBeNull();
    }
  });

  it('this server fetching: the public web and the dev server on this machine, not the LAN, not itself', () => {
    const o = { reach: 'server' as const, ownPorts: [3090, 3091] };
    for (const u of ['https://example.com/', 'http://localhost:3000/', 'http://127.0.0.1:5173/', 'http://[::1]:8080/', 'http://app.localhost:3000/', 'http://198.18.0.5/' /* a fake-ip proxy's range is public */]) {
      expect(urlRefusal(u, o), u).toBeNull();
    }
    for (const u of ['http://192.168.1.1/', 'http://10.1.2.3:8080/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://100.64.0.1/', 'http://0.0.0.0:3000/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[::ffff:192.168.1.1]/', 'http://[::]/']) {
      expect(urlRefusal(u, o), u).toContain('内网');
    }
    expect(urlRefusal('http://172.32.0.1/', o)).toBeNull(); // just outside 172.16/12
    for (const u of ['http://127.0.0.1:3090/api/file?path=C:/secret', 'http://localhost:3091/', 'http://[::1]:3090/', 'http://[::ffff:127.0.0.1]:3090/']) {
      expect(urlRefusal(u, o), u).toContain('Claude Web 自己');
    }
    // without the port list the loopback is the dev server
    expect(urlRefusal('http://127.0.0.1:3090/', { reach: 'server' })).toBeNull();
    // the default ports count: this server on :80 is still this server
    expect(urlRefusal('http://localhost/', { reach: 'server', ownPorts: [80] })).toContain('Claude Web 自己');
  });

  it('a name is judged again by what it resolves to', () => {
    const o = { reach: 'server' as const, ownPorts: [3090] };
    expect(resolvedRefusal('http://intranet.example/', ['192.168.5.5'], o)).toContain('内网');
    expect(resolvedRefusal('http://rebind.example/', ['93.184.216.34', '10.0.0.1'], o)).toContain('内网'); // any address counts
    expect(resolvedRefusal('http://meta.example/', ['169.254.169.254'], o)).toContain('元数据');
    expect(resolvedRefusal('http://myapp.test:3090/', ['127.0.0.1'], o)).toContain('Claude Web 自己');
    expect(resolvedRefusal('http://myapp.test:5173/', ['127.0.0.1'], o)).toBeNull();
    expect(resolvedRefusal('https://example.com/', ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], o)).toBeNull();
    expect(resolvedRefusal('https://example.com/', [], o)).toBeNull(); // unknown: the fetch decides
    // the desktop browser is only kept from link-local / metadata
    expect(resolvedRefusal('http://intranet.example/', ['192.168.5.5'], { reach: 'browser' })).toBeNull();
  });

  it('classes', () => {
    expect(ipClass('8.8.8.8')).toBe('public');
    expect(ipClass('127.255.0.1')).toBe('loopback');
    expect(ipClass('::1')).toBe('loopback');
    expect(ipClass('::ffff:7f00:1')).toBe('loopback');
    expect(ipClass('fe80::abcd%eth0')).toBe('linklocal');
    expect(ipClass('2001:db8::1')).toBe('public');
    expect(hostClass('LOCALHOST.')).toBe('loopback');
    expect(hostClass('example.com')).toBe('public');
    expect(hostClass('[::1]')).toBe('loopback');
    expect(hostClass('metadata.google.internal')).toBe('metadata');
  });
});
