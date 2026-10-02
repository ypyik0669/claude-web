import { describe, expect, it } from 'vitest';
import { appEntry, appKey, frameParams, pcPath, route } from './route';

const SCOPE = '/claude-web/';
const at = (p: string) => new URL(p, 'https://ypyik0669.github.io');

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
    expect(route(new URL('https://evil.example/claude-web/app/api/x'), 'https://ypyik0669.github.io/claude-web/')).toEqual({ kind: 'pass' });
  });

  it('a full scope URL works the same as a path', () => {
    expect(route(at('/claude-web/app/api/health'), 'https://ypyik0669.github.io/claude-web/')).toEqual({ kind: 'api', path: '/api/health' });
  });
});

describe('the app frame address', () => {
  const scope = 'https://ypyik0669.github.io/claude-web/';

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

  it('PC paths get their one leading slash', () => {
    expect(pcPath('api/pair')).toBe(['', 'api', 'pair'].join('/'));
    expect(pcPath('index.html')).toBe(['', 'index.html'].join('/'));
  });
});
