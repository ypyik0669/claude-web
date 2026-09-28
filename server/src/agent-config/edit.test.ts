import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { appendTomlTable, parseConfig, setJsonPath, setTomlTopLevel } from './edit.js';

const CODEX = [
  '# my codex config',
  'model = "gpt-5" # inline note',
  '',
  '# approvals',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.foo]',
  'command = "npx"',
  'model = "not-top-level"',
  '',
].join('\n');

describe('setTomlTopLevel', () => {
  it('replaces only the named top-level line and keeps comments', () => {
    const out = setTomlTopLevel(CODEX, 'model', 'o3');
    expect(out).toBe(CODEX.replace('model = "gpt-5" # inline note', 'model = "o3" # inline note'));
    expect(parseToml(out).mcp_servers).toEqual({ foo: { command: 'npx', model: 'not-top-level' } });
  });

  it('inserts a missing key before the first table, after the existing top-level keys', () => {
    const out = setTomlTopLevel(CODEX, 'sandbox_mode', 'workspace-write');
    const lines = out.split('\n');
    expect(lines.indexOf('sandbox_mode = "workspace-write"')).toBe(lines.indexOf('approval_policy = "on-request"') + 1);
    expect(lines.indexOf('sandbox_mode = "workspace-write"')).toBeLessThan(lines.indexOf('[mcp_servers.foo]'));
    expect(parseToml(out).sandbox_mode).toBe('workspace-write');
    expect(out).toContain('# my codex config');
  });

  it('removes the key when value is undefined and leaves the table key alone', () => {
    const out = setTomlTopLevel(CODEX, 'model', undefined);
    const doc = parseToml(out) as any;
    expect(doc.model).toBeUndefined();
    expect(doc.mcp_servers.foo.model).toBe('not-top-level');
    expect(out).toContain('# approvals');
  });

  it('works on an empty file and on a file that is only tables', () => {
    expect(parseToml(setTomlTopLevel('', 'model', 'o3')).model).toBe('o3');
    const out = setTomlTopLevel('[a]\nx = 1\n', 'model', 'o3');
    expect(out.startsWith('model = "o3"\n')).toBe(true);
    expect((parseToml(out) as any).a.x).toBe(1);
  });

  it('escapes the value as a TOML string', () => {
    const out = setTomlTopLevel('', 'model', 'a"b\\c');
    expect(parseToml(out).model).toBe('a"b\\c');
  });

  it('touches only the target line: other lines keep their own line endings, BOM kept, no trailing newline added', () => {
    const src = '﻿# a\r\nmodel = "x"\napproval_policy = "never"\r\n\r\n[t]\r\nk = 1';
    expect(setTomlTopLevel(src, 'model', 'y')).toBe('﻿# a\r\nmodel = "y"\napproval_policy = "never"\r\n\r\n[t]\r\nk = 1');
    expect(setTomlTopLevel(src, 'model', undefined)).toBe('﻿# a\r\napproval_policy = "never"\r\n\r\n[t]\r\nk = 1');
    const ins = setTomlTopLevel(src, 'sandbox_mode', 'read-only');
    expect(ins).toBe('﻿# a\r\nmodel = "x"\napproval_policy = "never"\r\nsandbox_mode = "read-only"\r\n\r\n[t]\r\nk = 1');
    expect(setTomlTopLevel('model = "x"', 'sandbox_mode', 'a')).toBe('model = "x"\nsandbox_mode = "a"\n');
  });

  it('refuses a multi-line value it cannot rewrite in place', () => {
    expect(() => setTomlTopLevel('model = """\nx\n"""\n', 'model', 'y')).toThrow();
  });
});

describe('appendTomlTable', () => {
  it('appends a nested table with quoted keys and keeps the rest', () => {
    const out = appendTomlTable(CODEX, ['mcp_servers', 'my server', 'http_headers'], { 'X-Api-Key': 'k"1', Authorization: 'Bearer t' });
    expect(out.startsWith(CODEX)).toBe(true);
    const doc = parseToml(out) as any;
    expect(doc.mcp_servers['my server'].http_headers).toEqual({ 'X-Api-Key': 'k"1', Authorization: 'Bearer t' });
    expect(doc.mcp_servers.foo.command).toBe('npx');
  });
});

describe('setJsonPath', () => {
  const GEMINI = '{\n  // user comment\n  "theme": "Dracula",\n  "model": { "name": "gemini-2.5-pro" }\n}\n';
  it('changes one nested key and keeps comments / other keys', () => {
    const out = setJsonPath(GEMINI, ['model', 'name'], 'gemini-2.5-flash');
    expect(out).toContain('// user comment');
    expect(out).toContain('"theme": "Dracula"');
    expect((parseConfig(out, 'json') as any).model.name).toBe('gemini-2.5-flash');
  });
  it('creates missing parents, and deletes with undefined', () => {
    const a = setJsonPath('', ['general', 'defaultApprovalMode'], 'plan');
    expect((parseConfig(a, 'json') as any).general.defaultApprovalMode).toBe('plan');
    const b = setJsonPath(GEMINI, ['model', 'name'], undefined);
    expect((parseConfig(b, 'json') as any).model).toEqual({});
  });
  it('reads and keeps a UTF-8 BOM', () => {
    const src = '﻿{\n  "model": { "name": "a" }\n}\n';
    expect((parseConfig(src, 'json') as any).model.name).toBe('a');
    const out = setJsonPath(src, ['model', 'name'], 'b');
    expect(out.startsWith('﻿{')).toBe(true);
    expect((parseConfig(out, 'json') as any).model.name).toBe('b');
    expect((parseConfig('﻿model = "a"\n', 'toml') as any).model).toBe('a');
  });

  it('writes whole objects (OpenCode mcp entries)', () => {
    const out = setJsonPath('{ "$schema": "https://opencode.ai/config.json" }', ['mcp', 'web'], { type: 'remote', url: 'https://x', enabled: true });
    expect((parseConfig(out, 'json') as any).mcp.web.url).toBe('https://x');
  });
});

describe('parseConfig', () => {
  it('throws on broken TOML / JSON', () => {
    expect(() => parseConfig('model = ', 'toml')).toThrow();
    expect(() => parseConfig('{ "a": ', 'json')).toThrow();
    expect(parseConfig('', 'json')).toEqual({});
    expect(parseConfig('  ', 'toml')).toEqual({});
  });
});
