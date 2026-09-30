import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveClaudeExe } from '../claude-exe.js';

type Pty = { write(d: string): void; resize(c: number, r: number): void; kill(): void; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void };

/**
 * The terminal panel's program: a real shell. It used to be the bundled `claude` TUI itself, which (a) checks
 * api.anthropic.com on start and exits where that answers 403 (mainland China without a proxy — people who only
 * use a relay), and (b) took every command the app types into a terminal (`npm i -g @openai/codex`, `codex login`,
 * `git init`…) as a chat prompt. Windows: cmd.exe (`ComSpec`) — PowerShell's default execution policy refuses
 * npm.ps1, so `npm i -g` would fail there; macOS / Linux: the user's `$SHELL` as a login shell. The bundled
 * claude's directory is appended to PATH so `claude` / `claude auth login` work; a claude of the user's own wins.
 */
export function terminalShell(platform: NodeJS.Platform, env: Record<string, string | undefined>, claudeExe: string | null): { file: string; args: string[]; env: Record<string, string> } {
  const win = platform === 'win32';
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  const pathKey = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = win ? ';' : ':';
  if (claudeExe) {
    const dir = win ? path.win32.dirname(claudeExe) : path.posix.dirname(claudeExe);
    const parts = (out[pathKey] ?? '').split(sep).filter(Boolean);
    if (!parts.some((p) => (win ? p.toLowerCase() === dir.toLowerCase() : p === dir))) parts.push(dir);
    out[pathKey] = parts.join(sep);
  }
  if (win) return { file: out.ComSpec || out.COMSPEC || 'cmd.exe', args: [], env: out };
  return { file: out.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'], env: out };
}

/**
 * Optional embedded terminal (a shell, see terminalShell). Requires node-pty, which needs
 * native build tools; when it is missing, open() throws and the UI hides the panel.
 */
export class TerminalService extends EventEmitter {
  private terms = new Map<string, Pty>();
  private ptyMod: any | null | undefined;

  async available() {
    if (this.ptyMod === undefined) {
      try {
        // packaged (Electron asar): node-pty must load from app.asar.unpacked
        const rp = (process as any).resourcesPath as string | undefined;
        const unpacked = rp ? path.join(rp, 'app.asar.unpacked', 'node_modules', 'node-pty') : null;
        // macOS / Linux: node-pty rewrites `app.asar` → `app.asar.unpacked` in its spawn-helper path itself, so it must be
        // loaded through the asar path — loading it from the unpacked dir yields `app.asar.unpacked.unpacked` and
        // every spawn fails with "posix_spawnp failed". Windows (no spawn-helper) keeps the unpacked load.
        const viaAsar = rp && process.platform !== 'win32' ? path.join(rp, 'app.asar', 'node_modules', 'node-pty', 'lib', 'index.js') : null;
        if (viaAsar && fs.existsSync(viaAsar)) {
          this.ptyMod = createRequire(import.meta.url)(viaAsar); // CJS require goes through Electron's asar support
        } else {
          this.ptyMod = await import(unpacked && fs.existsSync(unpacked) ? pathToFileURL(path.join(unpacked, 'lib', 'index.js')).href : 'node-pty');
        }
        if (this.ptyMod.default && !this.ptyMod.spawn) this.ptyMod = this.ptyMod.default;
        if (process.platform !== 'win32') fixSpawnHelper(unpacked && fs.existsSync(unpacked) ? unpacked : null);
      } catch {
        this.ptyMod = null;
      }
    }
    return !!this.ptyMod;
  }

  async open(cwd: string, cols: number, rows: number) {
    if (!(await this.available())) throw new Error('node-pty is not installed; run `npm i -w server node-pty` to enable the terminal panel');
    const termId = randomUUID();
    let exe: string | null = null;
    try { exe = resolveClaudeExe(); } catch { /* no bundled claude: the shell still works */ }
    const sh = terminalShell(process.platform, { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-web-terminal' }, exe);
    const p: Pty = this.ptyMod.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd: cwd || os.homedir(), env: sh.env });
    this.terms.set(termId, p);
    p.onData((d) => this.emit('data', termId, d));
    p.onExit((e) => {
      this.terms.delete(termId);
      this.emit('exit', termId, e.exitCode);
    });
    return { termId };
  }
  input(termId: string, data: string) {
    this.terms.get(termId)?.write(data);
  }
  resize(termId: string, cols: number, rows: number) {
    this.terms.get(termId)?.resize(cols, rows);
  }
  close(termId: string) {
    const p = this.terms.get(termId);
    this.terms.delete(termId);
    try {
      p?.kill();
    } catch {
      /* already exited (node-pty throws on Windows) */
    }
  }
  closeAll() {
    for (const id of [...this.terms.keys()]) this.close(id);
  }

  /** Native folder picker (PowerShell on Windows, AppleScript on macOS, zenity on Linux). Returns null when cancelled. */
  pickDir(): Promise<string | null> {
    const done = (res: (v: string | null) => void) => (_e: unknown, out: string) => res(String(out ?? '').trim().replace(/(.)\/$/, '$1') || null);
    if (process.platform === 'darwin') {
      return new Promise((res) => execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择工作目录")'], { windowsHide: true }, done(res)));
    }
    if (process.platform !== 'win32') {
      return new Promise((res) => execFile('zenity', ['--file-selection', '--directory', '--title=选择工作目录'], { windowsHide: true }, done(res)));
    }
    const script = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }';
    return new Promise((res) => execFile('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true }, (_e, out) => res(out.trim() || null)));
  }
}

/** npm tarballs can drop the +x bit on node-pty's darwin `spawn-helper`; pty.spawn then fails with "posix_spawnp failed". */
function fixSpawnHelper(unpacked: string | null) {
  try {
    const require = createRequire(import.meta.url);
    const root = unpacked ?? path.dirname(require.resolve('node-pty/package.json'));
    const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`);
    const helper = path.join(fs.existsSync(dir) ? dir : path.join(root, 'build', 'Release'), 'spawn-helper');
    if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0) fs.chmodSync(helper, 0o755);
  } catch {
    /* read-only install or no helper: pty.spawn reports the real error */
  }
}
