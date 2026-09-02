import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
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
        this.ptyMod = await import('node-pty' as string);
      } catch {
        this.ptyMod = null;
      }
    }
    return !!this.ptyMod;
  }

  async open(cwd: string, cols: number, rows: number) {
    if (!(await this.available())) throw new Error('node-pty is not installed; run `npm i -w server node-pty` to enable the terminal panel');
    const termId = randomUUID();
    const p: Pty = this.ptyMod.spawn(resolveClaudeExe(), [], { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-web-terminal' } });
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
    this.terms.get(termId)?.kill();
    this.terms.delete(termId);
  }

  /** Native folder picker (Windows only, via PowerShell). Returns null when cancelled. */
  pickDir(): Promise<string | null> {
    if (process.platform !== 'win32') return Promise.resolve(null);
    const script = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }';
    return new Promise((res) => execFile('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true }, (_e, out) => res(out.trim() || null)));
  }
}
