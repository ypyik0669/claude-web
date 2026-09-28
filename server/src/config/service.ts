import fs from 'node:fs/promises';
import path from 'node:path';
import { runClaudeCli } from '../claude-exe.js';
import { claudeDir } from '../sessions/service.js';
import { Memo } from '../runtime/memo.js';

/**
 * `claude mcp list` starts the engine AND every configured MCP server to health-check it (npx, uvx… each a
 * process tree). Settings → MCP asks twice on mount (installed list + health) and the config center once more:
 * one run per cwd shared while in flight, reused 15 s; adding / removing a server drops it.
 */
const mcpListMemo = new Memo<{ code: number; stdout: string; stderr: string }>(15_000);
export const mcpList = (cwd?: string, force = false) => mcpListMemo.get(cwd ?? '', () => runClaudeCli(['mcp', 'list'], { cwd, timeoutMs: 90_000 }), force);
export const forgetMcpList = () => mcpListMemo.clear();

function tryJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function readJson(p: string) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function readFrontmatter(file: string) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
    const fm: Record<string, string> = {};
    if (m) for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { fm, body: m ? txt.slice(m[0].length).trim() : txt };
  } catch {
    return { fm: {}, body: '' };
  }
}

function settingsPath(scope: 'user' | 'project' | 'local', cwd?: string) {
  if (scope === 'user') return path.join(claudeDir, 'settings.json');
  if (!cwd) throw new Error('cwd required for project/local settings');
  return path.join(cwd, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json');
}

export class ConfigService {
  async plugins() {
    const r = await runClaudeCli(['plugin', 'list', '--json']);
    const list = tryJson<any[]>(r.stdout, []);
    // enrich with manifest info
    for (const p of list) {
      const manifest = await readJson(path.join(p.installPath ?? '', '.claude-plugin', 'plugin.json'));
      if (manifest) p.manifest = { name: manifest.name, description: manifest.description, version: manifest.version, author: manifest.author };
      const dir = p.installPath ?? '';
      p.components = {
        skills: await countDir(path.join(dir, 'skills')),
        commands: await countDir(path.join(dir, 'commands')),
        agents: await countDir(path.join(dir, 'agents')),
        hooks: (await readJson(path.join(dir, 'hooks', 'hooks.json'))) ? 1 : 0,
        mcp: (await readJson(path.join(dir, '.mcp.json'))) ? 1 : 0,
      };
    }
    return { plugins: list, stderr: r.code ? r.stderr : undefined };
  }

  async pluginToggle(name: string, enable: boolean) {
    return runClaudeCli(['plugin', enable ? 'enable' : 'disable', name]);
  }
  async pluginInstall(spec: string) {
    return runClaudeCli(['plugin', 'install', spec], { timeoutMs: 180_000 });
  }
  async pluginUninstall(name: string) {
    return runClaudeCli(['plugin', 'uninstall', name]);
  }
  async marketplaces() {
    const r = await runClaudeCli(['plugin', 'marketplace', 'list', '--json']);
    const known = await readJson(path.join(claudeDir, 'plugins', 'known_marketplaces.json'));
    return { marketplaces: tryJson<any>(r.stdout, known ?? {}), stderr: r.code ? r.stderr : undefined };
  }
  async marketplaceAdd(source: string) {
    return runClaudeCli(['plugin', 'marketplace', 'add', source], { timeoutMs: 180_000 });
  }

  async mcp(cwd?: string) {
    const r = await mcpList(cwd);
    // "name: target - ✔ Connected" lines
    const servers = r.stdout
      .split(/\r?\n/)
      .map((l) => /^(.+?): (.+?) - (.+)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => ({ name: m![1], target: m![2], status: m![3].replace(/^[^\w]+/, '') }));
    const userCfg = (await readJson(path.join(claudeDir, '.claude.json'))) ?? (await readJson(path.join(path.dirname(claudeDir), '.claude.json')));
    const projectCfg = cwd ? await readJson(path.join(cwd, '.mcp.json')) : null;
    return { servers, userServers: userCfg?.mcpServers ?? {}, projectServers: projectCfg?.mcpServers ?? {}, stderr: r.code ? r.stderr : undefined };
  }
  async mcpAdd(name: string, json: string, scope: string, cwd?: string) {
    return runClaudeCli(['mcp', 'add-json', name, json, '-s', scope], { cwd }).finally(forgetMcpList);
  }
  async mcpRemove(name: string, scope?: string, cwd?: string) {
    return runClaudeCli(['mcp', 'remove', name, ...(scope ? ['-s', scope] : [])], { cwd }).finally(forgetMcpList);
  }

  /**
   * `claude auth status` is a whole engine start (a second or two of node). The welcome page asks on every mount,
   * the onboarding and the settings overview too: one run shared while in flight and kept 30 s;
   * `force` (onboarding → 重新检查, after a /login) asks again.
   */
  private authMemo = new Memo<any>(30_000);
  auth(force = false): Promise<any> {
    return this.authMemo.get('auth', async () => {
      const r = await runClaudeCli(['auth', 'status']);
      return { ...tryJson<any>(r.stdout, { raw: r.stdout }), stderr: r.code ? r.stderr : undefined };
    }, force);
  }

  async doctor() {
    const r = await runClaudeCli(['doctor'], { timeoutMs: 120_000 });
    return { output: r.stdout + (r.stderr ? '\n' + r.stderr : ''), code: r.code };
  }

  async settingsRead(scope: 'user' | 'project' | 'local', cwd?: string) {
    const p = settingsPath(scope, cwd);
    const txt = await fs.readFile(p, 'utf8').catch(() => '');
    return { path: p, text: txt };
  }
  async settingsWrite(scope: 'user' | 'project' | 'local', json: string, cwd?: string) {
    JSON.parse(json); // validate
    const p = settingsPath(scope, cwd);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, json, 'utf8');
    return { path: p };
  }

  async skills() {
    const out: any[] = [];
    const scan = async (root: string, source: string) => {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = path.join(root, e.name, 'SKILL.md');
        const { fm } = await readFrontmatter(file);
        if (Object.keys(fm).length || (await fs.stat(file).catch(() => null))) out.push({ name: fm.name || e.name, description: fm.description ?? '', source, path: file, userInvocable: fm['user-invocable'] !== 'false' });
      }
    };
    await scan(path.join(claudeDir, 'skills'), 'user');
    await scan(path.join(claudeDir, 'commands'), 'user-commands');
    // plugin skills
    const installed = await readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    for (const [id, arr] of Object.entries<any[]>(installed?.plugins ?? {})) {
      for (const inst of arr) await scan(path.join(inst.installPath, 'skills'), id);
    }
    return out;
  }

  async agents() {
    const out: any[] = [];
    const scan = async (root: string, source: string) => {
      const entries = await fs.readdir(root).catch(() => []);
      for (const f of entries) {
        if (!f.endsWith('.md')) continue;
        const { fm, body } = await readFrontmatter(path.join(root, f));
        out.push({ name: fm.name || f.replace(/\.md$/, ''), description: fm.description ?? '', model: fm.model, tools: fm.tools, source, path: path.join(root, f), prompt: body.slice(0, 2000) });
      }
    };
    await scan(path.join(claudeDir, 'agents'), 'user');
    const installed = await readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    for (const [id, arr] of Object.entries<any[]>(installed?.plugins ?? {})) {
      for (const inst of arr) await scan(path.join(inst.installPath, 'agents'), id);
    }
    return out;
  }

  async hooks() {
    const user = await readJson(path.join(claudeDir, 'settings.json'));
    const out: any[] = [];
    const push = (source: string, hooks: any) => {
      for (const [event, matchers] of Object.entries<any>(hooks ?? {})) {
        for (const m of matchers as any[]) out.push({ source, event, matcher: m.matcher, hooks: m.hooks });
      }
    };
    push('user settings', user?.hooks);
    const installed = await readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    for (const [id, arr] of Object.entries<any[]>(installed?.plugins ?? {})) {
      for (const inst of arr) push(id, (await readJson(path.join(inst.installPath, 'hooks', 'hooks.json')))?.hooks);
    }
    return out;
  }

  async overview() {
    const [auth, plugins, skills, agents, hooks] = await Promise.all([this.auth(), this.plugins(), this.skills(), this.agents(), this.hooks()]);
    return { auth, pluginCount: plugins.plugins.length, skillCount: skills.length, agentCount: agents.length, hookCount: hooks.length, claudeDir };
  }
}

async function countDir(p: string) {
  try {
    return (await fs.readdir(p)).length;
  } catch {
    return 0;
  }
}
