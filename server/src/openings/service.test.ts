import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpeningService } from './service.js';

let base: string;
let builtin: string;
let user: string;
let svc: OpeningService;

function pack(dir: string, json: object, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opening.json'), JSON.stringify(json));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-openings-'));
  builtin = path.join(base, 'builtin');
  user = path.join(base, 'user');
  pack(path.join(builtin, 'claude-web-chan'), { name: 'Claude Web 娘', kind: 'video', intro: 'intro.mp4', loop: 'loop.mp4', poster: 'poster.webp', logoAt: 9.71, shortFrom: 6.6 }, { 'intro.mp4': 'film', 'loop.mp4': 'loop', 'poster.webp': 'img', 'notes.txt': 'private' });
  svc = new OpeningService({ builtinDir: builtin, userDir: user });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('开场动画包 · the service', () => {
  it('lists the built-in pack; serves only the files it uses', () => {
    expect(svc.list().map((p) => [p.id, p.builtin])).toEqual([['claude-web-chan', true]]);
    expect(svc.file('claude-web-chan', 'loop.mp4')).toBe(path.join(builtin, 'claude-web-chan', 'loop.mp4'));
    expect(svc.file('claude-web-chan', 'notes.txt')).toBeNull();
    expect(svc.file('claude-web-chan', 'opening.json')).toBeNull();
    expect(svc.file('../builtin/claude-web-chan', 'intro.mp4')).toBeNull();
    expect(svc.file('nope', 'intro.mp4')).toBeNull();
  });
  it('a folder is imported (only what the pack uses), listed after the built-in ones, and removable; the built-in one is not', async () => {
    const src = path.join(base, 'My Pack');
    pack(src, { name: 'Mine', kind: 'video', intro: 'a.webm', poster: 'p.png' }, { 'a.webm': 'x', 'p.png': 'y', 'big-source.mov': 'z' });
    const p = await svc.importFolder(src);
    expect(p).toMatchObject({ id: 'my-pack', name: 'Mine', builtin: false, intro: 'a.webm', poster: 'p.png' });
    expect(fs.readdirSync(path.join(user, 'my-pack')).sort()).toEqual(['a.webm', 'opening.json', 'p.png']);
    expect(svc.list().map((x) => x.id)).toEqual(['claude-web-chan', 'my-pack']);
    // the same folder again: a second copy beside it
    expect((await svc.importFolder(src)).id).toBe('my-pack-2');
    expect(await svc.remove('my-pack')).toBe(true);
    expect(await svc.remove('claude-web-chan')).toBe(false);
    expect(svc.list().map((x) => x.id)).toEqual(['claude-web-chan', 'my-pack-2']);
  });
  it('import refuses a folder without opening.json, a pack whose film is missing, a relative path — and leaves nothing behind', async () => {
    await expect(svc.importFolder(path.join(base, 'nothing'))).rejects.toThrow(/opening\.json/);
    const src = path.join(base, 'broken');
    pack(src, { kind: 'video', intro: 'gone.mp4' }, {});
    await expect(svc.importFolder(src)).rejects.toThrow();
    await expect(svc.importFolder('relative/dir')).rejects.toThrow();
    expect(fs.existsSync(user) ? fs.readdirSync(user) : []).toEqual([]);
  });
  it('one video file becomes a pack of its own (the logo where the film ends, at most 12 s)', async () => {
    const f = path.join(base, 'Party Intro.mp4');
    fs.writeFileSync(f, 'vid');
    const p = await svc.addVideo(f);
    expect(p).toMatchObject({ id: 'party-intro', name: 'Party Intro', intro: 'intro.mp4', maxSeconds: 12, builtin: false });
    expect(p.logoAt).toBeUndefined();
    await expect(svc.addVideo(path.join(base, 'x.gif'))).rejects.toThrow();
  });
  it('a user folder with a built-in pack\'s name is not listed twice (the built-in one wins)', () => {
    pack(path.join(user, 'claude-web-chan'), { kind: 'video', intro: 'i.mp4' }, { 'i.mp4': 'x' });
    expect(svc.list().filter((p) => p.id === 'claude-web-chan')).toHaveLength(1);
    expect(svc.get('claude-web-chan')?.builtin).toBe(true);
  });
});
