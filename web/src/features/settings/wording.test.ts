import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BODY_INFO, SETTINGS_SECTIONS, VISIBLE_SECTIONS, allBodies, type BodyId } from './catalog';

/**
 * Two guards for the settings page (redesign phase 6, review I1 / M6):
 *  - the part table in SettingsModal.tsx (BODIES) draws each part with the component this table names — a swapped
 *    pair (hooks ⇄ subagents, both SimpleList) or a part pointing at the wrong component fails here;
 *  - what the non-advanced pages show by default does not use implementation words (spec §5.12, ui/terms.ts):
 *    档案 → 供应商, 引擎 → Agent / 运行内核, effort → 智能程度, 窗格 → 分屏, 停靠 → 右侧面板, ACP and source paths only in
 *    tooltips / the advanced pages. Tooltips (`title=`), `aria-label=`, class names and comments are not scanned.
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

type Tok = { t: 'code' | 'str'; v: string };

/** Split TS/TSX source into code and string-literal contents (template `${}` parts are code); comments dropped. */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let code = '';
  const flush = () => { if (code) out.push({ t: 'code', v: code }); code = ''; };
  const readTemplate = (i: number): number => {
    // i is just past the opening backtick
    let text = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out.push({ t: 'str', v: text }); return i + 1; }
      if (c === '$' && src[i + 1] === '{') {
        out.push({ t: 'str', v: text }); text = '';
        i = readCode(i + 2, true);
        continue;
      }
      text += c; i++;
    }
    out.push({ t: 'str', v: text });
    return i;
  };
  const readCode = (i: number, untilBrace: boolean): number => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (c === '\'' || c === '"') {
        flush();
        let k = i + 1; let text = '';
        while (k < src.length && src[k] !== c && src[k] !== '\n') { if (src[k] === '\\') { text += src.slice(k, k + 2); k += 2; continue; } text += src[k]; k++; }
        out.push({ t: 'str', v: text });
        i = k + 1;
        continue;
      }
      if (c === '`') { flush(); i = readTemplate(i + 1); continue; }
      if (untilBrace) {
        if (c === '{') depth++;
        if (c === '}') { if (depth === 0) { flush(); return i + 1; } depth--; }
      }
      code += c; i++;
    }
    flush();
    return i;
  };
  readCode(0, false);
  return out;
}

/** Index just past the string (quotes / template) or balanced `{…}` starting at `i`; strings inside are skipped whole. */
function skipValue(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === '\'') {
    let k = i + 1;
    while (k < src.length && src[k] !== c) k += src[k] === '\\' ? 2 : 1;
    return k + 1;
  }
  if (c === '`') {
    let k = i + 1;
    while (k < src.length && src[k] !== '`') {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '$' && src[k + 1] === '{') { k = skipValue(src, k + 1); continue; }
      k++;
    }
    return k + 1;
  }
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const d = src[k];
    if (d === '"' || d === '\'' || d === '`') { k = skipValue(src, k) - 1; continue; }
    if (d === '{') depth++;
    else if (d === '}' && --depth === 0) return k + 1;
  }
  return src.length;
}

/** Drop attributes nobody reads on screen by default: tooltips, accessible names, class names, data-*, keys. */
function dropHiddenAttrs(src: string): string {
  const ATTR = /(?<=[\s{(,])(?:title|aria-label|className|key|data-[\w-]+)=(?=["'{`])/g;
  let out = '';
  let last = 0;
  for (const m of src.matchAll(ATTR)) {
    if (m.index! < last) continue;
    out += src.slice(last, m.index);
    last = skipValue(src, m.index! + m[0].length);
  }
  return out + src.slice(last);
}

/** JSX text in a code token: after a tag's `>` (not an arrow) up to the next tag / expression. */
function jsxText(code: string): string[] {
  return [...code.matchAll(/(?<![=>])>([^<>{}]+)(?=[<{])/g)].map((m) => m[1]).filter((x) => x.trim());
}

const CJK_BANNED = ['档案', '引擎', '窗格', '停靠'];
const LATIN_BANNED: [string, RegExp][] = [
  ['effort', /effort/i],
  ['ultracode', /ultracode/i],
  ['ACP', /\bACP\b/],
  ['source path', /\b(server|web)\/src\b/],
];
/** Deliberate exceptions: [file, the literal, why]. */
const WHITELIST: [string, string, string][] = [
  [S('AgentsSection.tsx'), 'ACP', 'PROTO_LABEL: only rendered inside the agent name\'s title tooltip'],
];

function findings(file: string, src: string): string[] {
  const toks = tokenize(dropHiddenAttrs(src));
  const bad: string[] = [];
  const allowed = (v: string) => WHITELIST.some(([f, lit]) => f === file && v === lit);
  for (const tk of toks) {
    for (const w of CJK_BANNED) if (tk.v.includes(w) && !allowed(tk.v)) bad.push(`${w}: ${tk.v.trim().slice(0, 80)}`);
    const texts = tk.t === 'str' ? [tk.v] : jsxText(tk.v);
    for (const x of texts) for (const [w, re] of LATIN_BANNED) if (re.test(x) && !allowed(x)) bad.push(`${w}: ${x.trim().slice(0, 80)}`);
  }
  return bad;
}

/** Top-level declarations of a file, by name (`function X`, `export function X`, `const X`). */
function declarations(src: string): Map<string, string> {
  const parts = src.split(/^(?=(?:export )?(?:async )?(?:function|const|class) )/m);
  const out = new Map<string, string>();
  for (const p of parts) {
    const m = /^(?:export )?(?:async )?(?:function|const|class) (\w+)/.exec(p);
    if (m) out.set(m[1], p);
  }
  return out;
}

describe('non-advanced settings pages speak the interface vocabulary (ui/terms.ts)', () => {
  const advanced = new Set(SETTINGS_SECTIONS.filter((s) => s.advanced).flatMap((s) => [...(s.bodies ?? []), ...(s.more ?? [])]));
  const visibleBodies = [...new Set(allBodies().filter((b) => !b.section.advanced).map((b) => b.body))];

  it('the table covers the pages it claims to', () => {
    expect(visibleBodies.length).toBeGreaterThan(15);
    for (const b of visibleBodies) expect(advanced.has(b), b).toBe(false);
  });

  it('the components drawing those pages (and the page itself) use no implementation words', () => {
    const scanned: string[] = [];
    const bad: string[] = [];
    // files that hold one page's parts: scanned whole (their helpers draw the same page)
    const byFile = new Map<string, Set<string>>();
    for (const b of visibleBodies) {
      const { comp, file } = BODY_SOURCE[b];
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file)!.add(comp);
    }
    for (const [file, comps] of byFile) {
      const src = read(file);
      if (file === CONFIG) {
        // the dock's config panel shares this file: only the functions the settings pages draw, and their helpers
        const decl = declarations(src);
        for (const name of [...comps, 'Cmd', 'CacheOptions']) {
          const part = decl.get(name);
          expect(part, `${file}: ${name}`).toBeTruthy();
          scanned.push(`${file}#${name}`);
          bad.push(...findings(file, part!).map((x) => `${file}#${name} — ${x}`));
        }
      } else {
        scanned.push(file);
        bad.push(...findings(file, src).map((x) => `${file} — ${x}`));
      }
    }
    for (const file of [S('SettingsModal.tsx'), S('controls.tsx')]) {
      scanned.push(file);
      bad.push(...findings(file, read(file)).map((x) => `${file} — ${x}`));
    }
    expect(scanned.length).toBeGreaterThan(15);
    expect(bad).toEqual([]);
  });

  it('the settings map shows none of them on visible pages (labels, lead lines, hints, part names)', () => {
    const bad: string[] = [];
    const check = (where: string, text: string | undefined) => {
      if (!text) return;
      for (const w of CJK_BANNED) if (text.includes(w)) bad.push(`${where}: ${w}`);
      for (const [w, re] of LATIN_BANNED) if (re.test(text)) bad.push(`${where}: ${w}`);
    };
    for (const s of VISIBLE_SECTIONS) {
      check(`${s.id}.l`, s.l);
      check(`${s.id}.desc`, s.desc);
      for (const t of s.tabs ?? []) check(`${s.id}/${t.id}`, t.l);
      for (const e of s.entries ?? []) { check(e.id, e.label); check(`${e.id}.hint`, e.hint); check(`${e.id}.block`, e.block); check(`${e.id}.tag`, e.tag); }
    }
    for (const b of visibleBodies) check(`BODY_INFO.${b}`, BODY_INFO[b].l);
    expect(bad).toEqual([]);
  });

  it('the scanner itself catches words in text and strings, not in tooltips or comments', () => {
    const f = 'x.tsx';
    expect(findings(f, `const a = <div title="供应商档案">ok</div>; // 引擎`)).toEqual([]);
    expect(findings(f, `const a = <div aria-label={\`effort \${x}\`}>ok</div>;`)).toEqual([]);
    expect(findings(f, `const a = <div className="efforts">ok</div>;`)).toEqual([]);
    expect(findings(f, `const a = <div>供应商档案</div>;`)).toHaveLength(1);
    expect(findings(f, `const a = <div>high effort</div>;`)).toHaveLength(1);
    expect(findings(f, `const a = toast('见 server/src/x.ts');`)).toHaveLength(1);
    expect(findings(f, `const a = c.effort.map((e) => <span>{e}</span>);`)).toEqual([]);
    expect(findings(f, `const a = <b>{x ? 'ACP' : ''}</b>;`)).toHaveLength(1);
  });
});
