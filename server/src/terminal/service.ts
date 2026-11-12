import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveClaudeExe } from '../claude-exe.js';
import { tr } from '../i18n/index.js';
import { localEnv } from '../runtime/local-env.js';
import { toWslPath } from '../wsl/paths.js';
import type { PickDirResult } from '../protocol.js';

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

  async open(cwd: string, cols: number, rows: number, o: { wsl?: { distro: string } } = {}) {
    if (!(await this.available())) throw new Error('node-pty is not installed; run `npm i -w server node-pty` to enable the terminal panel');
    const termId = randomUUID();
    let exe: string | null = null;
    try { exe = resolveClaudeExe(); } catch { /* no bundled claude: the shell still works */ }
    const sh = terminalShell(process.platform, { ...process.env, ...localEnv(), CLAUDE_CODE_ENTRYPOINT: 'claude-web-terminal' }, exe);
    // stage E5: a WSL conversation's terminal is a shell of its distro, in its folder (cmd.exe cannot start in a UNC path)
    const d = o.wsl?.distro;
    const p: Pty = d && process.platform === 'win32'
      ? this.ptyMod.spawn('wsl.exe', ['-d', d, '--cd', toWslPath(cwd, d) ?? '~'], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: sh.env })
      : this.ptyMod.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd: cwd || os.homedir(), env: sh.env });
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

  /** Native folder picker (PowerShell on Windows, AppleScript on macOS, zenity / kdialog on Linux). Null when cancelled. */
  pickDir(): Promise<PickDirResult> {
    const done = (res: (v: string | null) => void) => (_e: unknown, out: string) => res(String(out ?? '').trim().replace(/(.)\/$/, '$1') || null);
    if (process.platform === 'darwin') {
      return new Promise((res) => execFile('osascript', ['-e', tr('POSIX path of (choose folder with prompt "选择工作目录")')], { windowsHide: true }, done(res)));
    }
    if (process.platform !== 'win32') return linuxPickDir(process.env, runPicker);
    return windowsPickDir(runPicker);
  }
}

type PickerRun = (file: string, args: string[]) => Promise<{ code: number | string | null; out: string; err: string }>;

const runPicker: PickerRun = (file, args) => new Promise((res) => execFile(file, args, { windowsHide: true }, (e, out, err) => {
  res({ code: e ? ((e as NodeJS.ErrnoException).code ?? (e as { status?: number }).status ?? 1) : 0, out: String(out ?? ''), err: String(err ?? '') });
}));

/**
 * The dialog is owned by a borderless topmost form parked off-screen, not shown with no owner. With no owner it lands
 * behind whatever the user is looking at — this server is a background process, so it has no right to take the
 * foreground — and WinForms' invisible parking window owns it, so there is no taskbar button to find it by either.
 * 「打开文件夹…」 then looks dead while every click leaves a powershell.exe waiting for a click nobody can make
 * (2026-11-12: eight of them). Off-screen, not hidden: a 0×0 size is clamped back to a visible box in the screen's
 * corner, and Opacity 0 / an empty Region both cost the form the activation that brings the dialog to the front.
 */
const WIN_PICKER_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None; $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual; $f.Location = New-Object System.Drawing.Point(-32000, -32000); $f.Show(); $f.Activate(); $r = $d.ShowDialog($f); $f.Close(); if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }';

/**
 * Windows: PowerShell's FolderBrowserDialog. Cancelled is exit 0 with nothing printed; PowerShell could not run at all
 * or the script failed is `unavailable`, so the page opens its own folder browser instead of a button that does nothing.
 */
export async function windowsPickDir(run: PickerRun): Promise<PickDirResult> {
  const r = await run('powershell', ['-NoProfile', '-STA', '-Command', WIN_PICKER_SCRIPT]);
  const picked = r.out.trim();
  if (picked) return picked;
  return r.code === 0 ? null : { unavailable: 'no-dialog' };
}

/**
 * Linux: zenity, then kdialog. Before issue #12 a missing zenity (Debian server / minimal installs) or no display
 * (a headless box, ssh, a service) answered null — the same as "cancelled" — and clicking the button did nothing;
 * now the page is told the native dialog is unavailable and opens its own folder browser.
 */
export async function linuxPickDir(env: Record<string, string | undefined>, run: PickerRun): Promise<PickDirResult> {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { unavailable: 'no-display' };
  const tools: Array<[string, string[]]> = [
    ['zenity', ['--file-selection', '--directory', tr('--title=选择工作目录')]],
    ['kdialog', ['--getexistingdirectory', env.HOME || os.homedir(), '--title', tr('选择工作目录')]],
  ];
  for (const [file, args] of tools) {
    const r = await run(file, args);
    // it could not be started at all (ENOENT; EACCES when something by that name on PATH is not runnable — seen in
    // WSL, whose PATH carries the Windows folders): the next one. An exit status is a number.
    if (typeof r.code === 'string') continue;
    const picked = r.out.trim().replace(/(.)\/$/, '$1');
    if (r.code === 0 && picked) return picked;
    if (/cannot open display|failed to open display|could not connect to display|could not connect: /i.test(r.err)) return { unavailable: 'no-display' };
    return null; // cancelled (zenity / kdialog exit 1 with nothing printed)
  }
  return { unavailable: 'no-dialog' };
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
