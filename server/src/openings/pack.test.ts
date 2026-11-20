import { describe, expect, it } from 'vitest';
import { mainFile, packFiles, packIdFor, readPack, safeFile } from './pack.js';

const BUILTIN = { name: 'Claude Web 娘', version: 3, author: 'Super NB', license: 'MIT', kind: 'video', intro: 'intro.mp4', loop: 'loop.mp4', poster: 'poster.webp', logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12, sound: false, credits: '人设图：gpt-image-2.6' };

describe('开场动画包 · opening.json', () => {
  it('the built-in pack reads as it is', () => {
    expect(readPack(BUILTIN, 'claude-web-chan', true)).toEqual({
      id: 'claude-web-chan', builtin: true, kind: 'video', name: 'Claude Web 娘', author: 'Super NB', license: 'MIT', credits: '人设图：gpt-image-2.6',
      intro: 'intro.mp4', loop: 'loop.mp4', poster: 'poster.webp', logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12,
    });
  });
  it('at most 12 s are played; logoAt / shortFrom stay inside; no name → the folder\'s', () => {
    const p = readPack({ kind: 'video', intro: 'a.webm', logoAt: 40, shortFrom: 30, maxSeconds: 60 }, 'mine', false);
    expect(p).toMatchObject({ name: 'mine', maxSeconds: 12, logoAt: 12, shortFrom: 12 });
    expect(readPack({ kind: 'video', intro: 'a.mp4', maxSeconds: 5 }, 'm', false)).toMatchObject({ maxSeconds: 5 });
  });
  it('refused: not an object, not a video pack, a film / loop / poster that is not a plain file of the right kind', () => {
    expect(readPack(null, 'x', false)).toHaveProperty('error');
    expect(readPack([], 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'html', intro: 'index.html' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'video' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'video', intro: '../intro.mp4' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'video', intro: 'sub/intro.mp4' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'video', intro: 'intro.exe' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'video', intro: 'a.mp4', loop: 'C:\\loop.mp4' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'video', intro: 'a.mp4', poster: 'p.gif' }, 'x', false)).toHaveProperty('error');
  });
  it('the files a pack uses', () => {
    expect(packFiles({ intro: 'i.mp4', loop: 'l.mp4', poster: 'p.webp' })).toEqual(['i.mp4', 'l.mp4', 'p.webp']);
    expect(packFiles({ intro: 'i.mp4' })).toEqual(['i.mp4']);
    expect(packFiles({ entry: 'index.html', poster: 'p.png' })).toEqual(['index.html', 'p.png']);
    expect(safeFile('a.mp4')).toBe(true);
    expect(safeFile('..')).toBe(false);
  });
  it('a folder name for a new pack: lower-case ASCII, never one already there, never an id of the app\'s (点火, 星图, 字符雨, 网吧开门)', () => {
    expect(packIdFor('My Opening!', new Set())).toBe('my-opening');
    expect(packIdFor('开场', new Set())).toBe('opening');
    expect(packIdFor('opening', new Set(['opening', 'opening-2']))).toBe('opening-3');
    expect(packIdFor('Claude-Web-Chan', new Set(['claude-web-chan']))).toBe('claude-web-chan-2');
    expect([packIdFor('Stars', new Set()), packIdFor('cafe', new Set()), packIdFor('ignite', new Set()), packIdFor('ASCII', new Set())]).toEqual(['stars-2', 'cafe-2', 'ignite-2', 'ascii-2']);
  });
});

describe('开场动画包 · 网页包', () => {
  it('kind web: one page (index.html unless entry names another .html), a poster, at most 12 s', () => {
    expect(readPack({ name: 'Sparkle', author: 'me', license: 'MIT', kind: 'web', poster: 'p.webp', maxSeconds: 6 }, 'sparkle', false)).toEqual({
      id: 'sparkle', builtin: false, kind: 'web', name: 'Sparkle', author: 'me', license: 'MIT', poster: 'p.webp', entry: 'index.html', maxSeconds: 6,
    });
    expect(readPack({ kind: 'web', entry: 'play.htm', maxSeconds: 60 }, 'x', false)).toMatchObject({ entry: 'play.htm', maxSeconds: 12 });
    expect(mainFile({ kind: 'web', entry: 'play.htm' })).toBe('play.htm');
    expect(mainFile({ kind: 'video', intro: 'i.mp4' })).toBe('i.mp4');
  });
  it('refused: a page that is not a plain .html file of the folder', () => {
    expect(readPack({ kind: 'web', entry: '../index.html' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'web', entry: 'run.js' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'web', entry: 'a/b.html' }, 'x', false)).toHaveProperty('error');
    expect(readPack({ kind: 'web', poster: 'p.svg' }, 'x', false)).toHaveProperty('error');
  });
});
