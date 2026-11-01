// A believable demo setup for screenshots and for looking at a whole language at once (scripts/readme-shots.cjs,
// scripts/i18n-smoke.cjs): a throwaway HOME with a git repo that has real uncommitted changes, finished conversations
// in three projects (Claude Code's own transcript layout), a fake Anthropic upstream — the provider's models answer
// from it, one conversation asks for a permission, one never finishes — and a small WebSocket client to set it all up.
// Nothing here talks to a real model and no real key is used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ---- what the demo says, in each language ----------------------------------------------------------------------
const TEXT = {
  en: {
    ask: 'The checkout total is off by a cent when a coupon is applied. Can you find the cause and fix it?',
    plan: 'I’ll start by looking at how the total is calculated.',
    found: 'Found it. `applyCoupon` subtracts a floating-point discount, so `19.99 − 15%` comes out as `16.9915000000000003`. I’ll round to whole cents, and add a test for it.',
    done: 'Fixed. `applyCoupon` now rounds the discount to whole cents, so a 15% coupon on 19.99 gives 16.99.\n\n- `src/cart.ts` — round the discount, then the total\n- `tests/cart.test.ts` — a test for the 15% case\n\nAll 14 tests pass. To use it:\n\n```ts\nimport { total } from "./src/cart";\ntotal([{ sku: "mug", price: 19.99, qty: 1 }], 15); // 16.99\n```',
    thinking: '**Tracing how the total is computed**\n\nTotals are computed in cart.ts; the discount is a float. Check the tests too.',
    others: [
      ['Add a dark mode toggle to the settings page', 'notes', 40],
      ['Why is the build failing on CI?', 'notes', 60 * 26],
      ['Write release notes for 1.4', 'blog', 60 * 5],
      ['Migrate the posts to markdown files', 'blog', 60 * 60 * 30],
      ['Add pagination to the orders list', 'shop', 60 * 60 * 3],
    ],
    replies: [
      'Done. The settings page has a Dark mode switch now; it follows the system theme until you change it.',
      'The build fails because `node` is 18 on CI while `package.json` asks for 20. Pin the version in the workflow and it passes.',
      'Here is a draft for 1.4: faster search, a fix for the double-submit bug, and a new export option.',
      'All 42 posts are now markdown files with front matter, under `posts/`.',
      'The orders list now loads 20 at a time with a “Load more” button; the API takes `page` and `limit`.',
    ],
    gitignore: 'Add the coverage folder to .gitignore',
    gitignoreSay: 'I’ll add the coverage output to `.gitignore`.',
    hang: 'Profile the product search and tell me what is slow',
    hangSay: 'Reading the search code and running the benchmark…',
    schedules: [['Daily summary', 'Summarize today’s git commits, grouped by feature / fix / chore.']],
    goal: 'Move the whole test suite to Vitest, keeping every test green',
    sys: 'Claude Web',
    recIntro: 'Take a look at the cart module first',
    recIntroSay: 'The cart module is `src/cart.ts`: `subtotal`, `applyCoupon` and `total`, with one test in `tests/cart.test.ts`.',
    rec: 'Round the coupon discount to whole cents, then run the tests',
    recSay: ['Let me read how the discount is applied.', 'The discount is a float. I’ll round it to whole cents.', 'Now the tests.'],
    recTestDesc: 'Run the tests',
    recDone: 'All tests pass.',
    themeAsk: 'A metro station late at night, green signal lights blinking',
    themeSay: ['A late-night metro: a dark platform and green signal lights. I’ll draft it and look at the trial run.', 'The trial run looks right. Saving it.', 'Switching to it now.'],
    themeDone: 'Done: the Metro theme is on.',
  },
  zh: {
    ask: '结算页的总价在用了优惠券之后会差一分钱，帮我找一下原因并修好。',
    plan: '我先看一下总价是怎么算的。',
    found: '找到了。`applyCoupon` 减的是浮点数的折扣，`19.99 − 15%` 会算成 `16.9915000000000003`。我改成按「分」取整，再补一个测试。',
    done: '修好了。`applyCoupon` 现在把折扣取整到分，19.99 用 15% 的券得到 16.99。\n\n- `src/cart.ts` —— 先把折扣取整，再取整总价\n- `tests/cart.test.ts` —— 补了 15% 这一种情况的测试\n\n14 个测试全部通过。用法：\n\n```ts\nimport { total } from "./src/cart";\ntotal([{ sku: "mug", price: 19.99, qty: 1 }], 15); // 16.99\n```',
    thinking: '**查看总价是怎么算的**\n\n总价在 cart.ts 里算，折扣是浮点数。测试也要看一下。',
    others: [
      ['给设置页加一个深色模式开关', 'notes', 40],
      ['为什么 CI 上的构建失败了？', 'notes', 60 * 26],
      ['写一下 1.4 版本的更新说明', 'blog', 60 * 5],
      ['把文章迁移成 markdown 文件', 'blog', 60 * 60 * 30],
      ['给订单列表加分页', 'shop', 60 * 60 * 3],
    ],
    replies: [
      '好了。设置页加了一个「深色模式」开关，没改过之前会跟着系统主题走。',
      '构建失败是因为 CI 上的 node 是 18，而 package.json 要 20。在工作流里固定一下版本就能过。',
      '这是 1.4 的草稿：搜索更快、修了重复提交的问题、新增一个导出选项。',
      '42 篇文章都已经改成带头信息的 markdown 文件，放在 `posts/` 下。',
      '订单列表现在一次加载 20 条，下面有「加载更多」；接口接受 `page` 和 `limit`。',
    ],
    gitignore: '把 coverage 目录加到 .gitignore 里',
    gitignoreSay: '我把测试覆盖率的输出加到 `.gitignore`。',
    hang: '看一下商品搜索，告诉我慢在哪',
    hangSay: '正在读搜索的代码、跑基准测试……',
    schedules: [['每日总结', '总结今天这个仓库的 git 提交，按功能 / 修复 / 杂项分组。']],
    goal: '把整个测试套件迁到 Vitest，每个测试都要保持通过',
    sys: 'Claude Web',
    recIntro: '先看一下购物车模块',
    recIntroSay: '购物车模块在 `src/cart.ts`：`subtotal`、`applyCoupon` 和 `total`，测试在 `tests/cart.test.ts`，目前只有一个。',
    rec: '把优惠券的折扣取整到分，然后跑一下测试',
    recSay: ['我先看一下折扣是怎么减的。', '折扣是浮点数，我把它取整到分。', '跑一下测试。'],
    recTestDesc: '跑测试',
    recDone: '测试全部通过。',
    themeAsk: '深夜的地铁站，绿色的指示灯在闪',
    themeSay: ['深夜的地铁站：暗下来的站台、绿色的信号灯。我先起个草稿，看看试跑。', '试跑看着没问题，存下来。', '现在换上。'],
    themeDone: '好了，换上了「地铁站」。',
  },
};

// ---- the repo and the transcripts ------------------------------------------------------------------------------
const CART_OLD = `export interface Item { sku: string; price: number; qty: number }

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function applyCoupon(total: number, percent: number): number {
  return total - total * (percent / 100);
}

export function total(items: Item[], couponPercent = 0): number {
  return applyCoupon(subtotal(items), couponPercent);
}
`;
const CART_NEW = CART_OLD.replace('  return total - total * (percent / 100);', '  const discount = Math.round(total * percent) / 100;\n  return Math.round((total - discount) * 100) / 100;');
const TEST_OLD = `import { describe, expect, it } from "vitest";
import { total } from "../src/cart";

describe("total", () => {
  it("adds up the items", () => {
    expect(total([{ sku: "mug", price: 10, qty: 2 }])).toBe(20);
  });
});
`;
const TEST_NEW = TEST_OLD.replace('  });\n});\n', '  });\n\n  it("rounds a percent coupon to whole cents", () => {\n    expect(total([{ sku: "mug", price: 19.99, qty: 1 }], 15)).toBe(16.99);\n  });\n});\n');

function gitIn(cwd) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Dana Lee', GIT_AUTHOR_EMAIL: 'dana@example.invalid', GIT_COMMITTER_NAME: 'Dana Lee', GIT_COMMITTER_EMAIL: 'dana@example.invalid' };
  return (...a) => execFileSync('git', a, { cwd, windowsHide: true, stdio: 'ignore', env });
}

function mkRepo(dir, files, message) {
  fs.rmSync(dir, { recursive: true, force: true }); // left over from a run that was stopped before its cleanup
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git;
}

function transcriptDir(home, cwd) {
  const d = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A finished conversation: [{ role:'user'|'assistant', content, at(sec offset) }] written the way Claude Code writes it. */
function writeTranscript(home, cwd, sid, lines, startMsAgo) {
  const dir = transcriptDir(home, cwd);
  const t0 = Date.now() - startMsAgo;
  let parent = null, n = 0;
  const base = { isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.281', gitBranch: 'main' };
  const rows = lines.map((l) => {
    const uuid = `00000000-0000-4000-8000-${sid.slice(-8)}${String(++n).padStart(4, '0')}`;
    const timestamp = new Date(t0 + l.at * 1000).toISOString();
    const row = l.role === 'user'
      ? { ...base, parentUuid: parent, type: 'user', message: { role: 'user', content: l.content }, uuid, timestamp }
      : { ...base, parentUuid: parent, type: 'assistant', message: { id: `msg_${sid.slice(-6)}_${l.id ?? n}`, type: 'message', role: 'assistant', model: l.model ?? 'claude-sonnet-5-5', content: l.content, stop_reason: 'end_turn', usage: { input_tokens: 4200, output_tokens: 380, cache_read_input_tokens: 21000 } }, uuid, timestamp };
    parent = uuid;
    return JSON.stringify(row);
  });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const end = new Date(t0 + lines[lines.length - 1].at * 1000); // the list sorts by the file's own time
  fs.utimesSync(file, end, end);
}

/** C:/work on Windows when it can be made (a plain path in the pictures), else a folder in the throwaway HOME. */
function workRoot(home) {
  if (process.platform === 'win32') {
    try {
      const d = 'C:/work';
      fs.mkdirSync(d, { recursive: true });
      return d;
    } catch { /* no write access to C:\ */ }
  }
  return path.join(home, 'work');
}

function seedDemo(home, lang, opts = {}) {
  const T = TEXT[lang];
  // a short, neutral place: the paths show in the pictures (permission cards, the Files panel)
  const work = workRoot(home);
  const shop = path.join(work, 'acme-shop');
  const notes = path.join(work, 'notes-app');
  const blog = path.join(work, 'blog-site');
  const git = mkRepo(shop, { 'package.json': '{ "name": "acme-shop", "scripts": { "test": "vitest run" } }\n', 'src/cart.ts': CART_OLD, 'tests/cart.test.ts': TEST_OLD, 'README.md': '# Acme shop\n' }, 'Add cart totals');
  if (!opts.clean) { // what the conversation below did: real uncommitted changes (a recording starts clean: its Edit needs the old text)
    fs.writeFileSync(path.join(shop, 'src/cart.ts'), CART_NEW);
    fs.writeFileSync(path.join(shop, 'tests/cart.test.ts'), TEST_NEW);
  }
  mkRepo(notes, { 'README.md': '# notes-app\n', 'src/App.tsx': 'export const App = () => null;\n' }, 'Initial commit');
  mkRepo(blog, { 'README.md': '# blog-site\n', 'posts/hello.md': '# Hello\n' }, 'Initial commit');
  void git;

  const cart = path.join(shop, 'src/cart.ts');
  const test = path.join(shop, 'tests/cart.test.ts');
  const sid = '7c1d0e0e-0000-4000-8000-00000000a001';
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
  writeTranscript(home, shop, sid, [
    { role: 'user', content: T.ask, at: 0 },
    { role: 'assistant', id: 1, content: [{ type: 'thinking', thinking: T.thinking, signature: 'x' }], at: 6 },
    { role: 'assistant', id: 1, content: [{ type: 'text', text: T.plan }, tool('toolu_a1', 'Grep', { pattern: 'applyCoupon', path: 'src' })], at: 7 },
    { role: 'user', content: [result('toolu_a1', 'src/cart.ts:7:export function applyCoupon(total: number, percent: number): number {\nsrc/cart.ts:12:  return applyCoupon(subtotal(items), couponPercent);')], at: 8 },
    { role: 'assistant', id: 2, content: [tool('toolu_a2', 'Read', { file_path: cart })], at: 10 },
    { role: 'user', content: [result('toolu_a2', CART_OLD.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n'))], at: 11 },
    { role: 'assistant', id: 3, content: [{ type: 'text', text: T.found }, tool('toolu_a3', 'Edit', { file_path: cart, old_string: '  return total - total * (percent / 100);', new_string: '  const discount = Math.round(total * percent) / 100;\n  return Math.round((total - discount) * 100) / 100;' })], at: 22 },
    { role: 'user', content: [result('toolu_a3', 'The file has been updated.')], at: 23 },
    { role: 'assistant', id: 4, content: [tool('toolu_a4', 'Edit', { file_path: test, old_string: '  });\n});\n', new_string: TEST_NEW.slice(TEST_NEW.indexOf('  });\n\n  it("rounds')) })], at: 31 },
    { role: 'user', content: [result('toolu_a4', 'The file has been updated.')], at: 32 },
    { role: 'assistant', id: 5, content: [tool('toolu_a5', 'Bash', { command: 'npm test', description: 'Run the tests' })], at: 36 },
    { role: 'user', content: [result('toolu_a5', ' ✓ tests/cart.test.ts (2)\n ✓ tests/orders.test.ts (12)\n\n Test Files  2 passed (2)\n      Tests  14 passed (14)')], at: 44 },
    { role: 'assistant', id: 6, content: [{ type: 'text', text: T.done }], at: 52 },
  ], 11 * 60_000);

  const ids = [];
  T.others.forEach(([ask, where, agoSec], i) => {
    const cwd = where === 'notes' ? notes : where === 'blog' ? blog : shop;
    const s = `7c1d0e0e-0000-4000-8000-00000000b0${String(i).padStart(2, '0')}`;
    ids.push(s);
    writeTranscript(home, cwd, s, [
      { role: 'user', content: ask, at: 0 },
      { role: 'assistant', id: 1, content: [{ type: 'text', text: T.replies[i] }], at: 20 },
    ], agoSec * 1000 + 30_000);
  });
  return { shop, notes, blog, sid, ids, texts: T, cleanup: () => { for (const d of [shop, notes, blog]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* held open */ } } } };
}

// ---- the fake Anthropic upstream -------------------------------------------------------------------------------
// The recordings' scripts (scripts/record-themes.cjs): the same turn, paced the same way, every time. A step is one
// model response; which step comes next = how many tool results follow the user's words. Text and tool arguments
// stream in chunks so the app shows each step running (with the theme's process animation) for a moment.
const sse = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
const pieces = (s, n) => { const cps = Array.from(s); const k = Math.max(1, Math.ceil(cps.length / n)); const out = []; for (let i = 0; i < cps.length; i += k) out.push(cps.slice(i, i + k).join('')); return out; };
const streamText = (i, text, n, gap) => [[0, sse('content_block_start', { index: i, content_block: { type: 'text', text: '' } })], ...pieces(text, n).map((c) => [gap, sse('content_block_delta', { index: i, delta: { type: 'text_delta', text: c } })]), [0, sse('content_block_stop', { index: i })]];
const streamTool = (i, id, name, input, n, gap) => [[0, sse('content_block_start', { index: i, content_block: { type: 'tool_use', id, name, input: {} } })], ...pieces(JSON.stringify(input), n).map((c) => [gap, sse('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: c } })]), [0, sse('content_block_stop', { index: i })]];
const finish = (reason) => [[0, sse('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 40 } })], [0, sse('message_stop', {})]];

function metroFixture() {
  const d = path.join(__dirname, 'fixtures', 'theme-metro');
  const read = (f) => fs.readFileSync(path.join(d, f), 'utf8');
  return { json: JSON.parse(read('theme.json')), backdrop: read('backdrop.js'), css: read('theme.css') };
}

/** [script, its name] for this request, or null: only main-loop requests (they carry tools) follow a script */
function scriptFor(T, ask, tools, shop) {
  if (!tools.length) return null;
  if (ask.includes(T.recIntro)) return [() => [...streamText(0, T.recIntroSay, 8, 40), ...finish('end_turn')]];
  if (ask.includes(T.rec) && tools.includes('Read')) {
    const cart = path.join(shop, 'src', 'cart.ts');
    return [
      // paced so that, from Enter at 5.8 s, the npm test card shows at 9–10 s (the CLI's own round trips take ~2 s)
      () => [...streamText(0, T.recSay[0], 6, 40), ...streamTool(1, 'toolu_rec_read', 'Read', { file_path: cart }, 6, 40), ...finish('tool_use')],
      () => [[100, ''], ...streamText(0, T.recSay[1], 6, 40), ...streamTool(1, 'toolu_rec_edit', 'Edit', { file_path: cart, old_string: '  return total - total * (percent / 100);', new_string: '  const discount = Math.round(total * percent) / 100;\n  return Math.round((total - discount) * 100) / 100;' }, 8, 40), ...finish('tool_use')],
      () => [[100, ''], ...streamText(0, T.recSay[2], 4, 40), ...streamTool(1, 'toolu_rec_test', 'Bash', { command: 'npm test', description: T.recTestDesc }, 4, 40), ...finish('tool_use')],
      () => [...streamText(0, T.recDone, 6, 40), ...finish('end_turn')],
    ];
  }
  if (ask.includes(T.themeAsk)) {
    return [
      // short: the draft's try-out (~4 s) and the runtime's own round trips take most of the 8 s to the apply card
      () => [...streamText(0, T.themeSay[0], 4, 30), ...streamTool(1, 'toolu_th_draft', 'mcp__web__theme_draft', metroFixture(), 6, 30), ...finish('tool_use')],
      () => [...streamText(0, T.themeSay[1], 4, 30), ...streamTool(1, 'toolu_th_save', 'mcp__web__theme_save', { id: 'metro' }, 2, 30), ...finish('tool_use')],
      () => [...streamText(0, T.themeSay[2], 4, 30), ...streamTool(1, 'toolu_th_apply', 'mcp__web__theme_apply', { id: 'metro' }, 2, 30), ...finish('tool_use')],
      () => [...streamText(0, T.themeDone, 6, 40), ...finish('end_turn')],
    ];
  }
  return null;
}

function startUpstream(lang, opts = {}) {
  const T = TEXT[lang];
  const pace = opts.pace ?? 1;
  const isResult = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result');
  /** the user's last words (system reminders, which start with "<", are not words) and where they are */
  const lastAsk = (msgs) => {
    for (let k = msgs.length - 1; k >= 0; k--) {
      const m = msgs[k];
      if (m?.role !== 'user') continue;
      if (typeof m.content === 'string') return { text: m.content, at: k };
      const words = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === 'text' && !String(b.text).startsWith('<'));
      if (words.length) return { text: words.map((b) => b.text).join('\n'), at: k };
    }
    return { text: '', at: -1 };
  };
  const paced = async (s, parts) => { for (const [ms, chunk] of parts) { if (ms && pace) await new Promise((r) => setTimeout(r, ms * pace)); if (chunk) s.write(chunk); } s.end(); };
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : textOf(p?.content)))).join('\n') : '');
  let n = 0;
  const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  const head = (j) => ev('message_start', { message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const textBlock = (i, text) => ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } });
  const server = http.createServer((q, s) => {
    let raw = '';
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      let j = {};
      try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
      if (q.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
      if (q.url.includes('/models')) return json(s, 200, { data: [{ id: 'claude-sonnet-5-5', type: 'model' }] });
      if (!q.url.startsWith('/v1/messages')) return json(s, 404, { error: { message: 'no' } });
      if (!j.stream) return json(s, 200, { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      const msgs = j.messages ?? [];
      const last = msgs.at(-1);
      const hasResult = last?.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b?.type === 'tool_result');
      const first = textOf(msgs.find((m) => m.role === 'user')?.content);
      const ask = lastAsk(msgs);
      const script = scriptFor(T, ask.text, Array.isArray(j.tools) ? j.tools.map((t) => t?.name) : [], opts.shop ?? '');
      if (script) {
        const step = msgs.slice(ask.at + 1).filter(isResult).length;
        // which step each request got, when (debugging a recording's timing: CW_DEMO_UPSTREAM_LOG=1)
        if (process.env.CW_DEMO_UPSTREAM_LOG) console.error(`[upstream] ${new Date().toISOString().slice(11, 23)} step ${step} ask=${JSON.stringify(ask.text.slice(0, 40))}`);
        void paced(s, [[0, head(j)], ...script[Math.min(step, script.length - 1)]()]);
        return;
      }
      if (hasResult) {
        s.end(head(j) + textBlock(0, lang === 'zh' ? '好了。' : 'Done.') + ev('content_block_stop', { index: 0 }) + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {}));
      } else if (first.includes(T.gitignore)) {
        const input = { file_path: path.join(process.env.CW_DEMO_SHOP ?? '', '.gitignore'), content: 'node_modules/\ncoverage/\n' };
        s.end(head(j) + textBlock(0, T.gitignoreSay) + ev('content_block_stop', { index: 0 }) + ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_demo_write', name: 'Write', input: {} } }) + ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) + ev('content_block_stop', { index: 1 }) + ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {}));
      } else if (first.includes(T.hang)) {
        s.write(head(j) + textBlock(0, T.hangSay)); // …and never finishes: the conversation stays running
      } else {
        s.end(head(j) + textBlock(0, 'ok') + ev('content_block_stop', { index: 0 }) + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {}));
      }
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---- the server and a client for it ----------------------------------------------------------------------------
async function startServer(home, opts) {
  const token = require('node:crypto').randomBytes(12).toString('hex');
  // Nothing of this machine's own setup may reach the pictures: every Claude / Claude Web / provider variable of the
  // shell that started us goes (a dev shell carries the desktop app's CLAUDE_WEB_SIDECARS, CLAUDE_WEB_STANDALONE,
  // CLAUDE_CODE_PLUGIN_DIRS, CLAUDECODE…), and the per-user folders Windows apps read besides HOME (%APPDATA%: the
  // official app's skills, other tools' configs and conversations; %LOCALAPPDATA%: Codex / OpenCode) are in the
  // throwaway HOME too.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE|OPENAI_|GEMINI_|CODEX_|XDG_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
  Object.assign(env, { HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', CLAUDE_WEB_SYSTEM_LANG: opts.lang === 'zh' ? 'zh-CN' : 'en-US', CW_DEMO_SHOP: opts.shop ?? '' });
  if (process.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    for (const d of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(d, { recursive: true });
  }
  // a web build somewhere else than web/dist (the recorder builds its own: a running dev app serves web/dist)
  if (opts.dist) env.CLAUDE_WEB_DIST = opts.dist;
  fs.mkdirSync(env.CLAUDE_WEB_DIR, { recursive: true });
  const metaFile = path.join(env.CLAUDE_WEB_DIR, 'meta.json');
  if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, JSON.stringify({ version: 1, settings: { 'ui.language': opts.lang, 'ui.theme': opts.theme ?? 'dark', 'ui.sidebarFolded': false, ...(opts.settings ?? {}) } }));
  const server = spawn(process.execPath, opts.fromSource ? ['--import', 'tsx', path.join(ROOT, 'server', 'src', 'index.ts')] : [path.join(ROOT, 'server', 'dist', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  server.stderr.on('data', (d) => { log += d; });
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${log}`)), 60_000);
    server.stdout.on('data', (d) => { log += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(log); if (m) { clearTimeout(t); res(m[1]); } });
    server.on('exit', (c) => rej(new Error(`server exited (${c})\n${log}`)));
  });
  return { server, port, token, url: `http://127.0.0.1:${port}/?token=${token}`, log: () => log };
}

function client(port, token) {
  const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); } else if (m.type === 'event') events.push(m.event);
  });
  const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return { ws, req, events, ready };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpHome = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

module.exports = { ROOT, TEXT, seedDemo, startUpstream, startServer, client, sleep, tmpHome };
