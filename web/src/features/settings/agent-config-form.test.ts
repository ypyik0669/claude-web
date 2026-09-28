import { describe, expect, it } from 'vitest';
import { catalogSpec, describeSpec, formFromCatalog, formToSpec, parsePairs, settingToCommit, splitArgs } from './agent-config-form';

describe('agent config MCP form', () => {
  it('splitArgs keeps quoted groups and glued tokens', () => {
    expect(splitArgs('npx -y @x/fs "C:\\My Docs" --root="a b" \'s q\'')).toEqual(['npx', '-y', '@x/fs', 'C:\\My Docs', '--root=a b', 's q']);
    expect(splitArgs('   ')).toEqual([]);
  });

  it('parsePairs reads env and header lines, rejects junk', () => {
    expect(parsePairs('A=1\n# c\n\nB = x=y', '=')).toEqual({ A: '1', B: 'x=y' });
    expect(parsePairs('Authorization: Bearer a:b', ':')).toEqual({ Authorization: 'Bearer a:b' });
    expect(() => parsePairs('nope', '=')).toThrow(/KEY=value/);
  });

  it('formToSpec builds stdio / http specs and validates required fields', () => {
    expect(formToSpec({ name: ' fs ', transport: 'stdio', command: 'npx -y pkg', url: '', env: 'K=v', headers: 'ignored' })).toEqual({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
    expect(formToSpec({ name: 'w', transport: 'http', command: '', url: 'https://x', env: '', headers: 'X-A: 1' })).toEqual({ name: 'w', transport: 'http', url: 'https://x', headers: { 'X-A': '1' } });
    expect(() => formToSpec({ name: '', transport: 'stdio', command: 'x', url: '', env: '', headers: '' })).toThrow(/名称/);
    expect(() => formToSpec({ name: 'a', transport: 'sse', command: '', url: '', env: '', headers: '' })).toThrow(/URL/);
  });

  it('settingToCommit: Enter then blur sends once; unchanged / already-sent values are skipped; blank clears', () => {
    expect(settingToCommit(' b ', 'a', undefined)).toBe('b');
    expect(settingToCommit('b', 'a', 'b')).toBeUndefined(); // blur right after Enter
    expect(settingToCommit('a', 'a', undefined)).toBeUndefined();
    expect(settingToCommit('', 'a', undefined)).toBeNull();
    expect(settingToCommit('  ', undefined, undefined)).toBeUndefined();
    expect(settingToCommit('', 'a', null)).toBeUndefined();
    expect(settingToCommit('a', 'b', 'b')).toBe('a'); // changed back after a save
  });

  it('catalogSpec turns a catalog entry (+ filled env) into a spec; required env must be filled', () => {
    const item = { id: 'brave-search', json: { type: 'stdio', command: 'npx', args: ['-y', '@x/brave'] }, env: ['BRAVE_API_KEY'] };
    expect(() => catalogSpec(item, 'BRAVE_API_KEY=')).toThrow(/BRAVE_API_KEY/);
    expect(catalogSpec(item, 'BRAVE_API_KEY=k')).toEqual({ name: 'brave-search', transport: 'stdio', command: 'npx', args: ['-y', '@x/brave'], env: { BRAVE_API_KEY: 'k' } });
    expect(catalogSpec({ id: 'exa', json: { type: 'http', url: 'https://mcp.exa.ai/mcp' } }, '')).toEqual({ name: 'exa', transport: 'http', url: 'https://mcp.exa.ai/mcp' });
  });

  it('formFromCatalog round-trips through formToSpec', () => {
    const f = formFromCatalog('pg', { type: 'stdio', command: 'npx', args: ['-y', 'server-postgres', 'postgresql://h/db'] }, ['PGPASS']);
    expect(f.env).toBe('PGPASS=');
    expect(formToSpec({ ...f, env: 'PGPASS=x' })).toEqual({ name: 'pg', transport: 'stdio', command: 'npx', args: ['-y', 'server-postgres', 'postgresql://h/db'], env: { PGPASS: 'x' } });
    expect(formFromCatalog('lin', { type: 'sse', url: 'https://l/sse' }).transport).toBe('sse');
    expect(describeSpec({ name: 'a', transport: 'stdio', command: 'node', args: ['a b.js'] })).toBe('node "a b.js"');
  });
});
