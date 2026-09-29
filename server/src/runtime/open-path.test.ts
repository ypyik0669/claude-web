import { describe, expect, it } from 'vitest';
import { openCommands } from './open-path.js';

describe('openCommands', () => {
  it('the file manager: explorer / open / xdg-open', () => {
    expect(openCommands('/p', 'explorer', 'win32')).toEqual([['explorer', ['/p']]]);
    expect(openCommands('/p', 'explorer', 'darwin')).toEqual([['open', ['/p']]]);
    expect(openCommands('/p', 'explorer', 'linux')).toEqual([['xdg-open', ['/p']]]);
    expect(openCommands('/p', undefined, 'darwin')).toEqual([['open', ['/p']]]);
  });

  it("macOS: the editor's shell command, then its app bundle through `open -a` (the `code` command is optional there)", () => {
    expect(openCommands('/Users/me/proj', 'code', 'darwin')).toEqual([['code', ['/Users/me/proj']], ['open', ['-a', 'Visual Studio Code', '/Users/me/proj']]]);
    expect(openCommands('/Users/me/proj', 'cursor', 'darwin')).toEqual([['cursor', ['/Users/me/proj']], ['open', ['-a', 'Cursor', '/Users/me/proj']]]);
  });

  it('elsewhere only the shell command', () => {
    expect(openCommands('/home/me/proj', 'code', 'linux')).toEqual([['code', ['/home/me/proj']]]);
  });
});
