// 从 GitHub 安装 (开场动画包): a pack folder in a GitHub repository — its opening.json and the files it names — read
// through GitHub's own API. Only github.com addresses go in, only raw.githubusercontent.com downloads come out, each
// file within its size; the caller keeps the files aside and moves them in only once the user, who has seen the author
// and the licence, says yes (service.ts `githubInspect` / `githubInstall`).
import { tr } from '../i18n/index.js';

export interface GithubTarget { owner: string; repo: string; ref?: string; path: string }
export interface GithubFile { name: string; size: number; download: string }
export interface GithubPack { json: unknown; files: GithubFile[]; source: string; owner: string; repoLicense?: string; ref: string }

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^(?!\.{1,2}$)[^\\/:*?"<>|\0]{1,200}$/;

/**
 * A GitHub address → what to read: `owner/repo`, the repository's page (its root folder), a folder in it
 * (`…/tree/<ref>/<path>`) or its opening.json (`…/blob/<ref>/<path>/opening.json`). Anything else → null.
 * (A branch with a `/` in its name reads as branch + folder: GitHub's own addresses do not say where it ends.)
 */
export function parseGithubUrl(input: string): GithubTarget | null {
  const s = String(input ?? '').trim();
  // owner/repo (an owner never has a dot: github.com/x is an address, not a shorthand)
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(s);
  if (short && OWNER.test(short[1]) && REPO.test(short[2])) return { owner: short[1], repo: short[2].replace(/\.git$/i, ''), path: '' };
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !/^(www\.)?github\.com$/i.test(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) return null;
  let parts: string[];
  try { parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (parts.length < 2) return null;
  const [owner, rawRepo, mode, ref, ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  if (!mode) return { owner, repo, path: '' };
  if ((mode !== 'tree' && mode !== 'blob') || !ref || !SEGMENT.test(ref) || !rest.every((p) => SEGMENT.test(p))) return null;
  if (mode === 'blob') {
    if (rest[rest.length - 1] !== 'opening.json') return null;
    rest.pop();
  }
  return { owner, repo, ref, path: rest.join('/') };
}

/** A download GitHub's API hands out for a file: raw.githubusercontent.com over https, nothing else. */
export function rawUrlOk(url: unknown): url is string {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'raw.githubusercontent.com' && !u.username && !u.password;
  } catch { return false; }
}

const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'claude-web', 'x-github-api-version': '2022-11-28' };

/** The repository's folder: its files (name, size, download), its opening.json parsed, who owns it and its licence. */
export async function readGithubPack(t: GithubTarget, o: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<GithubPack> {
  const f = o.fetch ?? fetch;
  const api = `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
  const get = async (url: string): Promise<any> => {
    let r: Response;
    try { r = await f(url, { headers: HEADERS, signal: o.signal ?? AbortSignal.timeout(20_000) }); } catch (e: any) {
      throw new Error(tr('连不上 GitHub：{error}', { error: e?.message ?? e }));
    }
    if (r.status === 404) throw new Error(tr('GitHub 上找不到这个仓库或文件夹（私有仓库装不了）'));
    if (r.status === 403 || r.status === 429) throw new Error(tr('GitHub 暂时不让再查了（不登录每小时只能查 60 次），过一会儿再试'));
    if (!r.ok) throw new Error(tr('GitHub 回了 {status}', { status: r.status }));
    return r.json();
  };
  const repo = await get(api);
  const ref = t.ref ?? (typeof repo?.default_branch === 'string' ? repo.default_branch : 'main');
  const where = t.path ? `/${t.path.split('/').map(encodeURIComponent).join('/')}` : '';
  const listing = await get(`${api}/contents${where}?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(listing)) throw new Error(tr('这个地址指向的是一个文件，要放动画包的那个文件夹'));
  const files: GithubFile[] = listing
    .filter((e: any) => e && e.type === 'file' && typeof e.name === 'string' && rawUrlOk(e.download_url))
    .map((e: any) => ({ name: String(e.name), size: Number(e.size) || 0, download: String(e.download_url) }));
  const oj = files.find((x) => x.name === 'opening.json');
  if (!oj) throw new Error(tr('这个文件夹里没有 opening.json，不是动画包'));
  if (oj.size > 64 * 1024) throw new Error(tr('opening.json 太大了'));
  let json: unknown;
  try {
    const r = await f(oj.download, { headers: { 'user-agent': 'claude-web' }, signal: o.signal ?? AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    json = JSON.parse(await r.text());
  } catch (e: any) {
    throw new Error(tr('opening.json 读不了：{error}', { error: e?.message ?? e }));
  }
  const lic = repo?.license;
  const repoLicense = typeof lic?.spdx_id === 'string' && lic.spdx_id && lic.spdx_id !== 'NOASSERTION' ? lic.spdx_id : typeof lic?.name === 'string' ? lic.name : undefined;
  return {
    json, files, ref,
    source: `https://github.com/${t.owner}/${t.repo}${t.path ? `/tree/${ref}/${t.path}` : ''}`,
    owner: typeof repo?.owner?.login === 'string' ? repo.owner.login : t.owner,
    ...(repoLicense ? { repoLicense } : {}),
  };
}
