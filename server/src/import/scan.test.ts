import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpOf, parseDotenv, scanAll, type FoundMcp, type FoundProvider } from './scan.js';
import { ImportService, commandMissing, sameBase } from './service.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-imp-'));
  dirs.push(h);
  return h;
}
const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const W = (h: string) => ({ home: h, appData: path.join(h, 'AppData'), env: { OLLAMA_HOST: '127.0.0.1:9' } as NodeJS.ProcessEnv, platform: 'win32' as NodeJS.Platform });
const prov = (r: Awaited<ReturnType<typeof scanAll>>, from: string) => r.found.filter((f): f is FoundProvider => f.kind === 'provider' && f.from === from);
const mcp = (r: Awaited<ReturnType<typeof scanAll>>, from: string) => r.found.filter((f): f is FoundMcp => f.kind === 'mcp' && f.from === from);

describe('what other tools have, read from their own files', () => {
  it('Hermes: Anthropic keys in .env (other vendors left out), MCP servers', async () => {
    const h = home();
    put(path.join(h, '.hermes', 'config.yaml'), [
      'model:',
      '  default: anthropic/claude-opus-4.6',
      '  provider: openrouter',
      'custom_providers:',
      '  - name: Local vLLM',
      '    base_url: http://localhost:8000/v1',
      '    api_key: local-key',
      '    model: qwen3-32b',
      'mcp_servers:',
      '  github:',
      '    command: npx',
      '    args: ["-y", "@modelcontextprotocol/server-github"]',
      '    env: { GITHUB_TOKEN: ghp_x }',
      '  remote:',
      '    url: https://mcp.example.com/mcp',
      '    headers: { Authorization: Bearer t }',
    ].join('\n'));
    put(path.join(h, '.hermes', '.env'), 'OPENROUTER_API_KEY=sk-or-1\n# comment\nDEEPSEEK_API_KEY="sk-ds"\nANTHROPIC_API_KEY="sk-ant-1"\nUNRELATED=1\n');
    const r = await scanAll(W(h));
    const ps = prov(r, 'hermes');
    expect(ps.map((p) => [p.name, p.type, p.baseUrl, p.apiKey])).toEqual([
      ['Anthropic', 'anthropic', 'https://api.anthropic.com', 'sk-ant-1'],
    ]);
    expect(mcp(r, 'hermes').map((m) => [m.name, m.config])).toEqual([
      ['github', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_x' } }],
      ['remote', { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } }],
    ]);
  });

  it('cc-switch: Claude providers (other apps left out) and the MCP list, from a copy (the file stays as it was)', async () => {
    const h = home();
    const db = path.join(h, '.cc-switch', 'cc-switch.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT); CREATE TABLE mcp_servers (id TEXT, name TEXT, server_config TEXT)");
    const ins = d.prepare('INSERT INTO providers VALUES (?, ?, ?, ?)');
    ins.run('r1', 'claude', 'My relay', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'sk-relay', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' } }));
    ins.run('off', 'claude', 'Official', JSON.stringify({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' } }));
    ins.run('c1', 'codex', 'Codex relay', JSON.stringify({ auth: { OPENAI_API_KEY: 'sk-cx' }, config: 'model_provider = "rel"\nmodel = "gpt-5.5"\n[model_providers.rel]\nname = "rel"\nbase_url = "https://cx.example/v1"\nwire_api = "responses"\n' }));
    ins.run('g1', 'gemini', 'Gem', JSON.stringify({ env: { GEMINI_API_KEY: 'g-key', GEMINI_MODEL: 'gemini-3-pro' } }));
    ins.run('h1', 'hermes', 'Hermes relay', JSON.stringify({ base_url: 'https://h.example/v1', api_key: 'h-key', models: ['m1'] }));
    d.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?)').run('s1', 'pencil', JSON.stringify({ type: 'stdio', command: 'pencil.exe', args: ['--mcp'] }));
    d.close();
    const before = fs.readFileSync(db);
    const r = await scanAll(W(h));
    expect(prov(r, 'cc-switch').map((p) => [p.name, p.type, p.baseUrl, p.apiKey])).toEqual([
      ['My relay', 'anthropic', 'https://relay.example', 'sk-relay'],
    ]);
    expect(prov(r, 'cc-switch')[0].modelMap).toEqual({ haiku: 'claude-haiku-4-5', opus: 'claude-opus-5' });
    expect(mcp(r, 'cc-switch')).toEqual([{ kind: 'mcp', key: 'cc-switch:mcp:pencil', from: 'cc-switch', name: 'pencil', config: { command: 'pencil.exe', args: ['--mcp'] } }]);
    expect(fs.readFileSync(db).equals(before)).toBe(true);
  });

  it('the MCP files of Codex, OpenCode and the IDEs (their OpenAI-style providers left out); Mirasim / Cherry Studio named as unreadable', async () => {
    const h = home();
    put(path.join(h, '.codex', 'config.toml'), 'model_provider = "ds"\nmodel = "deepseek-chat"\n[model_providers.ds]\nname = "DS"\nbase_url = "https://api.deepseek.com/v1"\nenv_key = "DS_KEY"\n[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "fs-mcp"]\n');
    put(path.join(h, '.config', 'opencode', 'opencode.json'), JSON.stringify({ provider: { myrelay: { npm: '@ai-sdk/openai-compatible', name: 'My OC', options: { baseURL: 'https://oc.example/v1', apiKey: 'oc-key' }, models: { 'm-a': {}, 'm-b': {} } } }, mcp: { pencil: { type: 'local', command: ['pencil.exe', '--mcp'], enabled: true }, off: { type: 'local', command: ['x'], enabled: false } } }));
    put(path.join(h, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ deepseek: { type: 'api', key: 'oc-ds' }, myrelay: { type: 'api', key: 'ignored' } }));
    put(path.join(h, '.cursor', 'mcp.json'), '{ // a comment\n "mcpServers": { "linear": { "url": "https://mcp.linear.app/sse", "type": "sse" } } }');
    put(path.join(h, 'AppData', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } }));
    put(path.join(h, 'AppData', 'Zed', 'settings.json'), JSON.stringify({ context_servers: { ctx7: { command: { path: 'npx', args: ['-y', 'ctx7'], env: {} } } } }));
    fs.mkdirSync(path.join(h, 'AppData', '@mirasim', 'desktop'), { recursive: true });
    fs.mkdirSync(path.join(h, 'AppData', 'CherryStudio', 'IndexedDB'), { recursive: true });
    const r = await scanAll({ ...W(h), env: { DS_KEY: 'sk-env', OLLAMA_HOST: '127.0.0.1:9' } });
    expect(prov(r, 'codex')).toEqual([]);
    expect(mcp(r, 'codex').map((m) => m.config)).toEqual([{ command: 'npx', args: ['-y', 'fs-mcp'] }]);
    expect(prov(r, 'opencode')).toEqual([]);
    expect(mcp(r, 'opencode').map((m) => [m.name, m.config])).toEqual([['pencil', { command: 'pencil.exe', args: ['--mcp'] }]]);
    expect(mcp(r, 'cursor').map((m) => m.config)).toEqual([{ type: 'sse', url: 'https://mcp.linear.app/sse' }]);
    expect(mcp(r, 'claude-desktop').map((m) => m.name)).toEqual(['memory']);
    expect(mcp(r, 'zed').map((m) => m.config)).toEqual([{ command: 'npx', args: ['-y', 'ctx7'] }]);
    expect(r.unreadable).toEqual([{ from: 'mirasim', reason: 'encrypted' }, { from: 'cherry-studio', reason: 'browser-db' }]);
  });

  it('Pencil’s own copies, VS Code forks, Cline inside a fork, Antigravity, LM Studio', async () => {
    const h = home();
    const A = path.join(h, 'AppData');
    put(path.join(h, '.pencil', 'mcp', 'antigravity', 'out', 'mcp-server-windows-x64.exe'), '');
    put(path.join(h, '.pencil', 'mcp', 'desktop', 'out', 'mcp-server-windows-x64.exe'), '');
    put(path.join(h, '.pencil', 'mcp', 'desktop', 'out', 'mcp-server-darwin-arm64'), '');
    fs.mkdirSync(path.join(h, '.pencil', 'mcp', 'empty', 'out'), { recursive: true });
    put(path.join(A, 'Code - Insiders', 'User', 'mcp.json'), JSON.stringify({ servers: { ins: { command: 'a' } } }));
    put(path.join(A, 'VSCodium', 'User', 'settings.json'), JSON.stringify({ mcp: { servers: { cod: { command: 'b' } } } }));
    put(path.join(A, 'Trae CN', 'User', 'mcp.json'), JSON.stringify({ servers: { tr: { url: 'https://t/mcp' } } }));
    put(path.join(A, 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), JSON.stringify({ mcpServers: { cl: { command: 'c' } } }));
    put(path.join(h, '.gemini', 'antigravity', 'mcp_config.json'), JSON.stringify({ mcpServers: { ag: { command: 'd' } } }));
    put(path.join(h, '.lmstudio', 'mcp.json'), JSON.stringify({ mcpServers: { lm: { command: 'e' } } }));
    const r = await scanAll(W(h));
    const dir = (app: string) => path.join(h, '.pencil', 'mcp', app, 'out', 'mcp-server-windows-x64.exe');
    expect(mcp(r, 'pencil').map((m) => [m.name, m.config])).toEqual([
      ['pencil-antigravity', { command: dir('antigravity'), args: ['--app', 'antigravity'] }],
      ['pencil-desktop', { command: dir('desktop'), args: ['--app', 'desktop'] }],
    ]);
    expect(mcp(r, 'vscode-insiders').map((m) => m.name)).toEqual(['ins']);
    expect(mcp(r, 'vscodium').map((m) => m.name)).toEqual(['cod']);
    expect(mcp(r, 'trae').map((m) => m.config)).toEqual([{ type: 'http', url: 'https://t/mcp' }]);
    expect(mcp(r, 'cline').map((m) => m.name)).toEqual(['cl']);
    expect(mcp(r, 'antigravity').map((m) => m.name)).toEqual(['ag']);
    expect(mcp(r, 'lmstudio').map((m) => m.name)).toEqual(['lm']);
  });
  it('one Pencil copy is just “pencil” (an empty app folder does not count); the build for this CPU is taken', async () => {
    const h = home();
    const out = path.join(h, '.pencil', 'mcp', 'antigravity', 'out');
    put(path.join(out, 'mcp-server-windows-arm64.exe'), '');
    put(path.join(out, 'mcp-server-windows-x64.exe'), '');
    fs.mkdirSync(path.join(h, '.pencil', 'mcp', 'empty', 'out'), { recursive: true });
    const r = mcp(await scanAll({ ...W(h), arch: 'x64' }), 'pencil');
    expect(r.map((m) => [m.name, (m.config as any).command])).toEqual([['pencil', path.join(out, 'mcp-server-windows-x64.exe')]]);
    expect((mcp(await scanAll({ ...W(h), arch: 'arm64' }), 'pencil')[0].config as any).command).toBe(path.join(out, 'mcp-server-windows-arm64.exe'));
  });

  it('a full-path command that is gone is flagged; names on PATH and URLs are not', () => {
    const h = home();
    put(path.join(h, 'here.exe'), '');
    expect(commandMissing({ command: path.join(h, 'here.exe') })).toBe(false);
    expect(commandMissing({ command: path.join(h, 'old', 'gone.exe') })).toBe(true);
    expect(commandMissing({ command: 'npx' })).toBe(false);
    expect(commandMissing({ type: 'http', url: 'https://x/mcp' })).toBe(false);
  });

  it('pieces: .env lines, MCP shapes, base URLs', () => {
    expect(parseDotenv("A=1\nexport B='two words'\n# C=3\nD=x # note\nE=\n")).toEqual({ A: '1', B: 'two words', D: 'x' });
    expect(mcpOf({ serverUrl: 'https://x/mcp' })).toEqual({ type: 'http', url: 'https://x/mcp' });
    expect(mcpOf({ url: 'https://mcp.linear.app/sse' })).toEqual({ type: 'sse', url: 'https://mcp.linear.app/sse' });
    expect(mcpOf({ url: 'https://x/sse', type: 'streamable-http' })).toEqual({ type: 'http', url: 'https://x/sse' });
    expect(mcpOf({ command: 'a', disabled: true })).toBeNull();
    expect(mcpOf({ nothing: 1 })).toBeNull();
    expect(sameBase('https://API.x.com/v1/', 'https://api.x.com')).toBe(true);
    expect(sameBase('https://a.com/v1', 'https://b.com/v1')).toBe(false);
  });
});

describe('taking them in', () => {
  const found = (): Awaited<ReturnType<typeof scanAll>> => ({
    found: [
      { kind: 'provider', key: 'p1', from: 'hermes', name: 'Relay', type: 'anthropic', baseUrl: 'https://relay.example', apiKey: 'sk-1', models: ['m'], defaultModel: 'm' },
      { kind: 'provider', key: 'p2', from: 'hermes', name: 'Dup', type: 'anthropic', baseUrl: 'https://dup.example/v1', apiKey: 'sk-dup' },
      { kind: 'mcp', key: 'm1', from: 'cursor', name: 'linear', config: { type: 'sse', url: 'https://mcp.linear.app/sse' } },
      { kind: 'mcp', key: 'm2', from: 'cursor', name: 'github', config: { command: 'npx' } },
      { kind: 'mcp', key: 'm3', from: 'cursor', name: 'broken', config: { command: 'npx' } },
    ],
    unreadable: [],
    scanned: ['hermes', 'cursor'],
  });
  it('the window sees no key; what is here already is marked and skipped; picked items go in; a failure is reported', async () => {
    const added: any[] = [];
    const mcpAdded: [string, string][] = [];
    const svc = new ImportService({
      scan: async () => found(),
      providers: { hasSame: (_t, b, k) => b === 'https://dup.example' && k === 'sk-dup', upsert: async (p) => { added.push(p); return { ...p, id: `id-${added.length}` } as any; } },
      mcp: { names: async () => new Set(['github']), add: async (name, json) => { mcpAdded.push([name, json]); return name === 'broken' ? { code: 1, stderr: 'boom\nbad config' } : { code: 0 }; } },
    });
    // the duplicate's base URL differs by /v1 only: the same endpoint
    const svc2 = new ImportService({ scan: async () => found(), providers: { hasSame: (_t, b, k) => sameBase(b, 'https://dup.example') && k === 'sk-dup', upsert: async (p) => ({ ...p, id: 'x' }) as any }, mcp: { names: async () => new Set(['github']), add: async () => ({ code: 0 }) } });
    const s = await svc2.scan();
    expect(JSON.stringify(s)).not.toContain('sk-');
    expect(s.items.map((i) => [i.key, i.already])).toEqual([['p1', false], ['p2', true], ['m1', false], ['m2', true], ['m3', false]]);
    expect(s.items[0]).toMatchObject({ kind: 'provider', type: 'anthropic', hasKey: true, models: 1, detail: 'https://relay.example' });
    const r = await svc.run(['p1', 'm1', 'm2', 'm3', 'gone']);
    expect(added).toEqual([{ name: 'Relay', type: 'anthropic', baseUrl: 'https://relay.example', apiKey: 'sk-1', models: ['m'], defaultModel: 'm' }]);
    expect(mcpAdded.map(([n, j]) => [n, JSON.parse(j)])).toEqual([['linear', { type: 'sse', url: 'https://mcp.linear.app/sse' }], ['broken', { command: 'npx' }]]);
    expect(r).toEqual({ providers: ['id-1'], mcp: ['linear'], skipped: ['m2'], failed: [{ key: 'm3', error: 'bad config' }, { key: 'gone', error: 'gone' }] });
  });
});
