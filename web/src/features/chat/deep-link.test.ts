// issue #18: a claude-web:// link in a reply opens in the app — with the desktop shell's rules (desktop/src/deep-link.ts)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localFolder, openAppLink, parseAppLink } from './deep-link';

const env = vi.hoisted(() => ({
  dirs: new Set<string>(),
  stats: [] as string[],
  commands: [] as string[],
  fills: [] as unknown[],
  active: [] as string[],
  loaded: [] as string[],
  open: {} as Record<string, unknown>,
}));
vi.mock('@/ws/client', () => ({ ws: { request: async (r: { path: string }) => { env.stats.push(r.path); return env.dirs.has(r.path) ? { path: r.path, dir: true } : null; } } }));
vi.mock('@/store', () => ({ useStore: { getState: () => ({ open: env.open, setActive: (id: string) => env.active.push(id), loadHistory: async (id: string) => { env.loaded.push(id); } }) } }));
vi.mock('@/features/workbench/commands', () => ({ runCommand: (id: string) => env.commands.push(id) }));
vi.mock('@/features/composer/fill', () => ({ fillComposer: (d: unknown) => env.fills.push(d) }));

beforeEach(() => {
  env.dirs = new Set(['C:\\proj']); env.stats = []; env.commands = []; env.fills = []; env.active = []; env.loaded = []; env.open = {};
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0; });
});

describe('parseAppLink: the desktop shell parseDeepLink rules', () => {
  it('new: folder, text, machine; both URL forms', () => {
    expect(parseAppLink('claude-web://new?folder=C%3A%5Cproj&q=fix%20the%20tests&peer=desk-2')).toEqual({ kind: 'new', folder: 'C:\\proj', q: 'fix the tests', peer: 'desk-2' });
    expect(parseAppLink('claude-web:new?folder=/home/me/proj')).toEqual({ kind: 'new', folder: '/home/me/proj' });
  });
  it('a network or relative folder, a strange machine name and unknown parameters are dropped', () => {
    for (const f of ['\\\\evil\\share', '//evil/share', 'proj', '\\\\?\\UNC\\evil\\s']) expect(parseAppLink(`claude-web://new?folder=${encodeURIComponent(f)}`)).toEqual({ kind: 'new' });
    expect(parseAppLink('claude-web://new?peer=a%20b&x=1')).toEqual({ kind: 'new' });
  });
  it('the text is cut at 10 000 characters', () => {
    const r = parseAppLink(`claude-web://new?q=${'x'.repeat(20_000)}`);
    expect(r?.kind === 'new' && r.q?.length).toBe(10_000);
  });
  it('session/<id>; a path-like or broken id is refused', () => {
    expect(parseAppLink('claude-web://session/5a0e0e0e-0000-4000-8000-00000000c0e1')).toEqual({ kind: 'session', id: '5a0e0e0e-0000-4000-8000-00000000c0e1' });
    expect(parseAppLink('claude-web://session/..%2F..%2Fx%3Cy')).toBeNull();
    expect(parseAppLink('claude-web://session/%E0%A4%A')).toBeNull();
  });
  it('anything else is not ours', () => {
    expect(parseAppLink('https://example.com')).toBeNull();
    expect(parseAppLink('claude-web://settings')).toBeNull();
    expect(parseAppLink('not a url')).toBeNull();
    expect(localFolder('C:/x')).toBe(true);
    expect(localFolder('//h/x')).toBe(false);
  });
});

describe('openAppLink', () => {
  it('new: the page opens filled in (never sent); a folder that is there is kept', async () => {
    await openAppLink({ kind: 'new', folder: 'C:\\proj', q: 'hi' });
    expect(env.stats).toEqual(['C:\\proj']);
    expect(env.commands).toEqual(['new']);
    expect(env.fills).toEqual([{ cwd: 'C:\\proj', text: 'hi', focus: true }]);
  });
  it('a folder that is not there is dropped; one the shell checked is not asked about again', async () => {
    await openAppLink({ kind: 'new', folder: 'C:\\nope', q: 'hi' });
    expect(env.fills).toEqual([{ cwd: undefined, text: 'hi', focus: true }]);
    env.stats = [];
    await openAppLink({ kind: 'new', folder: 'D:\\from-shell' }, true);
    expect(env.stats).toEqual([]);
    expect(env.fills.at(-1)).toEqual({ cwd: 'D:\\from-shell', text: undefined, focus: true });
  });
  it('session: an open one comes to the front, another one is loaded', async () => {
    env.open = { s1: {} };
    await openAppLink({ kind: 'session', id: 's1' });
    await openAppLink({ kind: 'session', id: 's2' });
    expect(env.active).toEqual(['s1']);
    expect(env.loaded).toEqual(['s2']);
    expect(env.commands).toEqual([]);
  });
});
