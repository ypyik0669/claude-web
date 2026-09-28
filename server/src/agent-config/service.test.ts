import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { AgentConfigService, MASK, maskSpec, validateSpec } from './service.js';
import type { AgentConfigKind } from './types.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__mocks__', 'fake-cli.mjs');

// every case spawns node a few times; under the full parallel suite that easily exceeds the 5 s default
describe('AgentConfigService (fake CLIs)', { timeout: 60_000 }, () => {
  let dir: string, home: string, log: string;
  let svc: AgentConfigService;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const envs = () => ({ CODEX_HOME: path.join(home, '.codex'), GEMINI_CLI_HOME: home, QWEN_HOME: path.join(home, '.qwen'), XDG_CONFIG_HOME: path.join(home, '.config'), CW_FAKE_CLI_LOG: log });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-agcfg-'));
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
    log = path.join(dir, 'calls.jsonl');
    svc = new AgentConfigService({
      agents: { list: async () => (['codex', 'gemini', 'qwen', 'opencode'] as const).map((k) => ({ kind: k, installed: true, version: '9.9.9', models: k === 'codex' ? ['gpt-5'] : [] })), launch: () => ({ command: 'unused', env: {} }) },
      backupDir: path.join(dir, 'config-backups'),
      cli: (kind: AgentConfigKind) => ({ command: process.execPath, prefix: [FAKE, `--as=${kind}`], env: envs() }),
      home: () => home,
      claudeDir: path.join(home, '.claude'),
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('codex: add stdio / http goes through `codex mcp add` with the documented argv shape', async () => {
    await svc.mcpAdd('codex', { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@x/fs', '--root', 'C:\\a b'], env: { TOKEN: 's3cret' } });
    await svc.mcpAdd('codex', { name: 'web', transport: 'http', url: 'https://mcp.example/mcp' });
    const c = calls().filter((x) => x.argv[1] === 'add');
    expect(c[0].argv).toEqual(['mcp', 'add', 'fs', '--env', 'TOKEN=s3cret', '--', 'npx', '-y', '@x/fs', '--root', 'C:\\a b']);
    expect(c[1].argv).toEqual(['mcp', 'add', 'web', '--url', 'https://mcp.example/mcp']);
    expect(c[0].CODEX_HOME).toBe(path.join(home, '.codex'));
    const st = await svc.get('codex');
    expect(st.mcp.map((m) => m.name).sort()).toEqual(['fs', 'web']);
    expect(st.mcp.find((m) => m.name === 'fs')?.env).toEqual({ TOKEN: MASK });
  });

  it('codex: headers are appended as http_headers after the CLI add; SSE is refused', async () => {
    await svc.mcpAdd('codex', { name: 'api', transport: 'http', url: 'https://x/mcp', headers: { 'X-Key': 'k1' } });
    const doc = parseToml(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')) as any;
    expect(doc.mcp_servers.api).toEqual({ url: 'https://x/mcp', http_headers: { 'X-Key': 'k1' } });
    await expect(svc.mcpAdd('codex', { name: 's', transport: 'sse', url: 'https://x/sse' })).rejects.toThrow(/sse/i);
  });

  it('codex: remove, and removing a missing name is an error', async () => {
    await svc.mcpAdd('codex', { name: 'fs', transport: 'stdio', command: 'npx' });
    await svc.mcpRemove('codex', 'fs');
    expect(calls().at(-1).argv).toEqual(['mcp', 'remove', 'fs']);
    await expect(svc.mcpRemove('codex', 'fs')).rejects.toThrow(/没有名为 fs/);
  });

  it('refuses a duplicate name unless overwrite is set', async () => {
    await svc.mcpAdd('gemini', { name: 'fs', transport: 'stdio', command: 'a' });
    await expect(svc.mcpAdd('gemini', { name: 'fs', transport: 'stdio', command: 'b' })).rejects.toThrow(/已存在/);
    await svc.mcpAdd('gemini', { name: 'fs', transport: 'stdio', command: 'b' }, true);
    expect((await svc.get('gemini')).mcp[0].command).toBe('b');
  });

  it('gemini / qwen: user-scope add with -e / -H / -t, list read from settings.json', async () => {
    await svc.mcpAdd('gemini', { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });
    await svc.mcpAdd('qwen', { name: 'web', transport: 'http', url: 'https://q/mcp', headers: { Authorization: 'Bearer t' } });
    const c = calls().filter((x) => x.argv[1] === 'add');
    expect(c[0].argv).toEqual(['mcp', 'add', '-s', 'user', '-t', 'stdio', '-e', 'A=1', 'fs', 'npx', '--', '-y', 'pkg']);
    expect(c[1].argv).toEqual(['mcp', 'add', '-s', 'user', '-t', 'http', '-H', 'Authorization: Bearer t', 'web', 'https://q/mcp']);
    const q = await svc.get('qwen');
    expect(q.mcp).toEqual([{ name: 'web', transport: 'http', url: 'https://q/mcp', headers: { Authorization: MASK }, env: undefined }]);
    await svc.mcpRemove('gemini', 'fs');
    expect(calls().at(-1).argv).toEqual(['mcp', 'remove', '-s', 'user', 'fs']);
  });

  it('gemini / qwen: args that look like CLI options and env values with `=` survive (CLI result verified and corrected)', async () => {
    const spec = { name: 'gh', transport: 'stdio' as const, command: 'docker', args: ['run', '-i', '--rm', '-e', 'X', '--timeout', '5', '--trust', 'img'], env: { TOKEN: 'abc==', B: 'x=y=z' } };
    for (const k of ['gemini', 'qwen'] as const) {
      await svc.mcpAdd(k, spec);
      const file = k === 'gemini' ? path.join(home, '.gemini', 'settings.json') : path.join(home, '.qwen', 'settings.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.gh;
      expect(saved.command).toBe('docker');
      expect(saved.args).toEqual(spec.args);
      expect(saved.env).toEqual(spec.env);
    }
    // http: url + headers verified too; a header value with `:` is kept whole
    await svc.mcpAdd('gemini', { name: 'web', transport: 'http', url: 'https://g/mcp?x=1', headers: { Authorization: 'Bearer a:b' } });
    const web = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')).mcpServers.web;
    expect(web).toEqual({ url: 'https://g/mcp?x=1', type: 'http', headers: { Authorization: 'Bearer a:b' } });
  });

  it('opencode: MCP is a structured edit of opencode.json, comments kept', async () => {
    const cfg = path.join(home, '.config', 'opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{\n  // mine\n  "theme": "tokyonight"\n}\n');
    await svc.mcpAdd('opencode', { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });
    await svc.mcpAdd('opencode', { name: 'web', transport: 'sse', url: 'https://o/sse' });
    const text = fs.readFileSync(cfg, 'utf8');
    expect(text).toContain('// mine');
    const st = await svc.get('opencode');
    expect(st.configPath).toBe(cfg);
    expect(st.mcp.map((m) => [m.name, m.transport, m.command ?? m.url])).toEqual([['fs', 'stdio', 'npx'], ['web', 'http', 'https://o/sse']]);
    await svc.mcpRemove('opencode', 'fs');
    expect((await svc.get('opencode')).mcp.map((m) => m.name)).toEqual(['web']);
    expect(calls()).toEqual([]); // never ran a CLI
  });

  it('settings: codex TOML key edited in place with a backup; enum values validated; unknown keys refused', async () => {
    const cfg = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '# hand written\nmodel = "gpt-5"\n\n[mcp_servers.x]\ncommand = "y"\n');
    const b = await svc.set('codex', 'approval_policy', 'never');
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# hand written\nmodel = "gpt-5"\napproval_policy = "never"\n\n[mcp_servers.x]\ncommand = "y"\n');
    expect(b?.path).toBe(cfg);
    await expect(svc.set('codex', 'approval_policy', 'sometimes')).rejects.toThrow(/只能是/);
    await expect(svc.set('codex', 'mcp_servers', 'x')).rejects.toThrow(/不支持/);
    const st = await svc.get('codex');
    expect(st.settings.find((f) => f.key === 'approval_policy')?.value).toBe('never');
    expect(st.settings.find((f) => f.key === 'model')?.suggestions).toEqual(['gpt-5']);
    await svc.restore(b!.id);
    expect(fs.readFileSync(cfg, 'utf8')).not.toContain('approval_policy');
  });

  it('settings: gemini nested key; clearing removes it', async () => {
    await svc.set('gemini', 'model.name', 'gemini-2.5-flash');
    const f = path.join(home, '.gemini', 'settings.json');
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).model.name).toBe('gemini-2.5-flash');
    await svc.set('gemini', 'model.name', null);
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).model).toEqual({});
  });

  it('sync: one Claude server to several agents, each reporting its own result', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://gh/mcp', headers: { Authorization: 'Bearer ghp' } }, local: { command: 'node', args: ['s.js'], env: { K: 'v' } } } }));
    const listed = await svc.claudeMcp();
    expect(listed.find((e) => e.spec.name === 'gh')?.spec.headers).toEqual({ Authorization: MASK });
    const res = await svc.sync({ claude: 'gh' }, ['codex', 'gemini', 'opencode']);
    expect(res.map((r) => [r.agent, r.ok])).toEqual([['codex', true], ['gemini', true], ['opencode', true]]);
    // the real secret reached the CLI, not the masked one
    expect(calls().find((x) => x.as === 'gemini').argv).toContain('Authorization: Bearer ghp');
    const again = await svc.sync({ claude: 'gh' }, ['codex']);
    expect(again[0].ok).toBe(false);
    expect(again[0].message).toMatch(/已存在/);
    const bad = await svc.sync({ claude: 'nope' }, ['codex']).catch((e) => e.message);
    expect(bad).toMatch(/没有名为 nope/);
  });

  it('createFile only creates files the adapter lists', async () => {
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd);
    const st = await svc.get('gemini', cwd);
    expect(st.files.map((f) => f.label)).toEqual(['全局说明 GEMINI.md', '项目说明 GEMINI.md', '配置 settings.json']);
    const p = await svc.createFile('gemini', path.join(cwd, 'GEMINI.md'), cwd);
    expect(fs.existsSync(p)).toBe(true);
    await expect(svc.createFile('gemini', path.join(cwd, 'evil.md'), cwd)).rejects.toThrow(/不是/);
  });

  it('a slow install probe falls back to a PATH lookup instead of blocking the panel', async () => {
    const slow = new AgentConfigService({
      agents: { list: () => new Promise(() => {}), launch: (k) => ({ command: k === 'codex' ? process.execPath : 'surely-not-on-path-xyz', env: {} }) },
      backupDir: path.join(dir, 'b3'),
      cli: (kind) => ({ command: process.execPath, prefix: [FAKE, `--as=${kind}`], env: envs() }),
      home: () => home,
      probeWaitMs: 50,
    });
    const all = await slow.list();
    expect(all.find((s) => s.kind === 'codex')?.installed).toBe(true);
    expect(all.find((s) => s.kind === 'gemini')?.installed).toBe(false);
  });

  it('duplicate check: an unreadable list is an error, not "no duplicate"', async () => {
    const cfg = path.join(home, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{ broken');
    await expect(svc.mcpAdd('gemini', { name: 'fs', transport: 'stdio', command: 'x' })).rejects.toThrow(/无法读取/);
    expect(calls()).toEqual([]);
  });

  it('set: key / value must be strings (null clears)', async () => {
    await expect(svc.set('gemini', 1 as any, 'x')).rejects.toThrow();
    await expect(svc.set('gemini', 'model.name', 5 as any)).rejects.toThrow(/字符串/);
    await expect(svc.set('gemini', 'model.name', { a: 1 } as any)).rejects.toThrow(/字符串/);
  });

  it('list masks url secrets and secret args', async () => {
    await svc.mcpAdd('gemini', { name: 'q', transport: 'http', url: 'https://h/mcp?apikey=s3cret' });
    await svc.mcpAdd('gemini', { name: 'r', transport: 'stdio', command: 'node', args: ['--token=s3cret'] });
    const st = await svc.get('gemini');
    expect(JSON.stringify(st.mcp)).not.toContain('s3cret');
  });

  it('a failing CLI surfaces its message', async () => {
    const failing = new AgentConfigService({
      agents: { list: async () => [], launch: () => ({ command: 'x', env: {} }) },
      backupDir: path.join(dir, 'b2'),
      cli: (kind) => ({ command: process.execPath, prefix: [FAKE, `--as=${kind}`], env: { ...envs(), CW_FAKE_FAIL: '1' } }),
      home: () => home,
    });
    await expect(failing.mcpAdd('codex', { name: 'a', transport: 'stdio', command: 'x' }, true)).rejects.toThrow(/fake failure/);
  });
});

describe('maskSpec', () => {
  it('masks URL userinfo / query values and secret-looking args', () => {
    const m = maskSpec({ name: 'a', transport: 'http', url: 'https://user:pw@h.example:8443/mcp?key=abc&mode=x#f' });
    expect(m.url).toBe(`https://${MASK}@h.example:8443/mcp?key=${MASK}&mode=${MASK}#f`);
    const s = maskSpec({ name: 'a', transport: 'stdio', command: 'x', args: ['--token=abc', '--api-key', 'k1', '--password=p', '--port', '3', '-y', '--auth-token=z', 'plain'] });
    expect(s.args).toEqual([`--token=${MASK}`, '--api-key', MASK, `--password=${MASK}`, '--port', '3', '-y', `--auth-token=${MASK}`, 'plain']);
    expect(maskSpec({ name: 'a', transport: 'http', url: 'https://h/mcp' }).url).toBe('https://h/mcp');
    // docker-style `-e NAME=value` pairs whose name looks secret
    const d = maskSpec({ name: 'a', transport: 'stdio', command: 'docker', args: ['run', '-e', 'GITHUB_TOKEN=ghp_x', '-e', 'OPENAI_API_KEY=sk', '-e', 'DB_PASSWORD=p', '-e', 'MODE=dev', 'img'] });
    expect(d.args).toEqual(['run', '-e', `GITHUB_TOKEN=${MASK}`, '-e', `OPENAI_API_KEY=${MASK}`, '-e', `DB_PASSWORD=${MASK}`, '-e', 'MODE=dev', 'img']);
  });
});

describe('validateSpec', () => {
  const T = ['stdio', 'http', 'sse'] as const;
  it('checks every field is a string (no objects / numbers from the wire)', () => {
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: 1 as any }, [...T])).toThrow();
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: 'x', args: [1 as any] }, [...T])).toThrow(/args/);
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: 'x', env: { A: 1 as any } }, [...T])).toThrow(/A/);
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: 'x', env: [] as any }, [...T])).toThrow(/env/);
    expect(() => validateSpec({ name: 'a', transport: 'http', url: 'https://x', headers: 'h' as any }, [...T])).toThrow(/header/);
    expect(() => validateSpec({ name: {} as any, transport: 'stdio', command: 'x' }, [...T])).toThrow(/名称/);
  });
  it('refuses masked values coming back in url / args', () => {
    expect(() => validateSpec({ name: 'a', transport: 'http', url: `https://h/mcp?key=${MASK}` }, [...T])).toThrow(/打码/);
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: 'x', args: [`--token=${MASK}`] }, [...T])).toThrow(/打码/);
  });
  it('rejects names / env / headers that could break argv or TOML', () => {
    expect(() => validateSpec({ name: 'a.b', transport: 'stdio', command: 'x' }, [...T])).toThrow(/名称/);
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: '' }, [...T])).toThrow(/命令/);
    expect(() => validateSpec({ name: 'a', transport: 'http', url: 'ftp://x' }, [...T])).toThrow(/URL/);
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: 'x', env: { 'A B': '1' } }, [...T])).toThrow(/环境变量名/);
    expect(() => validateSpec({ name: 'a', transport: 'http', url: 'https://x', headers: { A: 'x\ny' } }, [...T])).toThrow(/header/);
    expect(() => validateSpec({ name: 'a', transport: 'stdio', command: 'x', env: { A: MASK } }, [...T])).toThrow(/打码/);
    expect(() => validateSpec({ name: 'a', transport: 'sse', url: 'https://x' }, ['stdio', 'http'])).toThrow(/sse/);
  });
});
