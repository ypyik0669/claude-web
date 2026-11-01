import { describe, it, expect } from 'vitest';
import { loopbackHost, sameOriginRequest, wsOriginOk } from './same-origin.js';

const req = (headers: Record<string, string>) => ({ headers: { host: '127.0.0.1:3090', ...headers } });

describe('sameOriginRequest', () => {
  it('lets the app itself (same origin), the dev server proxy and header-less clients through', () => {
    expect(sameOriginRequest(req({ 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3090' }))).toBe(true);
    expect(sameOriginRequest({ headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' } })).toBe(true);
    expect(sameOriginRequest(req({}))).toBe(true);
  });
  it('refuses a page on another website posting to this machine', () => {
    expect(sameOriginRequest(req({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false);
    expect(sameOriginRequest(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(sameOriginRequest(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(sameOriginRequest(req({ origin: 'null' }))).toBe(false);
    expect(sameOriginRequest(req({ origin: 'http://127.0.0.1:9999' }))).toBe(false);
  });
});

describe('loopbackHost', () => {
  it('takes the loopback names, with or without a port', () => {
    for (const h of ['127.0.0.1:3090', '127.0.0.1', 'localhost:5173', 'LOCALHOST', '[::1]:3090', '[::1]', '127.1.2.3:80']) expect(loopbackHost(h), h).toBe(true);
  });
  it('refuses any other name — a rebound evil.example, the LAN address, look-alikes', () => {
    for (const h of [undefined, '', 'evil.example:3090', 'evil.example', '192.168.1.5:3090', '0.0.0.0:3090', 'localhost.evil.example',
      'a.localhost:3090', '127.0.0.1.evil.example', '127.0.0.256', '[::2]:3090', '[::1]x', 'localhost:3090:1', 'localhost:abc']) expect(loopbackHost(h), String(h)).toBe(false);
  });
});

describe('wsOriginOk', () => {
  it('lets header-less clients and the page this server served through', () => {
    expect(wsOriginOk(req({}))).toBe(true);
    expect(wsOriginOk(req({ origin: 'http://127.0.0.1:3090' }))).toBe(true);
    expect(wsOriginOk({ headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' } })).toBe(true);
  });
  it('refuses a page on another local port, another site and opaque origins', () => {
    expect(wsOriginOk(req({ origin: 'http://127.0.0.1:8888' }))).toBe(false);
    expect(wsOriginOk(req({ origin: 'http://localhost:3090' }))).toBe(false);
    expect(wsOriginOk(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(wsOriginOk(req({ origin: 'null' }))).toBe(false);
    expect(wsOriginOk(req({ origin: 'file://' }))).toBe(false);
  });
});
