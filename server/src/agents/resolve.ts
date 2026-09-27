import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

/** Node binary to run JS entries with (Electron has no `node` on PATH; the shell itself runs in Node mode). */
export function nodeRuntime(): { command: string; env: Record<string, string> } {
  if (process.versions.electron) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { command: process.execPath || 'node', env: {} };
}

/** Find `cmd` on PATH honouring PATHEXT on Windows. Returns the absolute file or null. */
export function findOnPath(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd) ? cmd : null;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (path.extname(cmd) ? [''] : ['.exe', '.cmd', '.bat', '.com', '']) : [''];
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, cmd + e);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/** Does the file start with a `#!…node` shebang (npm's POSIX bin scripts)? */
export function isNodeScript(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return /^#!.*\bnode\b/.test(buf.subarray(0, n).toString('utf8').split('\n')[0]);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/**
 * Turn a user-facing command (`gemini`, `codex`, a path…) into something `child_process.spawn` can run without a shell.
 * npm's Windows `.cmd` shims are unwrapped to `node <entry.js>` so the agent is a direct child (killable, no cmd.exe in between).
 */
export function resolveSpawn(command: string, args: string[]): { command: string; args: string[]; env: Record<string, string>; via: 'direct' | 'node-shim' | 'cmd' } {
  if (!isWin) {
    // npm bins are `#!/usr/bin/env node` scripts. A Finder-launched macOS app gets a minimal PATH without node, so
    // the shebang fails with exit 127 even when the script itself was found — run it with our own Node instead.
    const found = findOnPath(command);
    if (found && isNodeScript(found) && !findOnPath('node')) { const n = nodeRuntime(); return { command: n.command, args: [found, ...args], env: n.env, via: 'node-shim' }; }
    return { command, args, env: {}, via: 'direct' };
  }
  const found = findOnPath(command) ?? command;
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args, env: {}, via: 'direct' };
  try {
    const text = fs.readFileSync(found, 'utf8');
    const m = /"%dp0%\\([^"]+\.(?:m?js|cjs))"/i.exec(text) ?? /"%~dp0\\([^"]+\.(?:m?js|cjs))"/i.exec(text);
    if (m) {
      const entry = path.join(path.dirname(found), m[1]);
      if (fs.existsSync(entry)) { const n = nodeRuntime(); return { command: n.command, args: [entry, ...args], env: n.env, via: 'node-shim' }; }
    }
  } catch { /* fall through */ }
  // generic .cmd/.bat: run through cmd.exe with proper quoting
  const q = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[found, ...args].map(q).join(' ')}"`], env: {}, via: 'cmd' };
}
