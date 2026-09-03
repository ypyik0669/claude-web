import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ToolInfo { id: string; label: string; ok: boolean; version: string; path: string; hint: string; url: string }

const TOOLS: { id: string; label: string; cmd: string; args: string[]; parse?: RegExp; hint: string; url: string }[] = [
  { id: 'git', label: 'Git', cmd: 'git', args: ['--version'], hint: 'winget install Git.Git', url: 'https://git-scm.com' },
  { id: 'gh', label: 'GitHub CLI', cmd: 'gh', args: ['--version'], parse: /gh version (\S+)/, hint: 'winget install GitHub.cli，然后 gh auth login', url: 'https://cli.github.com' },
  { id: 'node', label: 'Node.js', cmd: 'node', args: ['--version'], hint: 'https://nodejs.org 或 nvm', url: 'https://nodejs.org' },
  { id: 'npm', label: 'npm', cmd: 'npm', args: ['--version'], hint: '随 Node.js 安装', url: 'https://nodejs.org' },
  { id: 'pnpm', label: 'pnpm', cmd: 'pnpm', args: ['--version'], hint: 'npm i -g pnpm', url: 'https://pnpm.io' },
  { id: 'python', label: 'Python', cmd: 'python', args: ['--version'], hint: 'winget install Python.Python.3.12', url: 'https://python.org' },
  { id: 'uv', label: 'uv', cmd: 'uv', args: ['--version'], hint: 'winget install astral-sh.uv', url: 'https://docs.astral.sh/uv' },
  { id: 'rg', label: 'ripgrep', cmd: 'rg', args: ['--version'], parse: /ripgrep (\S+)/, hint: 'winget install BurntSushi.ripgrep.MSVC（内置引擎已自带，可选）', url: 'https://github.com/BurntSushi/ripgrep' },
  { id: 'docker', label: 'Docker', cmd: 'docker', args: ['--version'], hint: 'Docker Desktop', url: 'https://docker.com' },
  { id: 'code', label: 'VS Code', cmd: 'code', args: ['--version'], parse: /^(\S+)/, hint: 'winget install Microsoft.VisualStudioCode（勾选加入 PATH）', url: 'https://code.visualstudio.com' },
  { id: 'claude', label: 'Claude Code (全局)', cmd: 'claude', args: ['--version'], hint: 'npm i -g @anthropic-ai/claude-code（本应用自带引擎，全局安装可选）', url: 'https://docs.anthropic.com/claude-code' },
  { id: 'go', label: 'Go', cmd: 'go', args: ['version'], parse: /go(\d+\.\S+)/, hint: 'winget install GoLang.Go', url: 'https://go.dev' },
  { id: 'cargo', label: 'Rust (cargo)', cmd: 'cargo', args: ['--version'], hint: 'rustup', url: 'https://rustup.rs' },
  { id: 'java', label: 'Java', cmd: 'java', args: ['-version'], parse: /version "([^"]+)"/, hint: 'winget install EclipseAdoptium.Temurin.21.JDK', url: 'https://adoptium.net' },
];

async function where(cmd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true, timeout: 5000 });
    return stdout.split(/\r?\n/).filter(Boolean)[0] ?? '';
  } catch {
    return '';
  }
}

export async function detectTools(): Promise<ToolInfo[]> {
  return Promise.all(TOOLS.map(async (t) => {
    try {
      const { stdout, stderr } = await execFileAsync(t.cmd, t.args, { windowsHide: true, timeout: 8000, shell: process.platform === 'win32' });
      const text = `${stdout}${stderr}`.trim();
      const version = t.parse ? (t.parse.exec(text)?.[1] ?? text.split('\n')[0]) : text.split('\n')[0].replace(/^[a-zA-Z .]*?(?=v?\d)/, '');
      return { id: t.id, label: t.label, ok: true, version: version.slice(0, 40), path: await where(t.cmd), hint: t.hint, url: t.url };
    } catch {
      return { id: t.id, label: t.label, ok: false, version: '', path: '', hint: t.hint, url: t.url };
    }
  }));
}
