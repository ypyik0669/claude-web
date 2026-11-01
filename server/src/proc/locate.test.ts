import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandWinVars, mergePath, parseRegPath, parseRegValue, wellKnownDirs } from './locate.js';

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
});

describe('reg query parsing', () => {
  it('reads one named value, keeping quotes as written (some installers quote the path)', () => {
    expect(parseRegValue('    InstallLocation    REG_SZ    "C:\\Program Files\\X"', 'InstallLocation')).toBe('"C:\\Program Files\\X"');
    expect(parseRegValue('    DisplayName    REG_SZ    x', 'InstallLocation')).toBeNull();
  });
});
