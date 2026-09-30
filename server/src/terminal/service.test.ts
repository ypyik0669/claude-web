import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { terminalShell } from './service.js';

describe('terminalShell: the terminal panel is a real shell, not the claude TUI', () => {
  const claudeExe = path.join('C:', 'app', 'sdk-win32-x64', 'claude.exe');

  it('Windows: cmd.exe (no PowerShell execution policy between the user and npm), bundled claude reachable on PATH', () => {
    const s = terminalShell('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe', Path: 'C:\\Windows;C:\\nodejs' }, claudeExe);
    expect(s.file).toBe('C:\\Windows\\system32\\cmd.exe');
    // Windows spells it `Path`: the same key is extended, not a second PATH beside it
    expect(s.env.Path.split(';')).toEqual(['C:\\Windows', 'C:\\nodejs', path.dirname(claudeExe)]);
    expect(s.env.PATH).toBeUndefined();
  });

  it('macOS / Linux: the user login shell, falling back to zsh / bash', () => {
    expect(terminalShell('darwin', { SHELL: '/opt/homebrew/bin/fish', PATH: '/usr/bin' }, '/app/claude')).toMatchObject({ file: '/opt/homebrew/bin/fish', args: ['-l'] });
    expect(terminalShell('darwin', { PATH: '/usr/bin' }, '/app/claude').file).toBe('/bin/zsh');
    expect(terminalShell('linux', { PATH: '/usr/bin' }, '/app/claude').file).toBe('/bin/bash');
    expect(terminalShell('linux', { PATH: '/usr/bin' }, '/app/claude').env.PATH).toBe('/usr/bin:/app');
  });

  it("the user's own claude on PATH wins over the bundled one; an already-listed dir is not added twice", () => {
    expect(terminalShell('linux', { PATH: '/app:/usr/bin' }, '/app/claude').env.PATH).toBe('/app:/usr/bin');
    expect(terminalShell('linux', { PATH: '/usr/local/bin' }, '/app/claude').env.PATH!.split(':')[0]).toBe('/usr/local/bin');
  });

  it('no bundled claude: PATH untouched', () => {
    expect(terminalShell('linux', { PATH: '/usr/bin' }, null).env.PATH).toBe('/usr/bin');
  });
});
