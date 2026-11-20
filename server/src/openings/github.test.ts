import { describe, expect, it } from 'vitest';
import { parseGithubUrl, rawUrlOk, readGithubPack } from './github.js';

describe('从 GitHub 安装 · the address', () => {
  it('a repository, a folder in it, its opening.json, or owner/repo', () => {
    expect(parseGithubUrl('https://github.com/someone/openings')).toEqual({ owner: 'someone', repo: 'openings', path: '' });
    expect(parseGithubUrl('github.com/someone/openings.git')).toEqual({ owner: 'someone', repo: 'openings', path: '' });
    expect(parseGithubUrl('https://github.com/someone/openings/tree/main/packs/neon')).toEqual({ owner: 'someone', repo: 'openings', ref: 'main', path: 'packs/neon' });
    expect(parseGithubUrl('https://github.com/someone/openings/blob/v2/neon/opening.json')).toEqual({ owner: 'someone', repo: 'openings', ref: 'v2', path: 'neon' });
    expect(parseGithubUrl('https://github.com/someone/openings/blob/main/opening.json')).toEqual({ owner: 'someone', repo: 'openings', ref: 'main', path: '' });
    expect(parseGithubUrl('  someone/openings ')).toEqual({ owner: 'someone', repo: 'openings', path: '' });
  });
  it('anything else is refused: other hosts, other pages of a repository, a file that is not opening.json, a way out of the folder', () => {
    for (const bad of [
      'https://gitlab.com/someone/openings', 'https://github.com.evil.com/a/b', 'https://raw.githubusercontent.com/a/b/main/x', 'https://github.com/someone',
      'https://github.com/someone/openings/issues/3', 'https://github.com/someone/openings/blob/main/index.html', 'https://github.com/a/b/tree/main/../../etc',
      'file:///C:/x', 'https://user:pw@github.com/a/b', 'https://github.com:8443/a/b', 'github.com/x', '', 'not an address at all',
    ]) expect(parseGithubUrl(bad), bad).toBeNull();
  });
  it('downloads only from raw.githubusercontent.com over https', () => {
    expect(rawUrlOk('https://raw.githubusercontent.com/a/b/main/opening.json')).toBe(true);
    expect(rawUrlOk('http://raw.githubusercontent.com/a/b/main/opening.json')).toBe(false);
    expect(rawUrlOk('https://evil.com/raw.githubusercontent.com/x')).toBe(false);
    expect(rawUrlOk(null)).toBe(false);
  });
});

describe('从 GitHub 安装 · reading a pack through the API', () => {
  const RAW = 'https://raw.githubusercontent.com/someone/openings/main/neon';
  const api = (routes: Record<string, { status?: number; body: unknown }>) => (async (url: string | URL) => {
    const r = routes[String(url)];
    if (!r) return new Response('nope', { status: 404 });
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;

  it('the folder\'s files, its opening.json, who owns it and the repository\'s licence', async () => {
    const f = api({
      'https://api.github.com/repos/someone/openings': { body: { default_branch: 'main', owner: { login: 'Someone' }, license: { spdx_id: 'CC-BY-4.0', name: 'Creative Commons' } } },
      'https://api.github.com/repos/someone/openings/contents/neon?ref=main': { body: [
        { type: 'file', name: 'opening.json', size: 80, download_url: `${RAW}/opening.json` },
        { type: 'file', name: 'index.html', size: 4000, download_url: `${RAW}/index.html` },
        { type: 'file', name: 'evil.html', size: 10, download_url: 'https://evil.com/evil.html' },
        { type: 'dir', name: 'src', size: 0, download_url: null },
      ] },
      [`${RAW}/opening.json`]: { body: { name: 'Neon', kind: 'web', author: 'Someone', license: 'MIT' } },
    });
    const r = await readGithubPack({ owner: 'someone', repo: 'openings', path: 'neon' }, { fetch: f });
    expect(r).toMatchObject({ owner: 'Someone', repoLicense: 'CC-BY-4.0', ref: 'main', source: 'https://github.com/someone/openings/tree/main/neon', json: { name: 'Neon', kind: 'web' } });
    // only the folder's own files, downloadable from raw.githubusercontent.com
    expect(r.files.map((x) => x.name)).toEqual(['opening.json', 'index.html']);
  });
  it('says plainly what went wrong: no such repository, no opening.json, a file instead of a folder, the rate limit', async () => {
    await expect(readGithubPack({ owner: 'a', repo: 'b', path: '' }, { fetch: api({}) })).rejects.toThrow(/找不到/);
    const repo = { 'https://api.github.com/repos/a/b': { body: { default_branch: 'main' } } };
    await expect(readGithubPack({ owner: 'a', repo: 'b', path: '' }, { fetch: api({ ...repo, 'https://api.github.com/repos/a/b/contents?ref=main': { body: [] } }) })).rejects.toThrow(/opening\.json/);
    await expect(readGithubPack({ owner: 'a', repo: 'b', path: 'x' }, { fetch: api({ ...repo, 'https://api.github.com/repos/a/b/contents/x?ref=main': { body: { type: 'file' } } }) })).rejects.toThrow(/文件夹/);
    await expect(readGithubPack({ owner: 'a', repo: 'b', path: '' }, { fetch: api({ 'https://api.github.com/repos/a/b': { status: 403, body: {} } }) })).rejects.toThrow(/60/);
  });
});
