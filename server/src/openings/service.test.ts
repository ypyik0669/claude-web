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
  it('says `changed` when a pack comes or goes (every window asks again)', async () => {
    let n = 0;
    svc.on('changed', () => n++);
    const f = path.join(base, 'Clip.mp4');
    fs.writeFileSync(f, 'v');
    await svc.addVideo(f);
    await svc.remove('clip');
    expect(n).toBe(2);
  });
});

describe('开场动画包 · 网页包', () => {
  it('a web pack folder is imported (its page and poster), listed, its page served; the app\'s own ids are never a folder name', async () => {
    const src = path.join(base, 'Stars');
    pack(src, { name: 'My Stars', kind: 'web', poster: 'p.png', maxSeconds: 5 }, { 'index.html': '<canvas></canvas>', 'p.png': 'img', 'notes.md': 'private' });
    const p = await svc.importFolder(src);
    // 'stars' is 星图's id: the folder becomes stars-2
    expect(p).toMatchObject({ id: 'stars-2', kind: 'web', entry: 'index.html', poster: 'p.png', maxSeconds: 5 });
    expect(fs.readdirSync(path.join(user, 'stars-2')).sort()).toEqual(['index.html', 'opening.json', 'p.png']);
    expect(svc.file('stars-2', 'index.html')).toBe(path.join(user, 'stars-2', 'index.html'));
    expect(svc.file('stars-2', 'notes.md')).toBeNull();
  });
  it('a folder named like one of the app\'s ids is not listed (a stray copy cannot shadow 星图)', () => {
    pack(path.join(user, 'stars'), { kind: 'web' }, { 'index.html': 'x' });
    expect(svc.list().map((p) => p.id)).not.toContain('stars');
    expect(svc.get('stars')).toBeNull();
  });
  it('a page over 8 MB is refused', async () => {
    const src = path.join(base, 'Huge');
    pack(src, { kind: 'web' }, { 'index.html': 'x'.repeat(8 * 1024 * 1024 + 1) });
    await expect(svc.importFolder(src)).rejects.toThrow(/8 MB/);
  });
});

describe('开场动画包 · the opening-pack skill\'s drafts and trial runs', () => {
  it('a draft is kept aside (not listed), drafted again under its id, saved into the packs, and removable', async () => {
    const d = svc.saveDraft({ name: 'Neon Rain', author: 'me', license: 'MIT', maxSeconds: 30, html: '<canvas></canvas>' });
    expect(d).toMatchObject({ id: 'neon-rain', kind: 'web', draft: true, maxSeconds: 12, author: 'me' });
    expect(svc.list().map((p) => p.id)).not.toContain('neon-rain');
    expect(svc.drafts().map((p) => p.id)).toEqual(['neon-rain']);
    // again, same id: replaces it
    svc.saveDraft({ id: 'neon-rain', name: 'Neon Rain', html: '<b>v2</b>' });
    expect(svc.draft('neon-rain')?.html).toBe('<b>v2</b>');
    let changed = 0;
    svc.on('changed', () => changed++);
    const saved = await svc.publishDraft('neon-rain');
    expect(saved).toMatchObject({ id: 'neon-rain', kind: 'web', builtin: false });
    expect(saved.draft).toBeUndefined();
    expect(changed).toBe(1);
    expect(svc.drafts()).toEqual([]);
    expect(svc.draft('neon-rain', true)?.html).toBe('<b>v2</b>');
    expect(await svc.remove('neon-rain')).toBe(true);
    expect(svc.get('neon-rain')).toBeNull();
  });
  it('refused: no page, no name, a built-in pack\'s id, an id of the app\'s, a draft that is not there', async () => {
    expect(() => svc.saveDraft({ name: 'x', html: '' })).toThrow();
    expect(() => svc.saveDraft({ html: '<b>x</b>' })).toThrow();
    expect(() => svc.saveDraft({ id: 'claude-web-chan', name: 'x', html: '<b>x</b>' })).toThrow();
    expect(() => svc.saveDraft({ id: 'cafe', name: 'x', html: '<b>x</b>' })).toThrow();
    expect(svc.saveDraft({ name: 'Claude Web Chan', html: '<b>x</b>' }).id).toBe('claude-web-chan-2');
    await expect(svc.publishDraft('nope')).rejects.toThrow(/opening_draft/);
  });
  it('a trial run goes to the most recent window and comes back with what it saw; none without a window, or from the wrong one', async () => {
    const d = svc.saveDraft({ name: 'T', html: '<b>t</b>' });
    expect(await svc.trial(d, '<b>t</b>')).toBeNull();
    const old = {}, win = {};
    const sent: string[] = [];
    svc.setHost(old, true, () => sent.push('old'));
    svc.setHost(win, true, (r) => {
      sent.push('win');
      expect(r.html).toBe('<b>t</b>');
      expect(svc.trialResult(old, r.id, { errors: [] })).toBe(false);
      setTimeout(() => svc.trialResult(win, r.id, { end: 'done', at: 3.2, errors: ['x'.repeat(2000)], avgMs: 4, maxMs: 9, frames: 190, png: 'data:image/png;base64,AAAA' }), 5);
    });
    const r = await svc.trial(d, '<b>t</b>');
    expect(sent).toEqual(['win']);
    expect(r).toMatchObject({ end: 'done', at: 3.2, avgMs: 4, maxMs: 9, frames: 190, png: 'data:image/png;base64,AAAA' });
    expect(r!.errors[0].length).toBe(600);
    // the window goes: what it was asked comes back empty at once
    svc.setHost(win, true, () => { /* never answers */ });
    const p = svc.trial(d, '<b>t</b>');
    svc.dropConnection(win);
    expect(await p).toBeNull();
  });
});

describe('开场动画包 · 从 GitHub 安装', () => {
  const RAW = 'https://raw.githubusercontent.com/someone/openings/main/neon';
  const routes: Record<string, unknown> = {
    'https://api.github.com/repos/someone/openings': { default_branch: 'main', owner: { login: 'someone' }, license: { spdx_id: 'MIT' } },
    'https://api.github.com/repos/someone/openings/contents/neon?ref=main': [
      { type: 'file', name: 'opening.json', size: 60, download_url: `${RAW}/opening.json` },
      { type: 'file', name: 'index.html', size: 10, download_url: `${RAW}/index.html` },
      { type: 'file', name: 'secret.txt', size: 3, download_url: `${RAW}/secret.txt` },
    ],
    [`${RAW}/opening.json`]: { name: 'Neon', kind: 'web', author: 'Someone', license: 'CC-BY-4.0' },
    [`${RAW}/index.html`]: '<b>neon</b>',
  };
  const fake = (async (url: string | URL) => {
    const b = routes[String(url)];
    return b === undefined ? new Response('no', { status: 404 }) : new Response(typeof b === 'string' ? b : JSON.stringify(b));
  }) as unknown as typeof fetch;

  it('the offer: the pack\'s name, author and licence, the repository\'s licence, where it is from — and nothing installed yet', async () => {
    const gh = new OpeningService({ builtinDir: builtin, userDir: user, fetch: fake, goingOut: async () => {} });
    const o = await gh.githubInspect('https://github.com/someone/openings/tree/main/neon');
    expect(o).toMatchObject({ info: { name: 'Neon', author: 'Someone', license: 'CC-BY-4.0', kind: 'web' }, owner: 'someone', repoLicense: 'MIT', source: 'https://github.com/someone/openings/tree/main/neon', files: [{ name: 'index.html', size: 10 }], bytes: 10 });
    expect(gh.list().map((p) => p.id)).toEqual(['claude-web-chan']);
    // yes: it moves in under the folder's name, only with the files it uses
    const p = await gh.githubInstall(o.token);
    expect(p).toMatchObject({ id: 'neon', kind: 'web', author: 'Someone' });
    expect(fs.readdirSync(path.join(user, 'neon')).sort()).toEqual(['index.html', 'opening.json']);
    expect(fs.readFileSync(path.join(user, 'neon', 'index.html'), 'utf8')).toBe('<b>neon</b>');
    // the same offer twice: gone
    await expect(gh.githubInstall(o.token)).rejects.toThrow(/过期/);
  });
  it('no: the files kept aside go; a file the pack names but the folder lacks, or a non-GitHub address, is refused', async () => {
    const gh = new OpeningService({ builtinDir: builtin, userDir: user, fetch: fake });
    const o = await gh.githubInspect('https://github.com/someone/openings/tree/main/neon');
    expect(fs.readdirSync(user).filter((n) => n.startsWith('.tmp-gh-'))).toHaveLength(1);
    await gh.githubCancel(o.token);
    expect(fs.readdirSync(user).filter((n) => n.startsWith('.tmp-gh-'))).toEqual([]);
    await expect(gh.githubInstall(o.token)).rejects.toThrow();
    await expect(gh.githubInspect('https://gitlab.com/a/b')).rejects.toThrow(/github\.com/);
    const was = routes[`${RAW}/opening.json`];
    routes[`${RAW}/opening.json`] = { name: 'Neon', kind: 'web', entry: 'play.html' };
    try {
      await expect(gh.githubInspect('https://github.com/someone/openings/tree/main/neon')).rejects.toThrow(/play\.html/);
    } finally { routes[`${RAW}/opening.json`] = was; }
    expect(fs.readdirSync(user).filter((n) => n.startsWith('.tmp-gh-'))).toEqual([]);
  });
});
