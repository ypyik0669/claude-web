import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followLink, routeLink } from './link-route';

// the store touches browser globals at import time: followLink's imports are stubbed, `env` is what they see
const env = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  desktop: null as null | { openExternal: (u: string) => Promise<void> },
  openInBrowser: (_u: string) => {},
}));
vi.mock('@/store', () => ({ useStore: { getState: () => ({ settings: env.settings }) } }));
vi.mock('@/desktop', () => ({ get desktop() { return env.desktop; } }));
vi.mock('@/features/remote-guard', () => ({ blockRemoteOpen: () => false }));
// deep-link.ts (issue #18) imports these; a link here is only routed
vi.mock('@/ws/client', () => ({ ws: { request: async () => null } }));
vi.mock('@/features/workbench/commands', () => ({ runCommand: () => {} }));
vi.mock('@/features/composer/fill', () => ({ fillComposer: () => {} }));
vi.mock('@/features/workbench/right-panel', () => ({ openInBrowser: (u: string) => env.openInBrowser(u) }));

// stage B task 1: a page link in a reply opens in the built-in browser; Ctrl / Cmd, or the setting off → the system's
describe('followLink: web pages', () => {
  const URL_ = 'https://example.com/a';
  let openInBrowser: ReturnType<typeof vi.fn>;
  let openExternal: ReturnType<typeof vi.fn>;
  let winOpen: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    openInBrowser = vi.fn();
    openExternal = vi.fn(async () => {});
    winOpen = vi.fn();
    env.openInBrowser = openInBrowser as never;
    env.desktop = { openExternal: openExternal as never };
    env.settings = {};
    vi.stubGlobal('window', { open: winOpen });
  });
  afterEach(() => { vi.unstubAllGlobals(); env.desktop = null; env.settings = {}; });

  it('desktop, setting absent or on → the built-in browser', () => {
    followLink({ to: 'web', url: URL_ }, 's1');
    env.settings = { 'web.browser.openLinks': true };
    followLink({ to: 'web', url: URL_ }, 's1');
    expect(openInBrowser).toHaveBeenCalledTimes(2);
    expect(openInBrowser).toHaveBeenCalledWith(URL_);
    expect(openExternal).not.toHaveBeenCalled();
  });
  it('external: true (Ctrl / Cmd) → the system browser', () => {
    followLink({ to: 'web', url: URL_ }, 's1', { external: true });
    expect(openExternal).toHaveBeenCalledWith(URL_);
    expect(openInBrowser).not.toHaveBeenCalled();
  });
  it('the setting off → the system browser', () => {
    env.settings = { 'web.browser.openLinks': false };
    followLink({ to: 'web', url: URL_ }, 's1');
    expect(openExternal).toHaveBeenCalledWith(URL_);
    expect(openInBrowser).not.toHaveBeenCalled();
  });
  it('the web version (no desktop) → a new browser tab (many sites refuse to be framed)', () => {
    env.desktop = null;
    followLink({ to: 'web', url: URL_ }, 's1');
    expect(winOpen).toHaveBeenCalledWith(URL_, '_blank', 'noopener,noreferrer');
    expect(openInBrowser).not.toHaveBeenCalled();
  });
  it('mail / tel still go to the system', () => {
    followLink({ to: 'external', url: 'mailto:a@b.c' }, 's1');
    expect(openExternal).toHaveBeenCalledWith('mailto:a@b.c');
    expect(openInBrowser).not.toHaveBeenCalled();
  });
});

describe('routeLink', () => {
  it('web pages', () => {
    expect(routeLink('https://example.com/a?b=1', undefined)).toEqual({ to: 'web', url: 'https://example.com/a?b=1' });
    expect(routeLink('HTTP://x.dev', undefined)).toEqual({ to: 'web', url: 'HTTP://x.dev' });
  });
  it('mail / tel go to the system', () => {
    expect(routeLink('mailto:a@b.c', undefined)).toEqual({ to: 'external', url: 'mailto:a@b.c' });
    expect(routeLink('tel:123', undefined)).toEqual({ to: 'external', url: 'tel:123' });
  });
  it('dangerous or unknown schemes open nothing', () => {
    // issue #18: a 深链接 opens in the app; a malformed one opens nothing
    expect(routeLink('claude-web://new?folder=C%3A%5Cproj&q=hi', undefined)).toEqual({ to: 'app', link: { kind: 'new', folder: 'C:\\proj', q: 'hi' } });
    expect(routeLink('claude-web://session/abc', '/p')).toEqual({ to: 'app', link: { kind: 'session', id: 'abc' } });
    expect(routeLink('claude-web://settings', undefined)).toEqual({ to: 'none' });
    expect(routeLink('javascript:alert(1)', undefined)).toEqual({ to: 'none' });
    expect(routeLink('data:text/html,<b>x</b>', undefined)).toEqual({ to: 'none' });
    expect(routeLink('vbscript:x', undefined)).toEqual({ to: 'none' });
    expect(routeLink('', undefined)).toEqual({ to: 'none' });
  });
  it('network (UNC) paths open nothing: a click must not reach out to another machine', () => {
    expect(routeLink('//h/s/x', '/p')).toEqual({ to: 'none' });
    expect(routeLink('/\\h\\s', '/p')).toEqual({ to: 'none' });
    expect(routeLink('\\\\h\\s\\x', undefined)).toEqual({ to: 'none' });
    expect(routeLink('\\\\h\\s\\x', '/p')).toEqual({ to: 'none' });
    expect(routeLink('file://host/share/x', undefined)).toEqual({ to: 'none' });
    expect(routeLink('file:////host/share/x', undefined)).toEqual({ to: 'none' });
    expect(routeLink('/%2F%2Fhost/share', undefined)).toEqual({ to: 'none' });
    expect(routeLink('file:///%5C%5Chost/share', undefined)).toEqual({ to: 'none' });
    expect(routeLink('file://localhost/home/a/x.md', undefined)).toEqual({ to: 'file', path: '/home/a/x.md' });
    // as the markdown pipeline hands them over (percent-encoded)
    expect(routeLink('%5C%5Chost%5Cshare%5Cx', '/p')).toEqual({ to: 'none' });
    expect(routeLink('%2F%2Fhost/share', '/p')).toEqual({ to: 'none' });
  });
  it('a drive path the markdown pipeline percent-encoded is still a file', () => {
    expect(routeLink('C:%5Cwork%5Cx.html', undefined)).toEqual({ to: 'file', path: 'C:\\work\\x.html' });
    expect(routeLink('C:/work/my%20x.html', undefined)).toEqual({ to: 'file', path: 'C:/work/my x.html' });
  });
  it('in-page anchors are left to the page', () => {
    expect(routeLink('#fn-1', '/p')).toEqual({ to: 'anchor' });
  });
  it('file:// and absolute paths are files', () => {
    expect(routeLink('file:///C:/Users/a/draft%20preview.html', undefined)).toEqual({ to: 'file', path: 'C:/Users/a/draft preview.html' });
    expect(routeLink('file:///home/a/x.md', undefined)).toEqual({ to: 'file', path: '/home/a/x.md' });
    expect(routeLink('C:\\work\\x.html', undefined)).toEqual({ to: 'file', path: 'C:\\work\\x.html' });
    expect(routeLink('/C:/work/x.html', undefined)).toEqual({ to: 'file', path: 'C:/work/x.html' });
    expect(routeLink('/Users/a/x.svg', undefined)).toEqual({ to: 'file', path: '/Users/a/x.svg' });
  });
  it('relative paths resolve against the conversation folder', () => {
    expect(routeLink('preview.html', 'C:/proj')).toEqual({ to: 'file', path: 'C:/proj/preview.html' });
    expect(routeLink('./out/a.md', 'C:\\proj\\')).toEqual({ to: 'file', path: 'C:/proj/out/a.md' });
    expect(routeLink('../b/c.txt', '/home/u/proj')).toEqual({ to: 'file', path: '/home/u/b/c.txt' });
    expect(routeLink('preview.html', undefined)).toEqual({ to: 'none' });
  });
  it('line numbers: path:12 and #L12', () => {
    expect(routeLink('src/a.ts:12', '/p')).toEqual({ to: 'file', path: '/p/src/a.ts', line: 12 });
    expect(routeLink('src/a.ts#L7', '/p')).toEqual({ to: 'file', path: '/p/src/a.ts', line: 7 });
  });
  // 2026-10-24 review M1: a fragment / query stayed in the path → a 「not found」 tab
  it('line ranges take the first line', () => {
    expect(routeLink('src/a.ts#L12-L20', '/p')).toEqual({ to: 'file', path: '/p/src/a.ts', line: 12 });
    expect(routeLink('src/a.ts#L12-20', '/p')).toEqual({ to: 'file', path: '/p/src/a.ts', line: 12 });
    expect(routeLink('file:///C:/w/a.ts#L3-L4', undefined)).toEqual({ to: 'file', path: 'C:/w/a.ts', line: 3 });
  });
  it('other fragments and queries are not part of a local path', () => {
    expect(routeLink('docs/x.md#section', '/p')).toEqual({ to: 'file', path: '/p/docs/x.md' });
    expect(routeLink('out/page.html?v=1', '/p')).toEqual({ to: 'file', path: '/p/out/page.html' });
    expect(routeLink('out/page.html?v=1#top', '/p')).toEqual({ to: 'file', path: '/p/out/page.html' });
    expect(routeLink('file:///C:/w/x.html?v=2', undefined)).toEqual({ to: 'file', path: 'C:/w/x.html' });
    expect(routeLink('C:/w/x.md#intro', undefined)).toEqual({ to: 'file', path: 'C:/w/x.md' });
    expect(routeLink('/home/a/x.md#L9', undefined)).toEqual({ to: 'file', path: '/home/a/x.md', line: 9 });
    // an encoded # is part of the name
    expect(routeLink('file:///C:/w/a%23b.md', undefined)).toEqual({ to: 'file', path: 'C:/w/a#b.md' });
  });
  it('web addresses keep their fragment and query', () => {
    expect(routeLink('https://e.com/a?v=1#L3', undefined)).toEqual({ to: 'web', url: 'https://e.com/a?v=1#L3' });
  });
});
