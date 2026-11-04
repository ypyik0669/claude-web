// agent-desktop (vercel-labs/agent-desktop, Apache-2.0): a small native program that reads the operating system's
// accessibility tree (UI Automation on Windows, AX on macOS) and acts on elements by ref — no screenshot → pixel
// round trip, and by default no real mouse / focus taken from the user. The `desktop` MCP server (desktop-mcp.ts)
// runs one of its commands per tool call.
//
// Not bundled: fetched once from its GitHub release on first use, pinned to one version and checked against the
// SHA-256 written here (its output format changes between releases), into <data>/tools/agent-desktop/<version>/.
// CW_AGENT_DESKTOP_BIN points at another copy (tests, a user who installed it themselves).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../files/service.js';

export const AGENT_DESKTOP_VERSION = '1.1.0';
/** the output envelope version this wrapper was written against */
export const ENVELOPE_VERSION = '2.6';

const ASSETS: Record<string, { target: string; sha256: string }> = {
  'win32-x64': { target: 'x86_64-pc-windows-msvc', sha256: '5c13b932add079c141da18631d65b1680d1b9bcb73942f2f99146c9ee13877f6' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc', sha256: '20e2a2a029bc7e86aaacf2003afa78708d66e4cb51f3c216597e1f5d79d496bf' },
  'darwin-x64': { target: 'x86_64-apple-darwin', sha256: 'b6352ac66aa49e0280c6f690de791dc03c827623a838950856b20ddbebcdc382' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', sha256: '3048e00aa0741bf25ffe0326f78c966408be4490ce13513f3f94ecf2a0b5270d' },
};

export function agentDesktopAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const a = ASSETS[`${platform}-${arch}`];
  if (!a) return null;
  const file = `agent-desktop-v${AGENT_DESKTOP_VERSION}-${a.target}.tar.gz`;
  return { ...a, file, url: `https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}/${file}` };
}

export const agentDesktopSupported = (platform: NodeJS.Platform = process.platform, arch: string = process.arch) => !!agentDesktopAsset(platform, arch);

export function agentDesktopDir(root = dataDir()): string {
  return path.join(root, 'tools', 'agent-desktop', AGENT_DESKTOP_VERSION);
}

const exeName = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop');

/** The program, when it is there now (no download). */
export function agentDesktopPath(env: NodeJS.ProcessEnv = process.env, root?: string): string | null {
  const own = env.CW_AGENT_DESKTOP_BIN?.trim();
  if (own) return fs.existsSync(own) ? own : null;
  const p = path.join(agentDesktopDir(root), exeName());
  return fs.existsSync(p) ? p : null;
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function untar(archive: string, dest: string): Promise<void> {
  // bsdtar ships with Windows 10 1803+ and macOS; it reads .tar.gz on both
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xzf', archive, '-C', dest], { windowsHide: true, timeout: 60_000 }, (e, _o, stderr) => (e ? reject(new Error(`tar: ${stderr || e.message}`)) : resolve()));
  });
}

let pending: Promise<string> | null = null;

/** The program, fetched and checked first when it is not there yet. Concurrent callers share one download. */
export function ensureAgentDesktop(o: { env?: NodeJS.ProcessEnv; root?: string; fetch?: typeof fetch } = {}): Promise<string> {
  const have = agentDesktopPath(o.env, o.root);
  if (have) return Promise.resolve(have);
  if (o.env?.CW_AGENT_DESKTOP_BIN?.trim()) return Promise.reject(new Error(`CW_AGENT_DESKTOP_BIN points at a missing file: ${o.env.CW_AGENT_DESKTOP_BIN}`));
  pending ??= install(o).finally(() => { pending = null; });
  return pending;
}

async function install(o: { root?: string; fetch?: typeof fetch }): Promise<string> {
  const asset = agentDesktopAsset();
  if (!asset) throw new Error(`agent-desktop has no build for ${process.platform}-${process.arch}`);
  const dir = agentDesktopDir(o.root);
  const final = path.join(dir, exeName());
  const res = await (o.fetch ?? fetch)(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`downloading agent-desktop failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== asset.sha256) throw new Error(`agent-desktop download did not match its checksum (got ${got})`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(dir), '.dl-'));
  try {
    const archive = path.join(tmp, asset.file);
    fs.writeFileSync(archive, buf);
    const out = path.join(tmp, 'x');
    fs.mkdirSync(out);
    await untar(archive, out);
    const exe = path.join(out, exeName());
    if (!fs.existsSync(exe)) throw new Error('agent-desktop archive has no program in it');
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    fs.rmSync(archive, { force: true });
    // another process may have finished first: theirs is the same checked file
    if (!fs.existsSync(final)) {
      try { fs.renameSync(out, dir); } catch (e) { if (!fs.existsSync(final)) throw e; }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return final;
}
