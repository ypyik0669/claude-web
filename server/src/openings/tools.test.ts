import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpeningService } from './service.js';
import { openingPluginDir, openingTool, resetOpeningPlugin, skillBody, trialText } from './tools.js';
import { OPENING_TOOLS } from './tool-defs.js';
import { EXAMPLE_HTML, SKILL_MD } from './skill-text.js';
import { OPENING_FREE_TOOLS } from '../web/launcher.js';

const root = path.resolve(__dirname, '../../..');
let base: string;
let svc: OpeningService;
let pack: unknown;
const deps = () => ({ svc, getPack: () => pack, setPack: async (v: string) => { pack = v; } });
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-opening-tools-'));
  const builtin = path.join(base, 'builtin', 'claude-web-chan');
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, 'opening.json'), JSON.stringify({ name: 'Claude Web 娘', kind: 'video', intro: 'intro.mp4' }));
  fs.writeFileSync(path.join(builtin, 'intro.mp4'), 'v');
  svc = new OpeningService({ builtinDir: path.join(base, 'builtin'), userDir: path.join(base, 'user') });
  pack = undefined;
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('opening-pack skill · its text and the tools', () => {
  it('the skill text and the example match their sources (run scripts/gen-skill-text.mjs after editing them)', () => {
    const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
    expect(SKILL_MD).toBe(read('server/src/openings/opening-pack.md'));
    expect(EXAMPLE_HTML).toBe(read('server/src/openings/example/index.html'));
    expect(SKILL_MD).toMatch(/^---\nname: opening-pack\n/);
    expect(skillBody()).not.toMatch(/^---/);
  });
  it('the example is a pack the app takes: one page, says when it is done, nothing from the network', () => {
    expect(EXAMPLE_HTML).toContain('cwOpening');
    expect(EXAMPLE_HTML).toMatch(/\.done\(\)/);
    expect(EXAMPLE_HTML).not.toMatch(/https?:\/\/|fetch\(|XMLHttpRequest|WebSocket|<link|src=/);
    expect(Buffer.byteLength(EXAMPLE_HTML)).toBeLessThan(16 * 1024);
  });
  it('the tools that only touch the opening library are not asked about; apply and delete are', () => {
    for (const f of OPENING_FREE_TOOLS) expect(OPENING_TOOLS.some((t) => `mcp__web__${t.name}` === f)).toBe(true);
    expect(OPENING_FREE_TOOLS).not.toContain('mcp__web__opening_apply');
    expect(OPENING_FREE_TOOLS).not.toContain('mcp__web__opening_delete');
  });
  it('opening_guide: the skill and the example', async () => {
    const t = textOf(await openingTool(deps(), 'opening_guide', {}));
    expect(t).toContain('cwOpening.done()');
    expect(t).toContain('萤火');
    expect(t).toContain(EXAMPLE_HTML.slice(0, 200));
  });
  it('opening_draft without a window: kept, not tried (it says so)', async () => {
    const r = await openingTool(deps(), 'opening_draft', { name: 'Fireflies', html: EXAMPLE_HTML, author: 'me', license: 'MIT' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/fireflies/);
    expect(textOf(r)).toMatch(/没有试放/);
    expect(svc.drafts().map((p) => p.id)).toEqual(['fireflies']);
  });
  it('opening_draft with a window: what the trial run saw, and its picture', async () => {
    const host = {};
    svc.setHost(host, true, (q) => setTimeout(() => svc.trialResult(host, q.id, { end: 'done', at: 3.4, errors: [], avgMs: 3.1, maxMs: 12, frames: 200, png: 'data:image/png;base64,iVBORw0KGgo=' }), 1));
    const r = await openingTool(deps(), 'opening_draft', { name: 'Fireflies', html: EXAMPLE_HTML });
    expect(textOf(r)).toMatch(/第 3\.4 秒调用了 cwOpening\.done\(\)/);
    expect(textOf(r)).toMatch(/3\.1 ms/);
    expect(r.content.find((c) => c.type === 'image')).toMatchObject({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });
  it('the trial run in words: cut at the limit (点火 instead), skipped, errors, no picture', () => {
    const p = { id: 'x', name: 'x', builtin: false, kind: 'web' as const, entry: 'index.html', maxSeconds: 9 };
    expect(trialText(p, { end: 'cut', at: 9, errors: [] })).toMatch(/9 秒还没调用 cwOpening\.done\(\)，被收掉了/);
    expect(trialText(p, { end: 'skip', at: 1.5, errors: ['boom'] })).toMatch(/第 1\.5 秒点了一下[\s\S]*boom/);
    expect(trialText(p, { errors: [] })).toMatch(/没有截到图/);
  });
  it('opening_save → listed; opening_apply sets the opening (a saved pack or a built-in one); opening_delete takes it away and the setting falls back', async () => {
    await openingTool(deps(), 'opening_draft', { name: 'Fireflies', html: EXAMPLE_HTML });
    expect((await openingTool(deps(), 'opening_apply', { id: 'fireflies' })).isError).toBe(true);
    expect(textOf(await openingTool(deps(), 'opening_save', { id: 'fireflies' }))).toMatch(/已保存/);
    expect(textOf(await openingTool(deps(), 'opening_apply', { id: 'fireflies' }))).toMatch(/已设成开场/);
    expect(pack).toBe('fireflies');
    const list = textOf(await openingTool(deps(), 'opening_list', {}));
    expect(list).toMatch(/fireflies · Fireflies · 网页 · 已保存 · 正在用/);
    expect(list).toMatch(/claude-web-chan · Claude Web 娘 · 视频 · 内置/);
    expect(list).toMatch(/stars · 星图 · 内置/);
    expect(textOf(await openingTool(deps(), 'opening_get', { id: 'fireflies' }))).toContain('cwOpening');
    expect((await openingTool(deps(), 'opening_delete', { id: 'claude-web-chan' })).isError).toBe(true);
    expect((await openingTool(deps(), 'opening_delete', { id: 'stars' })).isError).toBe(true);
    expect(textOf(await openingTool(deps(), 'opening_delete', { id: 'fireflies' }))).toMatch(/已删除/);
    expect(pack).toBe('claude-web-chan');
    await openingTool(deps(), 'opening_apply', { id: 'cafe' });
    expect(pack).toBe('cafe');
  });
  it('the opening plugin: the skill written once, as a local plugin', () => {
    resetOpeningPlugin();
    const d = openingPluginDir(path.join(base, 'plugins'))!;
    expect(fs.readFileSync(path.join(d, 'skills', 'opening-pack', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(JSON.parse(fs.readFileSync(path.join(d, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('opening');
    resetOpeningPlugin();
  });
});
