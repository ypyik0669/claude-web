import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledCandidates, expandWinVars, findBundled, installTool, mergePath, parseRegPath, wellKnownDirs } from './locate.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-locate-'))); tmp.push(d); return d; };
const touch = (f: string, mtime: number) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); fs.utimesSync(f, mtime / 1000, mtime / 1000); };

describe('PATH helpers', () => {
  it('expands %VAR% case-insensitively and leaves unknown ones', () => {
    expect(expandWinVars('%USERPROFILE%\\.local\\bin;%NOPE%\\x', { UserProfile: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\.local\\bin;%NOPE%\\x');
  });
  it('reads the value of reg query … /v Path', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;C:\\tools\r\n\r\n';
    expect(parseRegPath(out)).toBe('%USERPROFILE%\\AppData\\Roaming\\npm;C:\\tools');
    expect(parseRegPath('ERROR: not found')).toBeNull();
  });
  it('appends only what is missing (Windows: case and trailing slashes do not make a new entry)', () => {
    const r = mergePath('C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm\\', ['c:\\users\\u\\appdata\\roaming\\npm', 'C:\\new', 'C:\\new\\'], 'win32');
    expect(r.added).toEqual(['C:\\new']);
    expect(r.path).toBe('C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm\\;C:\\new');
    expect(mergePath('/usr/bin', ['/usr/bin/', '/opt/homebrew/bin'], 'darwin')).toEqual({ path: '/usr/bin:/opt/homebrew/bin', added: ['/opt/homebrew/bin'] });
  });
  it('knows where npm -g, fnm, uv and friends put their bins', () => {
    const win = wellKnownDirs('win32', { APPDATA: 'C:\\U\\AppData\\Roaming', LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, 'C:\\U');
    expect(win).toContain(path.join('C:\\U\\AppData\\Roaming', 'npm'));
    expect(win).toContain(path.join('C:\\U\\AppData\\Roaming', 'fnm', 'aliases', 'default'));
    expect(win).toContain(path.join('C:\\U', '.local', 'bin'));
    const mac = wellKnownDirs('darwin', {}, '/Users/u');
    expect(mac).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/usr/local/bin', path.join('/Users/u', '.local', 'bin')]));
  });
  it('the 安装 button needs npm / uv', () => {
    expect(installTool('npm i -g @openai/codex')).toMatchObject({ tool: 'npm', name: 'Node.js' });
    expect(installTool('uv tool install kimi-cli')).toMatchObject({ tool: 'uv' });
    expect(installTool('')).toBeNull();
  });
});

describe('an agent shipped inside another app', () => {
  it('only Codex has candidates', () => {
    expect(bundledCandidates('gemini', 'win32', 'x64', {}, 'C:\\U')).toEqual([]);
    expect(bundledCandidates('codex', 'darwin', 'arm64', {}, '/Users/u').some((c) => c.pattern.join('/').includes('Codex.app'))).toBe(true);
  });
  it('the newest of the desktop app copies (bin\\codex.exe, bin\\<hash>\\codex.exe) and the IDE extensions', () => {
    const home = mk();
    const local = path.join(home, 'AppData', 'Local');
    const env = { LOCALAPPDATA: local };
    expect(findBundled('codex', { platform: 'win32', arch: 'x64', env, home })).toBeNull();
    touch(path.join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe'), Date.UTC(2026, 4, 10));
    touch(path.join(local, 'OpenAI', 'Codex', 'bin', 'faa963', 'codex.exe'), Date.UTC(2026, 8, 27));
    touch(path.join(home, '.vscode', 'extensions', 'openai.chatgpt-26.6-win32-x64', 'bin', 'windows-x86_64', 'codex.exe'), Date.UTC(2026, 5, 19));
    expect(findBundled('codex', { platform: 'win32', arch: 'x64', env, home })).toEqual({ file: path.join(local, 'OpenAI', 'Codex', 'bin', 'faa963', 'codex.exe'), from: 'Codex 桌面版' });
    touch(path.join(home, '.cursor', 'extensions', 'openai.chatgpt-27.0-win32-x64', 'bin', 'windows-x86_64', 'codex.exe'), Date.UTC(2026, 8, 29));
    expect(findBundled('codex', { platform: 'win32', arch: 'x64', env, home })).toMatchObject({ from: 'Codex IDE 扩展' });
    expect(findBundled('gemini', { platform: 'win32', arch: 'x64', env, home })).toBeNull();
  });
});
