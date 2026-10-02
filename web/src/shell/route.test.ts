import { describe, expect, it } from 'vitest';
import { appEntry, appKey, assetLookup, frameParams, pcPath, refusedApi, route } from './route';

// a shell deployed in a folder of someone's own Pages site (the shipped one is at the root: the root-scope cases)
const SCOPE = '/claude-web/';
const at = (p: string) => new URL(p, 'https://me.github.io');

describe('route (scope /claude-web/)', () => {
  it('app/api/… goes to the PC as an api request, query and all', () => {
    expect(route(at('/claude-web/app/api/file?path=C%3A%5Cx.png&w=1'), SCOPE)).toEqual({ kind: 'api', path: '/api/file?path=C%3A%5Cx.png&w=1' });
    expect(route(at('/claude-web/app/api/attachments?sessionId=s&rel=a.txt'), SCOPE)).toEqual({ kind: 'api', path: '/api/attachments?sessionId=s&rel=a.txt' });
  });

  it('anything else under app/ is one of the app files', () => {
    expect(route(at('/claude-web/app/assets/index-abc.js'), SCOPE)).toEqual({ kind: 'asset', path: '/assets/index-abc.js' });
    expect(route(at('/claude-web/app/manifest.webmanifest'), SCOPE)).toEqual({ kind: 'asset', path: '/manifest.webmanifest' });
    expect(route(at('/claude-web/app/index.html'), SCOPE)).toEqual({ kind: 'asset', path: '/index.html' });
  });

  it("the shell's own marks on the app's address are not sent to the PC", () => {
    expect(route(at(`/claude-web/app/index.html?cwshell=w1&cwcache=cw-app-d1-0.1.5`), SCOPE)).toEqual({ kind: 'asset', path: '/index.html' });
    expect(route(at(`/claude-web/app/index.html?cwshell=w1&win=w2`), SCOPE)).toEqual({ kind: 'asset', path: '/index.html?win=w2' });
  });

  it('the rest of the scope is the shell itself', () => {
    expect(route(at('/claude-web/'), SCOPE)).toEqual({ kind: 'shell' });
    expect(route(at('/claude-web/index.html'), SCOPE)).toEqual({ kind: 'shell' });
    expect(route(at('/claude-web/assets/shell-x.js'), SCOPE)).toEqual({ kind: 'shell' });
    expect(route(at('/claude-web/application'), SCOPE)).toEqual({ kind: 'shell' });
  });

  it('outside the scope, or another origin, is left alone', () => {
    expect(route(at('/other/app/api/x'), SCOPE)).toEqual({ kind: 'pass' });
    expect(route(at('/claude-web'), SCOPE)).toEqual({ kind: 'pass' });
    expect(route(new URL('https://evil.example/claude-web/app/api/x'), 'https://me.github.io/claude-web/')).toEqual({ kind: 'pass' });
  });

  it('a full scope URL works the same as a path', () => {
    expect(route(at('/claude-web/app/api/health'), 'https://me.github.io/claude-web/')).toEqual({ kind: 'api', path: '/api/health' });
  });
});

describe('route (scope /: the shell at the root of its own site, e.g. an organization\'s <org>.github.io)', () => {
  const site = (p: string) => new URL(p, 'https://cw-shell.github.io');

  it('app/ and app/api/ under the root, the rest is the shell', () => {
    expect(route(site('/app/api/file?path=x&w=1'), '/')).toEqual({ kind: 'api', path: '/api/file?path=x&w=1' });
    expect(route(site('/app/assets/index-abc.js'), 'https://cw-shell.github.io/')).toEqual({ kind: 'asset', path: '/assets/index-abc.js' });
    expect(route(site('/app/index.html?cwshell=w1&cwcache=cw-app-d1-0.1.6'), '/')).toEqual({ kind: 'asset', path: '/index.html' });
    expect(route(site('/'), '/')).toEqual({ kind: 'shell' });
    expect(route(site('/sw.js'), '/')).toEqual({ kind: 'shell' });
    expect(route(site('/version.txt'), '/')).toEqual({ kind: 'shell' });
    expect(route(new URL('https://other.github.io/app/api/x'), 'https://cw-shell.github.io/')).toEqual({ kind: 'pass' });
  });

  it('the frame address and cache keys under the root', () => {
    const scope = 'https://cw-shell.github.io/';
    expect(appEntry(scope, 'w1', 'cw-app-d1-0.1.6').startsWith(`${scope}app/index.html?`)).toBe(true);
    expect(appKey(scope, '/assets/a.js')).toBe(`${scope}app/assets/a.js`);
    expect(assetLookup(scope, '/index.html?win=w2')).toEqual({ key: `${scope}app/index.html`, ignoreSearch: true });
  });
});

describe('the app frame address', () => {
  const scope = 'https://me.github.io/claude-web/';

  it('names the shell window that owns it and the cache it reads', () => {
    const u = appEntry(scope, 'w1', 'cw-app-d1-0.1.5');
    expect(u.startsWith(`${scope}app/index.html?`)).toBe(true);
    expect(frameParams(u)).toEqual({ owner: 'w1', cache: 'cw-app-d1-0.1.5' });
  });

  it('a frame without the marks (a worker, a page opened on its own) has neither', () => {
    expect(frameParams(`${scope}app/assets/editor.worker-x.js`)).toEqual({ owner: null, cache: null });
    expect(frameParams('not a url')).toEqual({ owner: null, cache: null });
  });

  it('only app caches are named (anything else reads as none)', () => {
    expect(frameParams(`${scope}app/index.html?cwshell=w1&cwcache=cw-shell-x`).cache).toBeNull();
  });

  it('cache keys are the URLs the frame asks for', () => {
    expect(appKey(scope, '/assets/index-abc.js')).toBe(`${scope}app/assets/index-abc.js`);
    expect(appKey(scope, '/index.html')).toBe(`${scope}app/index.html`);
  });

  it('an app/api/… address opened as a page of its own, without the frame marks, is refused (a link from anywhere must not reach the PC)', () => {
    expect(refusedApi('api', 'document', null)).toBe(true);
    // the app's own PDF preview is a frame inside the app frame: a nested navigation, allowed
    expect(refusedApi('api', 'iframe', null)).toBe(false);
    expect(refusedApi('api', '', null)).toBe(false);
    expect(refusedApi('api', 'document', 'w1')).toBe(false);
    expect(refusedApi('asset', 'document', null)).toBe(false);
  });

  it('index.html is looked up without its query (?win=… for another window), nothing else is', () => {
    expect(assetLookup(scope, '/index.html?win=w2')).toEqual({ key: `${scope}app/index.html`, ignoreSearch: true });
    expect(assetLookup(scope, '/')).toEqual({ key: `${scope}app/index.html`, ignoreSearch: true });
    expect(assetLookup(scope, '/assets/a.js?v=1')).toEqual({ key: `${scope}app/assets/a.js?v=1`, ignoreSearch: false });
  });

  it('PC paths get their one leading slash', () => {
    expect(pcPath('api/pair')).toBe(['', 'api', 'pair'].join('/'));
    expect(pcPath('index.html')).toBe(['', 'index.html'].join('/'));
  });
});
