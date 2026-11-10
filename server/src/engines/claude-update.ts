// Keeps the official Claude Code binary current without a Claude Web release. The binary ships inside the npm
// package `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`; when the registry has a newer one than the bundled copy
// it is downloaded (checked against the integrity npm publishes), its `claude[.exe]` extracted to
// `<data>/engines/claude/<pkg version>/`, and run once with `--version` before it is used. resolveClaudeExe picks the
// newest of bundled / downloaded. New models are gated on the client version, so this is what keeps them reachable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { cmpVersion, noteClaudeVersion } from '../claude-version.js';
import { extractTarGzFile } from '../plugins/archive.js';

const require = createRequire(import.meta.url);
const isWin = process.platform === 'win32';
const EXE = isWin ? 'claude.exe' : 'claude';
export const CLAUDE_PKG = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const MAX_TGZ = 1024 * 1024 * 1024;

export const claudeEnginesDir = () => path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'engines', 'claude');

/** The bundled platform package's version (`0.3.322`), or null when this platform has none bundled. */
export function bundledClaudePkgVersion(): string | null {
  try { return (require(`${CLAUDE_PKG}/package.json`) as { version?: string }).version ?? null; } catch { return null; }
}

/** The newest downloaded binary: `{ file, version }` (package version), or null. Synchronous — used on every spawn. */
export function downloadedClaude(dir = claudeEnginesDir()): { file: string; version: string } | null {
  let best: { file: string; version: string } | null = null;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const v of names) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) continue;
    const file = path.join(dir, v, EXE);
    if (fs.existsSync(file) && (!best || cmpVersion(v, best.version) > 0)) best = { file, version: v };
  }
  return best;
}

function cliVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    // a file Windows cannot run at all throws here (spawn UNKNOWN), not in the callback
    try { execFile(file, ['--version'], { windowsHide: true, timeout: 30_000 }, (err, out) => resolve(err ? null : /\d+\.\d+\.\d+/.exec(String(out))?.[0] ?? null)); } catch { resolve(null); }
  });
}

async function download(url: string, dest: string, integrity: string, fetchImpl: typeof fetch): Promise<void> {
  const sri = /^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!sri) throw new Error('no integrity from the registry');
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = crypto.createHash(sri[1]);
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  let n = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      n += chunk.length;
      if (n > MAX_TGZ) throw new Error('package larger than expected');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    throw e;
  }
  if (hash.digest('base64') !== sri[2]) throw new Error('integrity mismatch');
}

export interface ClaudeUpdateResult { updated: boolean; version?: string; cli?: string; error?: string }

let running: Promise<ClaudeUpdateResult> | null = null;

/** Check the registry and install a newer binary if there is one. One run at a time; never throws. */
export function updateClaudeBinary(o: { fetchImpl?: typeof fetch; dir?: string; registry?: string } = {}): Promise<ClaudeUpdateResult> {
  if (process.env.CW_NO_CLAUDE_UPDATE) return Promise.resolve({ updated: false });
  running ??= run(o).finally(() => { running = null; });
  return running;
}

async function run({ fetchImpl = fetch, dir = claudeEnginesDir(), registry = 'https://registry.npmjs.org' }: { fetchImpl?: typeof fetch; dir?: string; registry?: string }): Promise<ClaudeUpdateResult> {
  let tmp = '';
  try {
    const r = await fetchImpl(`${registry}/${CLAUDE_PKG.replace('/', '%2f')}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { updated: false, error: `registry HTTP ${r.status}` };
    const meta = (await r.json()) as { version?: string; dist?: { tarball?: string; integrity?: string } };
    const latest = meta.version;
    if (!latest || !meta.dist?.tarball || !meta.dist.integrity) return { updated: false, error: 'registry answer incomplete' };
    const have = [bundledClaudePkgVersion(), downloadedClaude(dir)?.version].filter((v): v is string => !!v);
    if (have.some((v) => cmpVersion(v, latest) >= 0)) return { updated: false, version: latest };

    fs.mkdirSync(dir, { recursive: true });
    tmp = fs.mkdtempSync(path.join(dir, `.dl-${latest}-`));
    const tgz = path.join(tmp, 'pkg.tgz');
    await download(meta.dist.tarball, tgz, meta.dist.integrity, fetchImpl);
    const out = path.join(tmp, 'x');
    await extractTarGzFile(tgz, out, { want: (rel) => rel === `package/${EXE}`, maxEntry: MAX_TGZ, maxInflated: 2 * MAX_TGZ });
    const exe = path.join(out, 'package', EXE);
    if (!fs.existsSync(exe)) return { updated: false, error: `no ${EXE} in the package` };
    if (!isWin) fs.chmodSync(exe, 0o755);
    const cli = await cliVersion(exe);
    if (!cli) return { updated: false, error: 'the downloaded binary did not run' };
    const final = path.join(dir, latest);
    fs.rmSync(final, { recursive: true, force: true });
    fs.mkdirSync(final, { recursive: true });
    fs.renameSync(exe, path.join(final, EXE));
    noteClaudeVersion(cli);
    prune(dir, latest);
    return { updated: true, version: latest, cli };
  } catch (e) {
    return { updated: false, error: (e as Error).message };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Keep the newest two: a running conversation may still hold the previous binary open (Windows locks it). */
function prune(dir: string, keep: string): void {
  const vs = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => cmpVersion(b, a));
  for (const v of vs.slice(2)) if (v !== keep) try { fs.rmSync(path.join(dir, v), { recursive: true, force: true }); } catch { /* in use */ }
}

/** Note the version of the binary actually in use (bundled or downloaded), so the fingerprint is never behind it. */
export async function noteInstalledClaudeVersion(file: string): Promise<void> {
  noteClaudeVersion(await cliVersion(file));
}
