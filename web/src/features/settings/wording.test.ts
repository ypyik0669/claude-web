import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '@catalog';
import { BODY_INFO, SETTINGS_SECTIONS, VISIBLE_SECTIONS, allBodies, type BodyId } from './catalog';

/**
 * Two guards for the settings page (redesign phase 6, review I1 / M6):
 *  - the part table in SettingsModal.tsx (BODIES) draws each part with the component this table names — a swapped
 *    pair (hooks ⇄ subagents, both SimpleList) or a part pointing at the wrong component fails here;
 *  - what the non-advanced pages show by default does not use implementation words (spec §5.12, ui/terms.ts):
 *    档案 → 供应商, 引擎 → Agent / 运行内核, effort → 智能程度, 窗格 → 分屏, 停靠 → 右侧面板, ACP and source paths only in
 *    tooltips / the advanced pages. The text comes from the syntax tree: string literals, template text, JSX text;
 *    tooltips (`title=`), `aria-label=`, class names, keys, data-*, comments and import paths are not text.
 */
const SRC = path.resolve(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

const CONFIG = 'features/panels/ConfigPanel.tsx';
const S = (f: string) => `features/settings/${f}`;
/** Which component draws each part, where it is exported from, and the props that tell same-component parts apart. */
const BODY_SOURCE: Record<BodyId, { comp: string; file: string; props?: string }> = {
  account: { comp: 'AccountSection', file: S('AccountSection.tsx') },
  engine: { comp: 'Overview', file: CONFIG, props: 'part="engine"' },
  models: { comp: 'ModelsSection', file: S('ModelsSection.tsx') },
  providers: { comp: 'ProviderProfiles', file: CONFIG },
  proxy: { comp: 'ProxySection', file: S('ProxySection.tsx') },
  gateway: { comp: 'GatewaySection', file: S('GatewaySection.tsx') },
  mcp: { comp: 'Mcp', file: CONFIG },
  mcpCatalog: { comp: 'McpCatalog', file: S('McpCatalog.tsx') },
  mcpJson: { comp: 'McpAddJson', file: CONFIG },
  plugins: { comp: 'Plugins', file: CONFIG },
  skills: { comp: 'SkillsSection', file: S('SkillsSection.tsx') },
  skillsBackup: { comp: 'SkillsBackup', file: S('SkillsSection.tsx') },
  agents: { comp: 'AgentsSection', file: S('AgentsSection.tsx') },
  subagents: { comp: 'SimpleList', file: CONFIG, props: 'kind="config.agents"' },
  memory: { comp: 'MemorySettings', file: 'features/memory/MemorySettings.tsx' },
  remote: { comp: 'RemoteSection', file: S('RemoteSection.tsx') },
  peers: { comp: 'PeersSection', file: S('PeersSection.tsx') },
  hosts: { comp: 'HostsSection', file: S('RemoteSection.tsx') },
  im: { comp: 'ImSection', file: S('ImSection.tsx') },
  library: { comp: 'LibrarySection', file: S('LibrarySection.tsx') },
  secrets: { comp: 'SecretsSection', file: S('SecretsSection.tsx') },
  hooks: { comp: 'SimpleList', file: CONFIG, props: 'kind="config.hooks"' },
  env: { comp: 'EnvEditor', file: S('EnvEditor.tsx'), props: 'bare' },
  tools: { comp: 'ToolsSection', file: S('ToolsSection.tsx') },
  diagnostics: { comp: 'DiagnosticsSection', file: S('DiagnosticsSection.tsx') },
  update: { comp: 'UpdateSection', file: S('UpdateSection.tsx') },
  raw: { comp: 'Settings', file: CONFIG },
};

const MODAL = read(S('SettingsModal.tsx'));

/** `BODIES` in SettingsModal.tsx: part → the JSX it renders. */
function bodiesTable(): Record<string, string> {
  const start = MODAL.indexOf('const BODIES: Record<BodyId');
  const end = MODAL.indexOf('\n};', start);
  expect(start, 'BODIES table in SettingsModal.tsx').toBeGreaterThan(0);
  const out: Record<string, string> = {};
  for (const line of MODAL.slice(start, end).split('\n')) {
    const m = /^ {2}(\w+): \(\) => (<.*),$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Where SettingsModal.tsx imports a name from, as a path under web/src. */
function importedFrom(name: string): string | undefined {
  for (const m of MODAL.matchAll(/import \{([^}]*)\} from '([^']+)';/g)) {
    const names = m[1].split(',').map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!);
    if (!names.includes(name)) continue;
    const spec = m[2];
    const rel = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('./') ? `features/settings/${spec.slice(2)}` : spec;
    return `${rel}.tsx`;
  }
  return undefined;
}

describe('settings parts are drawn by the right component (BODIES)', () => {
  it('every part is in BODIES exactly once, with the component and props of BODY_SOURCE', () => {
    const table = bodiesTable();
    expect(Object.keys(table).sort()).toEqual(Object.keys(BODY_INFO).sort());
    for (const [b, src] of Object.entries(BODY_SOURCE)) {
      const jsx = table[b];
      expect(jsx, b).toBeTruthy();
      expect(new RegExp(`^<${src.comp}\\b`).test(jsx), `${b}: ${jsx}`).toBe(true);
      if (src.props) expect(jsx, `${b}: ${src.props}`).toContain(src.props);
      expect(importedFrom(src.comp), `${b}: ${src.comp} imported from ${src.file}`).toBe(src.file);
      expect(read(src.file), `${src.file} exports ${src.comp}`).toMatch(new RegExp(`export function ${src.comp}\\(`));
    }
    // same component, different parts: the props keep them apart
    expect(table.subagents).not.toBe(table.hooks);
  });
});

// ---------------------------------------------------------------------------------------------------------------

type N = { type: string; [k: string]: any };

/** Attributes nobody reads on screen by default: tooltips, accessible names, class names, keys, data-*. */
const HIDDEN_ATTR = /^(title|aria-label|className|key|data-[\w-]+)$/;
const attrName = (n: N): string => (n.name?.type === 'JSXNamespacedName' ? `${n.name.namespace.name}:${n.name.name.name}` : n.name?.name ?? '');

/**
 * Every piece of text a file can put on screen, from its syntax tree (vite's parser, TSX aware): string literals,
 * template text and JSX text — also JSX text after an expression (`{n} effort`) and text with `//` in it (a URL).
 * Not scanned: comments, import / re-export paths, string literal *types*, and the HIDDEN_ATTR attributes.
 */
function textsOf(file: string, src: string, opts: { tooltips?: boolean; skipKeys?: Set<string> } = {}): string[] {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    const n = x as N;
    switch (n.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'TSLiteralType':
        return;
      case 'ExportNamedDeclaration':
        if (n.source) return;
        break;
      case 'JSXAttribute': {
        const a = attrName(n);
        // tooltips and accessible names are read too, when asked (`tooltips`); class names, keys, data-* never are
        if (HIDDEN_ATTR.test(a) && !(opts.tooltips && (a === 'title' || a === 'aria-label'))) return;
        break;
      }
      case 'Property':
        // an object key that is never shown (search keywords, a table of where the old UI's entries went)
        if (opts.skipKeys && (n.key?.name ?? n.key?.value) && opts.skipKeys.has(n.key.name ?? n.key.value)) return;
        break;
      case 'JSXText':
        if (String(n.value).trim()) out.push(n.value);
        return;
      case 'Literal':
        if (typeof n.value === 'string') out.push(n.value);
        return;
      case 'TemplateElement':
        out.push(n.value?.cooked ?? n.value?.raw ?? '');
        return;
    }
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'start' && k !== 'end') walk(n[k]);
  };
  walk(parse(file, src));
  return out;
}
const parse = (file: string, src: string) => parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }) as unknown as N;

const CJK_BANNED = ['档案', '引擎', '窗格', '停靠'];
const LATIN_BANNED: [string, RegExp][] = [
  ['effort', /effort/i],
  ['ultracode', /ultracode/i],
  ['ACP', /\bACP\b/],
  ['source path', /\b(server|web)\/src\b/],
];
/** Deliberate exceptions: [file, the whole literal, why]. */
const WHITELIST: [string, string, string][] = [
  [S('AgentsSection.tsx'), 'ACP', 'PROTO_LABEL: only rendered inside the agent name\'s title tooltip'],
];

function badWords(text: string): string[] {
  return [...CJK_BANNED.filter((w) => text.includes(w)), ...LATIN_BANNED.filter(([, re]) => re.test(text)).map(([w]) => w)];
}
/** A protocol request / event kind (`session.setEffort`, `goals.create`): an id the server reads, not text. */
const PROTOCOL_KIND = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/;
function findings(file: string, src: string): string[] {
  return textsOf(file, src)
    .filter((t) => !PROTOCOL_KIND.test(t))
    .filter((t) => !WHITELIST.some(([f, lit]) => f === file && t === lit))
    .flatMap((t) => badWords(t).map((w) => `${w}: ${t.trim().slice(0, 80)}`));
}

/** A file cut down to some of its top-level declarations (functions, components, constants), by name. */
function onlyDeclarations(file: string, src: string, names: string[]): string {
  const found = new Map<string, string>();
  for (const st of parse(file, src).body as N[]) {
    const d = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    const ids = d.type === 'FunctionDeclaration' ? [d.id?.name] : d.type === 'VariableDeclaration' ? d.declarations.map((v: N) => v.id?.name) : [];
    for (const id of ids) if (id) found.set(id, src.slice(st.start, st.end));
  }
  const missing = names.filter((n) => !found.has(n));
  expect(missing, `${file}: declarations`).toEqual([]);
  return names.map((n) => found.get(n)).join('\n');
}

/** Helpers the settings pages use from files that also hold other things. */
const CONFIG_HELPERS = ['Cmd', 'CacheOptions', 'PROVIDER_TYPES'];
/** Modules the visible pages call that put text on screen themselves (toasts, dialogs, sub-panels). */
const PAGE_HELPERS = ['features/models/data.ts', S('AgentConfigPanel.tsx'), S('agent-config-form.ts')];

describe('non-advanced settings pages speak the interface vocabulary (ui/terms.ts)', () => {
  const advanced = new Set(SETTINGS_SECTIONS.filter((s) => s.advanced).flatMap((s) => [...(s.bodies ?? []), ...(s.more ?? [])]));
  const visibleBodies = [...new Set(allBodies().filter((b) => !b.section.advanced).map((b) => b.body))];

  it('the table covers the pages it claims to', () => {
    expect(visibleBodies.length).toBeGreaterThan(15);
    for (const b of visibleBodies) expect(advanced.has(b), b).toBe(false);
  });

  it('the components drawing those pages, their helpers and the page itself use no implementation words', () => {
    const scanned: string[] = [];
    const bad: string[] = [];
    const scan = (file: string, src: string, label = file) => { scanned.push(label); bad.push(...findings(file, src).map((x) => `${label} — ${x}`)); };
    const byFile = new Map<string, Set<string>>();
    for (const b of visibleBodies) {
      const { comp, file } = BODY_SOURCE[b];
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file)!.add(comp);
    }
    for (const [file, comps] of byFile) {
      // the dock's config panel shares ConfigPanel.tsx: only what the settings pages draw, and its helpers
      if (file === CONFIG) scan(file, onlyDeclarations(file, read(file), [...comps, ...CONFIG_HELPERS]), `${file}#${[...comps, ...CONFIG_HELPERS].join(',')}`);
      else scan(file, read(file)); // files that hold one page's parts: whole (their helpers draw the same page)
    }
    for (const file of [S('SettingsModal.tsx'), S('controls.tsx'), ...PAGE_HELPERS]) scan(file, read(file));
    expect(scanned.length).toBeGreaterThanOrEqual(18);
    expect(bad).toEqual([]);
  });

  it('the settings map and the model catalog notes shown on the 模型与智能程度 page use none of them either', () => {
    const bad: string[] = [];
    const check = (where: string, text: string | undefined) => { if (text) for (const w of badWords(text)) bad.push(`${where}: ${w}`); };
    for (const s of VISIBLE_SECTIONS) {
      check(`${s.id}.l`, s.l);
      check(`${s.id}.desc`, s.desc);
      for (const t of s.tabs ?? []) check(`${s.id}/${t.id}`, t.l);
      for (const e of s.entries ?? []) { check(e.id, e.label); check(`${e.id}.hint`, e.hint); check(`${e.id}.block`, e.block); check(`${e.id}.tag`, e.tag); }
    }
    for (const b of visibleBodies) check(`BODY_INFO.${b}`, BODY_INFO[b].l);
    // ModelsSection shows each agent's `note` under its 智能程度 row (按供应商 view)
    for (const [agent, c] of Object.entries(CATALOG)) check(`CATALOG.${agent}.note`, c?.note);
    expect(Object.values(CATALOG).some((c) => c?.note)).toBe(true);
    expect(bad).toEqual([]);
  });

  it('the scanner skips protocol request kinds (`session.setEffort`) — they are ids, not text', () => {
    expect(findings('x.ts', `ws.request({ kind: 'session.setEffort', effort });`)).toEqual([]);
    // …but only a whole literal that is nothing else: text around one is still text
    expect(findings('x.ts', `toast('session.setEffort 档案');`).length).toBeGreaterThan(0);
  });

  it('the scanner catches words in text and strings, not in tooltips, class names or comments', () => {
    const f = 'x.tsx';
    expect(findings(f, `const a = <div title="供应商档案">ok</div>; // 引擎`)).toEqual([]);
    expect(findings(f, `const a = <div aria-label={\`effort \${x}\`}>ok</div>; /* 档案 */`)).toEqual([]);
    expect(findings(f, `const a = <div className="efforts">ok</div>;`)).toEqual([]);
    expect(findings(f, `type K = 'effort' | 'acp'; import x from './effort';`)).toEqual([]);
    expect(findings(f, `const a = c.effort.map((e) => <span>{e}</span>);`)).toEqual([]);
    expect(findings(f, `const a = <div>供应商档案</div>;`)).toHaveLength(1);
    expect(findings(f, `const a = <div>high effort</div>;`)).toHaveLength(1);
    expect(findings(f, `const a = toast('见 server/src/x.ts');`)).toHaveLength(1);
    expect(findings(f, `const a = <b>{x ? 'ACP' : ''}</b>;`)).toHaveLength(1);
    // the review's blind spots: text after an expression, `//` inside text, template text, a quote in a regex
    expect(findings(f, `const a = <div>{n} high effort levels</div>;`)).toHaveLength(1);
    expect(findings(f, `const a = <div>{x}effort{y}</div>;`)).toHaveLength(1);
    expect(findings(f, `const a = <div>见 https://x.y/z 的档案</div>;`)).toHaveLength(1);
    expect(findings(f, `const a = toast(\`\${n} 个档案已刷新\`);`)).toHaveLength(1);
    expect(findings(f, `const r = /'/; const a = <b>档案</b>;`)).toHaveLength(1);
    expect(findings('y.ts', `st.toast('还没有可刷新的供应商档案');`)).toHaveLength(1);
  });
});

/**
 * Redesign phase 7: the same gate for the default screens outside the settings page — the start page (its notice,
 * 入门清单, lists), the first-run wizard, the automation page and what it shows (定时任务 / 目标 / 编排), 任务, the
 * composer and the model menu (their toasts and routes), and the server's own message for a provider an agent cannot
 * use (`profileFitError`, shown as a toast when a model is picked).
 */
describe('default screens outside settings speak the interface vocabulary (phase 7)', () => {
  const FILES = [
    'features/workbench/Welcome.tsx',
    'features/home/model.ts',
    'features/home/Checklist.tsx',
    'features/home/EngineNotice.tsx',
    'features/home/HomeLists.tsx',
    'features/onboarding/Onboarding.tsx',
    'features/onboarding/steps.ts',
    'features/automation/AutomationPage.tsx',
    'features/automation/page.ts',
    'features/automation/SchedulesView.tsx',
    'features/automation/schedule-text.ts',
    'features/home/checklist-sync.ts',
    'features/goals/GoalsPanel.tsx',
    // 编排 on the automation page: the list, a run, the editor, the leftover worktrees (review 7 M12)
    'features/orchestra/OrchestraPanel.tsx',
    'features/orchestra/RunView.tsx',
    'features/orchestra/WorkflowEditor.tsx',
    'features/orchestra/Orphans.tsx',
    'features/panels/TasksPanel.tsx',
    // toasts of the default screens: 引用到输入框, 用量与账本 (a deleted provider), Ctrl+D, the browser tab
    'features/sidebar/session-actions.tsx',
    'features/panels/ledger-stats.ts',
    'features/workbench/commands.ts',
    'features/workbench/tiles/BrowserTile.tsx',
    'features/workbench/ConnectionBanner.tsx',
    'features/composer/Composer.tsx',
    'features/models/ModelMenu.tsx',
    'features/models/route.ts',
    'ui/EmptyState.tsx',
    'ui/terms.ts',
  ];
  /** Parts of bigger files: the session header's ··· (its views, 终端 / 任务 on a phone). */
  const PARTS: [string, string[]][] = [['features/workbench/tiles/ChatTile.tsx', ['HeaderMenu']]];
  const SERVER_CATALOG = '../../server/src/models/catalog.ts';

  it('none of them uses an implementation word where it can be seen', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      // terms.ts: only what is shown by default (the tooltips' raw values — effortTitle, ULTRACODE.title — are fine)
      const src = f === 'ui/terms.ts' ? onlyDeclarations(f, read(f), ['EMPTY', 'DISCONNECTED', 'LOGIN_IN_TERMINAL', 'PERMISSION_MODES', 'EFFORT_LABEL', 'EFFORT_DESC', 'SIMPLIFIED_NOTICE']) : read(f);
      bad.push(...findings(f, src).map((x) => `${f} — ${x}`));
    }
    for (const [f, names] of PARTS) {
      const src = onlyDeclarations(f, read(f), names);
      expect(src.length, `${f}: ${names.join(', ')} found`).toBeGreaterThan(200);
      bad.push(...findings(f, src).map((x) => `${f}#${names.join('+')} — ${x}`));
    }
    bad.push(...findings(SERVER_CATALOG, onlyDeclarations(SERVER_CATALOG, read(SERVER_CATALOG), ['profileFitError'])).map((x) => `${SERVER_CATALOG}#profileFitError — ${x}`));
    expect(bad).toEqual([]);
  });

  it('the model menu searches 「模型或供应商」, and a picked provider with no default model says 供应商', () => {
    expect(textsOf('features/models/ModelMenu.tsx', read('features/models/ModelMenu.tsx'))).toContain('搜索模型或供应商…');
    expect(read('features/models/route.ts')).toMatch(/供应商「\$\{/);
  });
});

/**
 * Polish P6: the whole web app, not a list of files — every text a file can put on screen. Two rules:
 *  - 对话, never 会话, anywhere a user reads it: text, placeholders, and here also tooltips and accessible names
 *    (`会话亲和` is the networking term session affinity, in two tooltips of the cache options);
 *  - no implementation word (档案 / 引擎 / 窗格 / 停靠 / effort / ultracode / ACP / source paths) on the default
 *    screens: tooltips are fine, and so are the advanced settings pages (诊断 / 更新 / CLI 工具 / 环境变量 /
 *    settings.json / Hooks) and the files that only hold ids.
 * Never shown, so not scanned: search `keywords` (they keep the old words so a search still finds them), the
 * tables of where the old sidebar / composer entries went (`old` / `was`), comments, imports, protocol kinds.
 */
describe('the whole interface: 对话 not 会话, no implementation words by default (polish P6)', () => {
  const walkDir = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!e.name.startsWith('__')) walkDir(rel, out); } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
    return out;
  };
  const ALL = fs.readdirSync(SRC, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkDir(e.name) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [e.name] : []));
  const SKIP_KEYS = new Set(['keywords', 'old', 'was']);
  /** The advanced settings pages' own files, and the ids-only table. */
  const NOT_DEFAULT = [S('DiagnosticsSection.tsx'), S('UpdateSection.tsx'), S('ToolsSection.tsx'), S('EnvEditor.tsx'), 'features/composer/ids.ts'];
  /** Deliberate exceptions: [file, a piece of the literal, why]. */
  const ALLOWED: [string, string, string][] = [
    [S('AgentsSection.tsx'), 'ACP', 'PROTO_LABEL: only rendered inside the agent name\'s title tooltip'],
    ['ui/terms.ts', '（effort', 'effortTitle(): the raw value, in the effort control\'s tooltip'],
    ['ui/terms.ts', '（ultracode）', 'ULTRACODE.title: the 深度编排 switch\'s tooltip'],
  ];

  it('reads every source file of the app', () => {
    expect(ALL.length).toBeGreaterThan(150);
    expect(ALL).toContain('features/chat/ChatView.tsx');
  });

  it('says 对话 everywhere a user reads it (text, placeholders, tooltips, accessible names)', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      for (const t of textsOf(f, read(f), { tooltips: true, skipKeys: SKIP_KEYS })) {
        if (/会话/.test(t.replace(/会话亲和/g, ''))) bad.push(`${f} — ${t.trim().slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('uses no implementation word on the default screens (tooltips and the advanced pages aside)', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      if (NOT_DEFAULT.includes(f)) continue;
      for (const t of textsOf(f, read(f), { skipKeys: SKIP_KEYS })) {
        if (PROTOCOL_KIND.test(t) || ALLOWED.some(([af, piece]) => af === f && t.includes(piece))) continue;
        for (const w of badWords(t)) bad.push(`${f} — ${w}: ${t.trim().slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // final review M2: git's word stays next to ours — 「独立副本（worktree）」 (spec §5.12) — or out of the default
  // screens (tooltips, the advanced pages, ids, code); a bare 「worktree」 in text is the implementation word
  /** Values, not text (the scanner cannot tell): [file, the whole literal, why]. A new one fails until listed here. */
  const WORKTREE_CODE: [string, string, string][] = [
    ['features/composer/branch-guard.ts', '/.claude/worktrees/', 'a path matched against folders'],
    ['features/orchestra/Graph.tsx', 'worktree', "compared: n.workspace === 'worktree'"],
    ['features/orchestra/WorkflowEditor.tsx', 'worktree', 'the <option> value and its type'],
    ['features/sidebar/entries.ts', 'worktree', 'an entry id (PROJECT_MENU)'],
    ['features/sidebar/entries.ts', 'project:worktree', 'an entry id (LEGACY)'],
    ['features/workbench/GitView.tsx', 'worktrees', 'the sub-tab state of the Git view'],
  ];
  it('says worktree only as 「独立副本（worktree）」 on the default screens', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      if (NOT_DEFAULT.includes(f)) continue;
      for (const t of textsOf(f, read(f), { skipKeys: SKIP_KEYS })) {
        if (PROTOCOL_KIND.test(t) || WORKTREE_CODE.some(([cf, lit]) => cf === f && t === lit)) continue;
        if (/worktree/i.test(t.replace(/独立副本（worktree）/g, ''))) bad.push(`${f} — ${t.trim().slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the scanner reads tooltips only when asked, and skips keywords / old-entry tables', () => {
    const f = 'x.tsx';
    const src = `const a = <div title="会话" aria-label="会话" className="会话">ok</div>; const k = { keywords: '会话', old: '会话', label: '对话' };`;
    expect(textsOf(f, src, { skipKeys: SKIP_KEYS }).filter((t) => t.includes('会话'))).toEqual([]);
    expect(textsOf(f, src, { tooltips: true, skipKeys: SKIP_KEYS }).filter((t) => t.includes('会话'))).toEqual(['会话', '会话']);
    expect(textsOf(f, src, { tooltips: true })).toContain('对话');
  });
});
