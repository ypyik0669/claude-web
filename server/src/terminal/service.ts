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
 * Optional embedded terminal running the real `claude` CLI. Requires node-pty, which needs
 * native build tools; when it is missing, open() throws and the UI hides the panel.
 */
export class TerminalService extends EventEmitter {
  private terms = new Map<string, Pty>();
  private ptyMod: any | null | undefined;

  async available() {
    if (this.ptyMod === undefined) {
      try {
        // packaged (Electron asar): node-pty must load from app.asar.unpacked
        const unpacked = (process as any).resourcesPath ? path.join((process as any).resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty') : null;
        const spec = unpacked && fs.existsSync(unpacked) ? pathToFileURL(path.join(unpacked, 'lib', 'index.js')).href : 'node-pty';
        this.ptyMod = await import(spec);
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
    const p: Pty = this.ptyMod.spawn(resolveClaudeExe(), [], { name: 'xterm-256color', cols, rows, cwd: cwd || os.homedir(), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-web-terminal' } });
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
      return new Promise((res) => execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择工作目录")'], done(res)));
    }
    if (process.platform !== 'win32') {
      return new Promise((res) => execFile('zenity', ['--file-selection', '--directory', '--title=选择工作目录'], done(res)));
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
