import { describe, expect, it } from 'vitest';
import type { OpeningInfo } from '@shared';
import { CAFE_ID, DEFAULT_PACK, DRAWN_IDS, IGNITE_ID, OPACITY_DEFAULT, backdropKind, fullOf, isBuiltinId, isDrawnId, keepOn, opacityOf, openingCards, packFileUrl, packOf, shellSolid, soundOf, whenOf } from './model';
import { emberAlpha, emberCount, rgba, spawn, stepEmbers } from './embers';

const CHAN: OpeningInfo = { id: 'claude-web-chan', name: 'Claude Web 娘', builtin: true, kind: 'video', intro: 'intro.mp4', loop: 'loop.mp4', poster: 'poster.webp', logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 };
const MINE: OpeningInfo = { id: 'mine', name: 'Mine', builtin: false, kind: 'video', intro: 'intro.mp4', maxSeconds: 12 };
const WEB: OpeningInfo = { id: 'glow', name: '萤火', builtin: false, kind: 'web', entry: 'index.html', author: 'someone', license: 'MIT', maxSeconds: 8 };
const url = (id: string, f: string) => `u/${id}/${f}`;

describe('开场和背景 · settings', () => {
  it('defaults agree with the desktop shell: Claude Web 娘, every start, full, with sound, kept at 60%', () => {
    expect([packOf({}), whenOf({}), fullOf({}), soundOf({}), keepOn({}), opacityOf({})]).toEqual([DEFAULT_PACK, 'always', true, true, true, 60]);
    expect(OPACITY_DEFAULT).toBe(60);
    expect(whenOf({ 'ui.opening.when': 'never' })).toBe('never');
    expect(whenOf({ 'ui.opening.when': 'daily' })).toBe('daily');
    expect(whenOf({ 'ui.opening.when': 'weekly' })).toBe('always');
    expect(fullOf({ 'ui.opening.length': 'short' })).toBe(false);
    // a sound switched off stays off; anything else is the default (on)
    expect(soundOf({ 'ui.opening.sound': false })).toBe(false);
    expect(soundOf({ 'ui.opening.sound': true })).toBe(true);
  });
  it('留作背景 never set: off for someone who turned 背景动画 off; a set value wins', () => {
    expect(keepOn({ 'ui.backdropMotion': false })).toBe(false);
    expect(keepOn({ 'ui.welcomeBackdrop': 'off' })).toBe(false);
    expect(keepOn({ 'ui.backdropMotion': false, 'ui.opening.keep': true })).toBe(true);
    expect(keepOn({ 'ui.opening.keep': false })).toBe(false);
  });
  it('浓淡 is 0–60, whole numbers', () => {
    expect(opacityOf({ 'ui.opening.opacity': 80 })).toBe(60);
    expect(opacityOf({ 'ui.opening.opacity': -3 })).toBe(0);
    expect(opacityOf({ 'ui.opening.opacity': 12.6 })).toBe(13);
    expect(opacityOf({ 'ui.opening.opacity': 'x' })).toBe(OPACITY_DEFAULT);
    expect(opacityOf({ 'ui.opening.opacity': null })).toBe(OPACITY_DEFAULT);
    expect(opacityOf({ 'ui.opening.opacity': 0 })).toBe(0);
  });
  it('the shell over the background: the sidebar side keeps more of itself than the start page', () => {
    expect(shellSolid(30)).toEqual({ side: '83.5%', main: '70%' });
    expect(shellSolid(0)).toEqual({ side: '100%', main: '100%' });
    expect(shellSolid(99)).toEqual({ side: '67%', main: '40%' });
  });
  it('a pack file\'s address carries the token', () => {
    expect(packFileUrl('claude-web-chan', 'loop.mp4', 'a b')).toBe('api/opening/claude-web-chan/loop.mp4?token=a%20b');
    expect(packFileUrl('x', 'y.webp', null)).toBe('api/opening/x/y.webp');
  });
});

describe('开场和背景 · what stays behind the app', () => {
  const base = { keep: true, mobile: false, light: false, themeBackdrop: false, pack: DEFAULT_PACK, packs: [CHAN, MINE], url };
  it('dark theme: her loop', () => {
    expect(backdropKind(base)).toEqual({ kind: 'video', pack: CHAN, src: 'u/claude-web-chan/loop.mp4' });
  });
  it('light theme, 点火, 网吧开门, a web pack, a pack without a loop, a pack that is gone: 火星', () => {
    expect(backdropKind({ ...base, light: true })).toEqual({ kind: 'embers' });
    expect(backdropKind({ ...base, pack: IGNITE_ID })).toEqual({ kind: 'embers' });
    expect(backdropKind({ ...base, pack: CAFE_ID })).toEqual({ kind: 'embers' });
    expect(backdropKind({ ...base, pack: 'glow', packs: [CHAN, WEB] })).toEqual({ kind: 'embers' });
    expect(backdropKind({ ...base, pack: 'mine' })).toEqual({ kind: 'embers' });
    expect(backdropKind({ ...base, pack: 'removed' })).toEqual({ kind: 'embers' });
  });
  it('星图 leaves its stars and 字符雨 its characters, on a light theme too, before the packs are known', () => {
    expect(backdropKind({ ...base, pack: 'stars' })).toEqual({ kind: 'stars' });
    expect(backdropKind({ ...base, pack: 'ascii' })).toEqual({ kind: 'rain' });
    expect(backdropKind({ ...base, pack: 'stars', light: true })).toEqual({ kind: 'stars' });
    expect(backdropKind({ ...base, pack: 'ascii', light: true, packs: null })).toEqual({ kind: 'rain' });
    expect(backdropKind({ ...base, pack: 'ascii', mobile: true })).toBeNull();
  });
  it('nothing: kept off, a phone, a character theme with its own backdrop, the packs not known yet', () => {
    expect(backdropKind({ ...base, keep: false })).toBeNull();
    expect(backdropKind({ ...base, mobile: true })).toBeNull();
    expect(backdropKind({ ...base, themeBackdrop: true })).toBeNull();
    expect(backdropKind({ ...base, packs: null })).toBeNull();
  });
  it('the cards: the built-in packs, 点火 · 星图 · 字符雨 · 网吧开门, then the user\'s (video or web)', () => {
    const cards = openingCards([MINE, CHAN, WEB]);
    expect(cards.map((c) => c.id)).toEqual(['claude-web-chan', IGNITE_ID, 'stars', 'ascii', CAFE_ID, 'mine', 'glow']);
    expect(cards.map((c) => c.kind)).toEqual(['video', 'ignite', 'stars', 'ascii', 'cafe', 'video', 'web']);
    expect(openingCards([]).map((c) => c.id)).toEqual([...DRAWN_IDS, CAFE_ID]);
  });
  it('the ids that need no folder: the three drawn scenes and 网吧开门', () => {
    expect(['ignite', 'stars', 'ascii', 'cafe'].every(isBuiltinId)).toBe(true);
    expect(isBuiltinId(DEFAULT_PACK)).toBe(false);
    expect(isBuiltinId('mine')).toBe(false);
    expect(isDrawnId('cafe')).toBe(false);
  });
});

describe('火星', () => {
  const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };
  it('sparse: between 14 and 80 for any window', () => {
    expect(emberCount(100, 100)).toBe(14);
    expect(emberCount(1400, 900)).toBe(79);
    expect(emberCount(4000, 3000)).toBe(80);
  });
  it('they rise, sway, burn out and are born again at the bottom', () => {
    const r = seq(0.5);
    const list = [spawn(1000, 800, r)];
    expect(list[0].y).toBe(806);
    const y0 = list[0].y;
    stepEmbers(list, 1, 1000, 800, r);
    expect(list[0].y).toBeLessThan(y0);
    list[0].life = list[0].max + 1;
    stepEmbers(list, 0.01, 1000, 800, r);
    expect(list[0].life).toBe(0);
    expect(list[0].y).toBe(806);
  });
  it('brightness fades in and out, never outside 0–1', () => {
    const e = spawn(100, 100, seq(0.3), true);
    for (const life of [0, 0.2, 1, e.max / 2, e.max]) { e.life = life; const a = emberAlpha(e); expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(1); }
    e.life = 0;
    expect(emberAlpha(e)).toBe(0);
  });
  it('glow stops are the spark colours with an alpha', () => {
    expect(rgba('#fb7d2c', 0.38)).toBe('rgba(251,125,44,0.38)');
    expect(rgba('#ffc46a', 0)).toBe('rgba(255,196,106,0)');
  });
});
