import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionRequestEvent } from '@shared';

// The card the server raises before an ego lite script runs (server/src/web/service.ts, site-gate.ts; spec 14.1): the
// ego card's look — 「Claude 想在 ego lite 里运行一段脚本（host）」, the whole script — and only 允许一次 / 拒绝.
vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request() { return null; } },
}));
let DockCard: typeof import('./PermissionCards').DockCard;
beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ DockCard } = await import('./PermissionCards'));
});

const LONG = `const task = await taskSpace(CW_SPACE);\nconst p = task.page('p1');\nawait p.goto('https://mail.example/inbox');\n// ${'x'.repeat(900)}\nconsole.log('the last line');`;

/** The card PermissionDock docks for `p` (rendered without the store: SSR sees only its initial state). */
function dock(p: PermissionRequestEvent, agent = 'Claude') {
  return renderToStaticMarkup(createElement(DockCard, { p, agent, cwd: '/w', more: 0, reason: '', onReasonUsed: () => {}, scope: 'pane' }));
}
const acts = (html: string) => [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
/** the text a reader sees (the code block highlights: its tokens are spans) */
const unescape = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe('the server-raised ego lite script card', () => {
  const ego: PermissionRequestEvent = { requestId: 'r1', sessionId: 's', toolName: 'browser.site', input: { host: 'mail.example', op: 'eval', tool: 'ego_browser', eval: true, script: LONG, scriptLength: LONG.length } };

  it('looks like the ego card: its title with the site, the whole script, and only 允许一次 / 拒绝', () => {
    const html = dock(ego);
    expect(html).toContain('Claude 想在 ego lite 里运行一段脚本（mail.example）');
    expect(html).toContain('data-id="ego-card"');
    expect(html).toContain('在 ego lite 里运行的脚本');
    const text = unescape(html);
    expect(text).toContain("await p.goto('https://mail.example/inbox');");
    expect(text).toContain("console.log('the last line');");
    expect(text).toContain('x'.repeat(900));
    expect(acts(html)).toEqual(['deny', 'allow']);
    // not the built-in browser's site card
    expect(html).not.toContain('data-id="site-card"');
    expect(html).not.toContain('总是允许');
  });

  it('another agent asks the same way: its name in the title', () => {
    const html = dock({ ...ego, input: { ...ego.input, host: '' } }, 'Codex');
    expect(html).toContain('Codex 想在 ego lite 里运行一段脚本');
    expect(acts(html)).toEqual(['deny', 'allow']);
  });

  it('the built-in browser\'s script card is unchanged', () => {
    const html = dock({ requestId: 'r2', sessionId: 's', toolName: 'browser.site', input: { host: 'a.example', op: 'eval', tool: 'browser_eval', eval: true, script: '1', scriptLength: 1 } });
    expect(html).toContain('data-id="site-card"');
    expect(html).not.toContain('data-id="ego-card"');
  });
});

// a card with suggestions offers 总是允许 next to 拒绝 / 允许一次
describe('总是允许 on a tool card', () => {
  it('is offered when the request carries suggestions', () => {
    const html = dock({ requestId: 'rd', sessionId: 's', toolName: 'mcp__web__browser_open', input: { url: 'https://example.com/' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'mcp__web__browser_open' }], behavior: 'allow', destination: 'localSettings' }] });
    expect(html).toContain('Claude 想在浏览器里打开 example.com');
    expect(acts(html)).toEqual(['deny', 'always', 'allow']);
  });
});
