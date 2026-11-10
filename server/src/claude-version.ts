// The newest Claude Code version this machine knows of: the bundled / downloaded binary's own `--version`, and the
// npm registry's `@anthropic-ai/claude-code` latest. Anthropic gates new models on it ("Claude Code 2.1.280 does not
// support this model; version 2.1.290 or newer is required"), so whatever we send on the binary's behalf — the
// gateway's fingerprint User-Agent, our own API calls — uses this, never a version written into the source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Floor: the version the bundled Agent SDK binary had when this was last released. */
const FLOOR = '2.1.322';
const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

const file = () => path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'claude-version.json');

/** a < b → negative. Numeric parts of `x.y.z`; anything after (`-beta`, ` (Claude Code)`) is ignored. */
export function cmpVersion(a: string, b: string): number {
  const p = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v.trim()) ?? []).slice(1).map(Number);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

let seen: string | null = null;
function load(): string {
  if (seen) return seen;
  seen = FLOOR;
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'))?.version;
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) && cmpVersion(v, seen) > 0) seen = v;
  } catch { /* first run */ }
  return seen;
}

/** The newest Claude Code version known (never older than the bundled binary's). */
export function claudeCodeVersion(): string {
  return load();
}

/** A version seen somewhere (a binary's `--version`, the registry): kept when newer, and remembered across restarts. */
export function noteClaudeVersion(v: string | undefined | null): void {
  const m = v ? /^\d+\.\d+\.\d+/.exec(v.trim()) : null;
  if (!m || cmpVersion(m[0], load()) <= 0) return;
  seen = m[0];
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: seen, at: Date.now() }));
  } catch { /* read-only data dir: still used for this run */ }
}

/** Ask npm for the latest Claude Code release. Failures are silent (offline, no ladder): the last known stays. */
export async function refreshLatestClaudeVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const r = await fetchImpl(REGISTRY, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (r.ok) noteClaudeVersion(((await r.json()) as { version?: string })?.version);
  } catch { /* keep the last known */ }
  return claudeCodeVersion();
}

/** For tests. */
export function resetClaudeVersion(): void { seen = null; }
