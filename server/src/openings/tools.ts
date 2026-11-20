// The `opening_*` tools of the `web` MCP server (tool-defs.ts), and the `opening` plugin that carries the opening-pack
// skill (written next to the ascii one: themes/tools.ts). Never throws: a failure is a result the model reads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../files/service.js';
import type { OpeningInfo, OpeningTrialResult } from '../protocol.js';
import { tr } from '../i18n/index.js';
import { EXAMPLE_HTML, SKILL_MD } from './skill-text.js';
import type { OpeningService } from './service.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };
export interface OpeningToolResult { content: Content[]; isError?: boolean }
const text = (t: string, isError = false): OpeningToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export interface OpeningToolDeps {
  svc: OpeningService;
  /** the `ui.opening.pack` setting, and setting it (opening_apply) */
  getPack: () => unknown;
  setPack: (v: string) => Promise<void>;
}

/** The openings without a folder, by id (what opening_apply / opening_list know besides the packs). */
const DRAWN: Record<string, string> = { ignite: '点火', stars: '星图', ascii: '字符雨', cafe: '网吧开门' };

export function skillBody(): string {
  return SKILL_MD.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body.replace(/```/g, '`\u200b``')}\n\`\`\``;
const jsonOf = (p: OpeningInfo) => JSON.stringify({ name: p.name, ...(p.author ? { author: p.author } : {}), ...(p.license ? { license: p.license } : {}), kind: p.kind, ...(p.kind === 'web' ? { entry: p.entry } : { intro: p.intro, loop: p.loop }), maxSeconds: p.maxSeconds }, null, 2);

/** What the trial run saw, in words for the model (and the picture beside it). */
export function trialText(p: OpeningInfo, r: OpeningTrialResult): string {
  const at = r.at !== undefined ? r.at.toFixed(1) : '?';
  const end = r.end === 'done'
    ? tr('它在第 {at} 秒调用了 cwOpening.done()，然后标志接着亮了。', { at })
    : r.end === 'cut'
      ? tr('{max} 秒还没调用 cwOpening.done()，被收掉了，用户看到的换成了点火。要在 {max} 秒内调用它。', { max: p.maxSeconds })
      : r.end === 'skip'
        ? tr('用户在第 {at} 秒点了一下，跳过了。', { at })
        : tr('没有放完（窗口被藏起来了，或者页面没起来）。');
  const errs = r.errors.length ? tr('\n\n页面里出的错：\n- {errors}', { errors: r.errors.join('\n- ') }) : tr('\n\n页面里没有出错。');
  const speed = r.avgMs !== undefined && r.frames ? tr('\n\n每帧平均 {avg} ms，最慢 {max} ms（{n} 帧）。启动时 CPU 很忙，平均最好在 8 ms 以下。', { avg: r.avgMs.toFixed(1), max: (r.maxMs ?? r.avgMs).toFixed(1), n: r.frames }) : '';
  const pic = r.png ? tr('\n\n下面是它最大的那个 canvas 在 1、3、6、9 秒和结束时的样子（放完之前的几张）。') : tr('\n\n没有截到图：页面没有 canvas，或者 canvas 是空的。');
  return `${end}${errs}${speed}${pic}${r.note ? `\n\n${r.note}` : ''}`;
}

export async function openingTool(d: OpeningToolDeps, name: string, args: Record<string, unknown>): Promise<OpeningToolResult> {
  const idArg = () => (typeof args.id === 'string' ? args.id.trim().toLowerCase() : '');
  try {
    switch (name) {
      case 'opening_guide':
        return text(`${skillBody()}\n\n# 范例：萤火（完整约 3.4 秒，简短约 1.9 秒）\n\n${fence('html', EXAMPLE_HTML)}`);
      case 'opening_draft': {
        const p = d.svc.saveDraft({ id: args.id, name: args.name, author: args.author, license: args.license, maxSeconds: args.maxSeconds, html: args.html });
        const head = tr('草稿已存：{name}（id：{id}，最多放 {max} 秒）。改这一版时带上这个 id。', { name: p.name, id: p.id, max: p.maxSeconds });
        const r = await d.svc.trial(p, String(args.html));
        if (!r) return text(tr('{head}\n\n没有试放：现在没有打开着的 Claude Web 窗口来放它，所以没有截图，也没测速度。用户打开窗口后再提交一次就能看到。', { head }));
        const content: Content[] = [{ type: 'text', text: `${head}\n\n${tr('刚在用户的窗口里放了一遍：{result}', { result: trialText(p, r) })}\n\n${tr('满意了用 opening_save 存起来，再用 opening_apply 设成开场。')}` }];
        if (r.png) content.push({ type: 'image', data: r.png.replace(/^data:image\/png;base64,/, ''), mimeType: 'image/png' });
        return { content };
      }
      case 'opening_get': {
        const id = idArg();
        const g = d.svc.draft(id, true);
        if (g) return text([`## ${id}（${g.info.draft ? tr('草稿') : tr('已保存')}）`, '### opening.json', fence('json', jsonOf(g.info)), '### index.html', fence('html', g.html)].join('\n\n'));
        const p = d.svc.get(id);
        if (p) return text(tr('「{id}」是视频做的开场（{name}），没有网页可以改：做一个新的网页包吧。', { id, name: p.name }));
        return text(tr('没有这个开场：{id}（opening_list 看有哪些）', { id }), true);
      }
      case 'opening_save': {
        const p = await d.svc.publishDraft(idArg());
        return text(tr('已保存：{name}（{id}）。它出现在 设置 › 外观 › 开场和背景 的卡片里了；要设成开场就用 opening_apply。', { name: p.name, id: p.id }));
      }
      case 'opening_apply': {
        const id = idArg();
        if (!DRAWN[id]) {
          const p = d.svc.get(id);
          if (!p) return text(tr('没有这个已保存的开场：{id}（草稿要先 opening_save）', { id }), true);
        }
        await d.setPack(id);
        return text(tr('已设成开场：「{id}」。下次打开桌面版时放（设置里的「什么时候放」决定是每次还是每天第一次）。', { id }));
      }
      case 'opening_list': {
        const cur = typeof d.getPack() === 'string' && d.getPack() ? String(d.getPack()) : 'claude-web-chan';
        const mark = (id: string) => (cur === id ? tr(' · 正在用') : '');
        const rows = [
          ...d.svc.list().map((p) => `- ${p.id} · ${p.name} · ${p.kind === 'web' ? tr('网页') : tr('视频')} · ${p.builtin ? tr('内置') : tr('已保存')}${mark(p.id)}`),
          ...Object.entries(DRAWN).map(([id, n]) => `- ${id} · ${n} · ${tr('内置')}${mark(id)}`),
          ...d.svc.drafts().map((p) => `- ${p.id} · ${p.name} · ${tr('网页')} · ${tr('草稿')}`),
        ];
        return text(rows.join('\n'));
      }
      case 'opening_delete': {
        const id = idArg();
        if (DRAWN[id] || d.svc.get(id)?.builtin) return text(tr('内置的开场不能删。'), true);
        if (!(await d.svc.remove(id))) return text(tr('没有这个开场：{id}', { id }), true);
        if (d.getPack() === id) await d.setPack('claude-web-chan');
        return text(tr('已删除「{id}」。', { id }));
      }
    }
    return text(tr('没有这个工具：{name}', { name }), true);
  } catch (e: any) {
    return text(String(e?.message ?? e).slice(0, 2000), true);
  }
}

/**
 * The `opening` plugin (`plugins: [{type: 'local', path}]`): the opening-pack skill, written to
 * `<dataDir>/runtime/plugins/opening/` when its content changes. Null when it cannot be written.
 */
let written: string | null | undefined;
export function openingPluginDir(root = path.join(dataDir(), 'runtime', 'plugins')): string | null {
  if (written !== undefined) return written;
  const dir = path.join(root, 'opening');
  try {
    const files: [string, string][] = [
      [path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'opening', version: '1.0.0', description: 'Claude Web desktop openings: describe one, Claude makes it (a web opening pack).' }, null, 2)],
      [path.join(dir, 'skills', 'opening-pack', 'SKILL.md'), SKILL_MD],
    ];
    for (const [f, body] of files) {
      let same = false;
      try { same = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === crypto.createHash('sha256').update(body).digest('hex'); } catch { /* not there yet */ }
      if (same) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.tmp`, body);
      fs.renameSync(`${f}.tmp`, f);
    }
    written = dir;
  } catch (e) {
    console.warn(`[openings] could not write the opening plugin: ${(e as Error).message}`);
    written = null;
  }
  return written;
}
export function resetOpeningPlugin() { written = undefined; }
