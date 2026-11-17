import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineCommands, frontmatter, projectDirs, rememberEngineCommands, resetEngineCommands, scanSlashDisk, slashList } from './slash-disk.js';
import { normalizeCommands } from './slash-commands.js';

let root: string;
const write = (rel: string, body: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-slash-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('frontmatter', () => {
  it('reads plain, quoted, folded and block values; a BOM and CRLF are fine', () => {
    const md = '\uFEFF---\r\nname: brainstorming\r\ndescription: "You MUST use this \\"first\\""\r\nother: \'it\'\'s\'\r\nfolded: \'Execute generates commit messages. It analyzes\r\n  code changes and suggests one.\'\r\nblock: >-\r\n  line one\r\n  line two\r\nuser-invocable: false\r\n---\r\n# Title\r\nbody';
    const { fm, body } = frontmatter(md);
    expect(fm.name).toBe('brainstorming');
    expect(fm.description).toBe('You MUST use this "first"');
    expect(fm.other).toBe("it's");
    expect(fm.folded).toBe('Execute generates commit messages. It analyzes code changes and suggests one.');
    expect(fm.block).toBe('line one line two');
    expect(fm['user-invocable']).toBe('false');
    expect(body.trim()).toBe('# Title\r\nbody'.trim());
  });
  it('no front matter: the whole text is the body', () => {
    expect(frontmatter('# Hi\nthere')).toEqual({ fm: {}, body: '# Hi\nthere' });
  });
});

describe('projectDirs', () => {
  it('the folder and the ones above it, up to the home folder', () => {
    const home = path.join(root, 'home');
    expect(projectDirs(path.join(home, 'a', 'b'), home)).toEqual([path.join(home, 'a', 'b'), path.join(home, 'a')]);
    expect(projectDirs(home, home)).toEqual([]);
    expect(projectDirs('relative', home)).toEqual([]);
  });
});

describe('scanSlashDisk', () => {
  it('user / project skills and commands, enabled plugins, local plugin folders; user-invocable: false left out', async () => {
    const claudeDir = path.join(root, 'home', '.claude');
    const cwd = path.join(root, 'home', 'proj');
    write('home/.claude/skills/template/SKILL.md', '---\nname: template-skill\ndescription: A template\n---\n');
    write('home/.claude/skills/hidden/SKILL.md', '---\nname: hidden\ndescription: x\nuser-invocable: false\n---\n');
    write('home/.claude/skills/no-skill-md/README.md', 'not a skill');
    write('home/.claude/commands/review-pr.md', '---\ndescription: Review a PR\nargument-hint: <pr>\n---\nDo it');
    write('home/.claude/commands/frontend/component.md', '# Make a component\n');
    write('home/proj/.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\n---\n');
    const sp = path.join(root, 'plugins', 'superpowers');
    write('plugins/superpowers/.claude-plugin/plugin.json', JSON.stringify({ name: 'superpowers' }));
    write('plugins/superpowers/skills/brainstorming/SKILL.md', '---\nname: brainstorming\ndescription: Think first\n---\n');
    write('plugins/cctool/commands/install.md', '---\ndescription: Wire the statusline\n---\n');
    write('plugins/off/skills/nope/SKILL.md', '---\nname: nope\n---\n');
    write('plugins/unlisted/skills/unlisted-skill/SKILL.md', '---\nname: unlisted-skill\n---\n');
    write('plugins/other-proj/skills/elsewhere/SKILL.md', '---\nname: elsewhere\n---\n');
    write('home/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
      'superpowers@community': [{ scope: 'user', installPath: sp }, { scope: 'user', installPath: sp }],
      'cctool@cctool': [{ scope: 'user', installPath: path.join(root, 'plugins', 'cctool') }],
      'off@m': [{ scope: 'user', installPath: path.join(root, 'plugins', 'off') }],
      // installed but not in enabledPlugins: Claude Code does not load it
      'unlisted@m': [{ scope: 'user', installPath: path.join(root, 'plugins', 'unlisted') }],
      'scoped@m': [{ scope: 'project', projectPath: path.join(root, 'elsewhere'), installPath: path.join(root, 'plugins', 'other-proj') }],
    } }));
    write('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'off@m': false, 'superpowers@community': true, 'cctool@cctool': true } }));
    write('local/anthropic-skills/.claude-plugin/plugin.json', JSON.stringify({ name: 'anthropic-skills' }));
    write('local/anthropic-skills/skills/xlsx/SKILL.md', '---\nname: xlsx\ndescription: Spreadsheets\n---\n');

    const l = await scanSlashDisk({ claudeDir, cwd, home: path.join(root, 'home'), pluginDirs: [path.join(root, 'local', 'anthropic-skills')] });
    const by = (n: string) => l.find((c) => c.name === n);
    expect(by('template-skill')).toEqual({ name: 'template-skill', description: 'A template', argumentHint: '', aliases: ['template'], source: 'user', kind: 'skill' });
    expect(by('hidden')).toBeUndefined();
    expect(by('no-skill-md')).toBeUndefined();
    expect(by('review-pr')).toMatchObject({ source: 'user', kind: 'command', argumentHint: '<pr>', description: 'Review a PR' });
    expect(by('frontend:component')).toMatchObject({ source: 'user', kind: 'command', description: 'Make a component' });
    expect(by('deploy')).toMatchObject({ source: 'project', kind: 'skill' });
    expect(by('superpowers:brainstorming')).toMatchObject({ source: 'plugin', owner: 'superpowers', kind: 'skill', aliases: ['brainstorming'] });
    // no manifest: the id before @
    expect(by('cctool:install')).toMatchObject({ source: 'plugin', owner: 'cctool', kind: 'command' });
    expect(l.some((c) => c.name.includes('nope'))).toBe(false);
    expect(l.some((c) => c.name.includes('unlisted'))).toBe(false);
    expect(l.some((c) => c.name.includes('elsewhere'))).toBe(false);
    expect(by('anthropic-skills:xlsx')).toMatchObject({ source: 'plugin', owner: 'anthropic-skills', aliases: ['xlsx'] });
    expect(l.filter((c) => c.name === 'superpowers:brainstorming')).toHaveLength(1);
  });

  it('nothing there: an empty list, no throw', async () => {
    expect(await scanSlashDisk({ claudeDir: path.join(root, 'none'), cwd: path.join(root, 'none2'), home: root })).toEqual([]);
  });
});

describe('the engine commands kept for menus of conversations that are not running', () => {
  let was: string | undefined;
  beforeEach(() => { was = process.env.CLAUDE_WEB_DIR; process.env.CLAUDE_WEB_DIR = path.join(root, 'data'); resetEngineCommands(); });
  afterEach(() => { if (was === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = was; resetEngineCommands(); });

  it('remembered per engine (its own rows only), written to disk and read back after a restart', async () => {
    const list = normalizeCommands([
      { name: 'compact', description: 'Summarize', argumentHint: '' },
      { name: 'simplify', description: 'Review changed code (bundled)', argumentHint: '' },
      { name: 'mine', description: 'A skill (user)', argumentHint: '' },
    ]);
    rememberEngineCommands('ccb', list);
    rememberEngineCommands(undefined, list);
    expect(engineCommands('ccb').map((c) => c.name)).toEqual(['compact', 'simplify']);
    expect(engineCommands('claude')).toEqual([]);
    const file = path.join(root, 'data', 'runtime', 'slash-commands.json');
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    resetEngineCommands();
    expect(engineCommands('ccb').map((c) => c.name)).toEqual(['compact', 'simplify']);
  });

  it('slashList: the engine rows first, then the disk (a skill of the same name does not replace one)', async () => {
    rememberEngineCommands('claude', normalizeCommands([{ name: 'simplify', description: 'Review', builtin: true }]));
    const claudeDir = path.join(root, 'home', '.claude');
    write('home/.claude/skills/simplify/SKILL.md', '---\nname: simplify\ndescription: my own\n---\n');
    write('home/.claude/skills/other/SKILL.md', '---\nname: other\ndescription: x\n---\n');
    const l = await slashList({ claudeDir, kind: 'claude', cwd: 'not absolute' });
    expect(l.map((c) => [c.name, c.source])).toEqual([['simplify', 'builtin'], ['other', 'user']]);
  });
});
