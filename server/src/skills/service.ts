import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeDir } from '../sessions/service.js';
import { dataDir } from '../files/service.js';

const execFileAsync = promisify(execFile);

export interface SkillInstallSpec { source: string; scope: 'user' | 'project'; cwd?: string; name?: string }
export interface SkillInfo { name: string; path: string; scope: 'user' | 'project'; description: string; hasReadme: boolean }

/**
 * Skills are folders with a SKILL.md. Sources accepted by `install`:
 *   owner/repo                       (whole repo, or every folder with SKILL.md when the root has none)
 *   owner/repo/path/to/skill         (one subfolder)
 *   https://github.com/o/r[/tree/<branch>/<path>]  (same, branch-aware)
 *   local folder path
 */
export class SkillsService {
  dir(scope: 'user' | 'project', cwd?: string) {
    if (scope === 'project') {
      if (!cwd) throw new Error('项目级 skill 需要工作目录');
      return path.join(cwd, '.claude', 'skills');
    }
    return path.join(claudeDir, 'skills');
  }

  private async readMeta(p: string): Promise<{ description: string }> {
    try {
      const md = await fs.readFile(path.join(p, 'SKILL.md'), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(md);
      const desc = fm ? /description:\s*(.+)/.exec(fm[1])?.[1]?.trim() : undefined;
      return { description: desc ?? md.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 160) ?? '' };
    } catch {
      return { description: '' };
    }
  }

  async list(cwd?: string): Promise<SkillInfo[]> {
    const out: SkillInfo[] = [];
    for (const scope of ['user', 'project'] as const) {
      if (scope === 'project' && !cwd) continue;
      const d = this.dir(scope, cwd);
      const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.join(d, e.name);
        const has = await fs.stat(path.join(p, 'SKILL.md')).catch(() => null);
        if (!has) continue;
        const meta = await this.readMeta(p);
        out.push({ name: e.name, path: p, scope, description: meta.description, hasReadme: !!(await fs.stat(path.join(p, 'README.md')).catch(() => null)) });
      }
    }
    return out;
  }

  private parseSource(src: string): { kind: 'local'; path: string } | { kind: 'git'; url: string; branch?: string; sub?: string } {
    const s = src.trim();
    if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('.')) return { kind: 'local', path: path.resolve(s) };
    let m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/.exec(s);
    if (m) return { kind: 'git', url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}.git`, branch: m[3], sub: m[4] };
    if (/^(git@|https?:\/\/|ssh:\/\/)/.test(s)) return { kind: 'git', url: s };
    m = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(s);
    if (m) return { kind: 'git', url: `https://github.com/${m[1]}/${m[2]}.git`, sub: m[3] };
    throw new Error('无法识别的来源，支持 owner/repo、owner/repo/子目录、GitHub 链接或本地路径');
  }

  private async copySkill(from: string, targetDir: string, name: string): Promise<string> {
    const dest = path.join(targetDir, name);
    if (await fs.stat(dest).catch(() => null)) throw new Error(`已存在同名 skill：${name}`);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.cp(from, dest, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git${path.sep}`) && !p.endsWith(`${path.sep}.git`) });
    return dest;
  }

  /** Returns the installed skill folders. */
  async install(spec: SkillInstallSpec): Promise<string[]> {
    const target = this.dir(spec.scope, spec.cwd);
    const src = this.parseSource(spec.source);
    if (src.kind === 'local') {
      if (!(await fs.stat(path.join(src.path, 'SKILL.md')).catch(() => null))) throw new Error('目录里没有 SKILL.md');
      return [await this.copySkill(src.path, target, spec.name ?? path.basename(src.path))];
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-skill-'));
    try {
      const args = ['clone', '--depth', '1', ...(src.branch ? ['--branch', src.branch] : []), src.url, tmp];
      await execFileAsync('git', args, { timeout: 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      const root = src.sub ? path.join(tmp, src.sub) : tmp;
      if (await fs.stat(path.join(root, 'SKILL.md')).catch(() => null)) {
        const name = spec.name ?? (src.sub ? path.basename(src.sub) : path.basename(src.url, '.git'));
        return [await this.copySkill(root, target, name)];
      }
      // a repo of skills: install every first / second level folder that has SKILL.md
      const found: string[] = [];
      const scan = async (d: string, depth: number) => {
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
          const p = path.join(d, e.name);
          if (await fs.stat(path.join(p, 'SKILL.md')).catch(() => null)) found.push(p);
          else if (depth < 2) await scan(p, depth + 1);
        }
      };
      await scan(root, 0);
      if (!found.length) throw new Error('仓库里没有找到 SKILL.md');
      const out: string[] = [];
      for (const p of found) out.push(await this.copySkill(p, target, path.basename(p)).catch((e) => { throw e; }));
      return out;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async create(o: { name: string; scope: 'user' | 'project'; cwd?: string; description?: string }): Promise<string> {
    const name = o.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!name) throw new Error('名称无效');
    const dest = path.join(this.dir(o.scope, o.cwd), name);
    if (await fs.stat(dest).catch(() => null)) throw new Error('已存在同名 skill');
    await fs.mkdir(dest, { recursive: true });
    const md = `---\nname: ${name}\ndescription: ${o.description ?? '（一句话说明什么时候用这个 skill）'}\n---\n\n# ${name}\n\n## 何时使用\n\n- \n\n## 步骤\n\n1. \n`;
    await fs.writeFile(path.join(dest, 'SKILL.md'), md, 'utf8');
    return dest;
  }

  async remove(p: string) {
    const norm = path.resolve(p);
    const ok = [this.dir('user')].some((d) => norm.startsWith(path.resolve(d) + path.sep)) || /[\\/]\.claude[\\/]skills[\\/]/.test(norm);
    if (!ok) throw new Error('只允许删除 skills 目录下的文件夹');
    await fs.rm(norm, { recursive: true, force: true });
  }

  /** tar the user skills dir into ~/.claude-web/backups/skills-<ts>.tar (tar ships with Windows 10+, macOS, Linux). */
  async backup(): Promise<string> {
    const dir = path.join(dataDir(), 'backups');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `skills-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.tar`);
    await execFileAsync('tar', ['-cf', file, '-C', claudeDir, 'skills'], { windowsHide: true, timeout: 60_000 });
    return file;
  }

  async restore(file: string): Promise<void> {
    await execFileAsync('tar', ['-xf', file, '-C', claudeDir], { windowsHide: true, timeout: 60_000 });
  }
}
