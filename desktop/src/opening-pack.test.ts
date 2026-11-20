import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAFE_ID, DEFAULT_PACK, WEB_ENTRY_MAX, appFilePath, cafeScriptPath, chooseOpening, groundOf, localDay, openingSettings, packFilePath, packFileUrl, packResponse, parseRange,
  pickOpening, readMetaSettings, readWebEntry, resolvePack, safeSegment,
} from './opening-pack';

describe('开场 · which one a start shows', () => {
  it('the settings and their defaults: Claude Web 娘, the day\'s first start, full, no sound', () => {
    expect(openingSettings({})).toEqual({ pack: DEFAULT_PACK, when: 'always', full: true, sound: true });
    expect(openingSettings({ 'ui.opening.when': 'daily', 'ui.opening.sound': false })).toMatchObject({ when: 'daily', sound: false });
    expect(openingSettings({ 'ui.opening.pack': 'ignite', 'ui.opening.when': 'always', 'ui.opening.length': 'short', 'ui.opening.sound': true })).toEqual({ pack: 'ignite', when: 'always', full: false, sound: true });
    expect(openingSettings({ 'ui.opening.when': 'weekly', 'ui.opening.pack': '' })).toMatchObject({ when: 'always', pack: DEFAULT_PACK });
  });
  it('每天第一次: the chosen one once a day (the day used up), the classic one the other times', () => {
    expect(pickOpening({ when: 'daily', today: '2026-11-19', hidden: false })).toEqual({ show: 'fancy', markDay: true });
    expect(pickOpening({ when: 'daily', today: '2026-11-19', lastDay: '2026-11-19', hidden: false })).toEqual({ show: 'classic', markDay: false });
    expect(pickOpening({ when: 'daily', today: '2026-11-20', lastDay: '2026-11-19', hidden: false }).show).toBe('fancy');
  });
  it('每次打开: always the chosen one; 不放: the last frame only; into the tray: the classic one, the day kept', () => {
    expect(pickOpening({ when: 'always', today: 'd', lastDay: 'd', hidden: false }).show).toBe('fancy');
    expect(pickOpening({ when: 'never', today: 'd', hidden: false })).toEqual({ show: 'still', markDay: false });
    expect(pickOpening({ when: 'daily', today: 'd', hidden: true })).toEqual({ show: 'classic', markDay: false });
  });
  it('the local day', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('the ground the opening ends on is the app\'s shell ground for its theme', () => {
    expect(groundOf('light', true)).toEqual({ ground: '#f7f6f2', dark: false });
    expect(groundOf('paper', true).dark).toBe(false);
    expect(groundOf('dracula', false)).toEqual({ ground: '#21222c', dark: true });
    expect(groundOf(undefined, true)).toEqual({ ground: '#12110f', dark: true });
    expect(groundOf('system', false)).toEqual({ ground: '#f7f6f2', dark: false });
    expect(groundOf('ascii:matrix', true).ground).toBe('#12110f');
  });
});

describe('开场 · packs and their files', () => {
  let root: string;
  let user: string;
  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-opening-'));
    root = path.join(base, 'builtin');
    user = path.join(base, 'user');
    const pack = path.join(root, 'claude-web-chan');
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, 'opening.json'), JSON.stringify({ name: 'x', kind: 'video', intro: 'intro.mp4', loop: 'loop.mp4', logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 }));
    fs.writeFileSync(path.join(pack, 'intro.mp4'), Buffer.from('0123456789'));
    fs.writeFileSync(path.join(pack, 'secret.txt'), 'no');
    const broken = path.join(user, 'nofilm');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'opening.json'), JSON.stringify({ kind: 'video', intro: 'gone.mp4' }));
    fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify({ settings: { 'ui.opening.when': 'never' } }));
  });
  afterAll(() => { fs.rmSync(path.dirname(root), { recursive: true, force: true }); });

  it('meta.json\'s settings, read before the server is up; none → {}', () => {
    expect(readMetaSettings(path.dirname(root))).toEqual({ 'ui.opening.when': 'never' });
    expect(readMetaSettings(path.join(root, 'nowhere'))).toEqual({});
  });
  it('a pack is found in the first root that has it; one whose film is missing, or an odd name, is none', () => {
    expect(resolvePack('claude-web-chan', [root, user])).toMatchObject({ id: 'claude-web-chan', intro: 'intro.mp4', logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 });
    expect(resolvePack('nofilm', [root, user])).toBeNull();
    expect(resolvePack('missing', [root, user])).toBeNull();
    expect(resolvePack('../builtin/claude-web-chan', [root, user])).toBeNull();
    expect(safeSegment('a/b')).toBe(false);
    expect(safeSegment('..')).toBe(false);
  });
  it('a range: the one a video asks for when it seeks, the rest of the file, none, or outside', () => {
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange(undefined, 10)).toBeNull();
  });
  it('cw-opening:// serves a pack\'s media and nothing else', () => {
    expect(packFileUrl('claude-web-chan', 'intro.mp4')).toBe('cw-opening://pack/claude-web-chan/intro.mp4');
    expect(packFilePath('cw-opening://pack/claude-web-chan/intro.mp4', [root, user])).toBe(path.join(root, 'claude-web-chan', 'intro.mp4'));
    expect(packFilePath('cw-opening://pack/claude-web-chan/secret.txt', [root, user])).toBeNull();
    expect(packFilePath('cw-opening://pack/claude-web-chan/..%2F..%2Fmeta.json', [root, user])).toBeNull();
    expect(packFilePath('cw-opening://pack/claude-web-chan/loop.mp4', [root, user])).toBeNull(); // named, but not there
    expect(packFilePath('cw-opening://other/claude-web-chan/intro.mp4', [root, user])).toBeNull();
    expect(packFilePath('https://pack/claude-web-chan/intro.mp4', [root, user])).toBeNull();
  });
  it('the response: the whole file, a 206 range, 416 outside, 404 for anything else', async () => {
    const req = (url: string, range?: string) => ({ url, headers: { get: (n: string) => (n.toLowerCase() === 'range' ? range ?? null : null) } });
    const whole = packResponse(req('cw-opening://pack/claude-web-chan/intro.mp4'), [root]);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(await whole.text()).toBe('0123456789');
    const part = packResponse(req('cw-opening://pack/claude-web-chan/intro.mp4', 'bytes=3-5'), [root]);
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 3-5/10');
    expect(await part.text()).toBe('345');
    expect(packResponse(req('cw-opening://pack/claude-web-chan/intro.mp4', 'bytes=50-'), [root]).status).toBe(416);
    expect(packResponse(req('cw-opening://pack/claude-web-chan/secret.txt'), [root]).status).toBe(404);
  });
});

describe('开场 · 网页包, 网吧开门, and what a start plays', () => {
  let base: string;
  let root: string;
  let dist: string;
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-opening2-'));
    root = path.join(base, 'user');
    const mk = (id: string, json: object, files: Record<string, string | Buffer>) => {
      fs.mkdirSync(path.join(root, id), { recursive: true });
      fs.writeFileSync(path.join(root, id, 'opening.json'), JSON.stringify(json));
      for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(root, id, f), b);
    };
    mk('sparkle', { name: 'Sparkle', kind: 'web', maxSeconds: 30 }, { 'index.html': '<canvas></canvas>' });
    mk('own-entry', { kind: 'web', entry: 'play.html', maxSeconds: 6 }, { 'play.html': '<b>hi</b>' });
    mk('no-page', { kind: 'web' }, {});
    mk('odd-entry', { kind: 'web', entry: '../index.html' }, { 'index.html': 'x' });
    mk('script-entry', { kind: 'web', entry: 'run.js' }, { 'run.js': 'x' });
    mk('huge', { kind: 'web' }, { 'index.html': Buffer.alloc(WEB_ENTRY_MAX + 1, 32) });
    mk('film', { kind: 'video', intro: 'i.mp4' }, { 'i.mp4': 'v' });
    dist = path.join(base, 'dist');
    fs.mkdirSync(path.join(dist, 'opening'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'opening', 'cafe-opening.js'), 'window.cwCafeOpening={}');
  });
  afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

  it('a web pack: one page (index.html unless opening.json names another .html), at most 12 s; a missing or odd page is no pack', () => {
    expect(resolvePack('sparkle', [root])).toMatchObject({ kind: 'web', id: 'sparkle', entry: 'index.html', maxSeconds: 12 });
    expect(resolvePack('own-entry', [root])).toMatchObject({ kind: 'web', entry: 'play.html', maxSeconds: 6 });
    expect(resolvePack('no-page', [root])).toBeNull();
    expect(resolvePack('odd-entry', [root])).toBeNull();
    expect(resolvePack('script-entry', [root])).toBeNull();
    expect(resolvePack('film', [root])).toMatchObject({ kind: 'video', intro: 'i.mp4' });
  });
  it('its page is read for the opening page (at most 8 MB)', () => {
    const p = resolvePack('sparkle', [root]);
    expect(p?.kind === 'web' && readWebEntry(p)).toBe('<canvas></canvas>');
    const big = resolvePack('huge', [root]);
    expect(big?.kind).toBe('web');
    expect(big?.kind === 'web' && readWebEntry(big)).toBeNull();
  });
  it('what a start plays: a drawn scene by its id, the cafe once its script is built, a pack — else 点火, and why', () => {
    const script = cafeScriptPath(dist);
    expect(script).toBe(path.join(dist, 'opening', 'cafe-opening.js'));
    expect(cafeScriptPath(path.join(base, 'nowhere'))).toBeNull();
    const o = { roots: [root], cafeScript: script };
    expect(chooseOpening('stars', o)).toEqual({ kind: 'stars' });
    expect(chooseOpening('ascii', o)).toEqual({ kind: 'ascii' });
    expect(chooseOpening('ignite', o)).toEqual({ kind: 'ignite' });
    expect(chooseOpening(CAFE_ID, o)).toEqual({ kind: 'cafe' });
    expect(chooseOpening(CAFE_ID, { ...o, cafeScript: null })).toEqual({ kind: 'ignite', why: 'the cafe script is not built' });
    expect(chooseOpening('sparkle', o)).toMatchObject({ kind: 'web', pack: { id: 'sparkle' } });
    expect(chooseOpening('film', o)).toMatchObject({ kind: 'video', pack: { id: 'film' } });
    expect(chooseOpening('gone', o)).toEqual({ kind: 'ignite', why: 'pack gone missing' });
  });
  it('cw-opening://app/cafe-opening.js is the cafe\'s script and the only file of the app served there', async () => {
    const script = cafeScriptPath(dist);
    expect(appFilePath('cw-opening://app/cafe-opening.js', script)).toBe(script);
    expect(appFilePath('cw-opening://app/../index.html', script)).toBeNull();
    expect(appFilePath('cw-opening://app/other.js', script)).toBeNull();
    expect(appFilePath('cw-opening://pack/cafe-opening.js', script)).toBeNull();
    const req = (url: string) => ({ url, headers: { get: () => null } });
    const r = packResponse(req('cw-opening://app/cafe-opening.js'), [root], script);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    expect(await r.text()).toBe('window.cwCafeOpening={}');
    expect(packResponse(req('cw-opening://app/cafe-opening.js'), [root], null).status).toBe(404);
    // a web pack's page is not served on the scheme (the opening page gets it from the shell, desktop:opening:pack)
    expect(packResponse(req('cw-opening://pack/sparkle/index.html'), [root], script).status).toBe(404);
  });
});
