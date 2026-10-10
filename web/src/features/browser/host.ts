// This window as the built-in browser an Agent's web tools work in (spec 2026-10-10-ui-structure §5.2): it tells the
// server (`browser.host`), gets each operation as a `browser.command` event, carries it out in a tab of the right
// panel's browser, and answers with `browser.result`. Desktop app only; with no such window the server reads pages
// itself and says what needs the desktop app.
import type { BrowserAnswer, BrowserCommand, ServerEvent } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { showPanel } from '@/features/workbench/right-panel';
import { runOp } from './ops';
import { pageOf } from './guest';
import { searchPage } from './search-page';
import { AGENT_PARTITION, USER_PARTITION, agentTab, frontTab, guestElOf, hasWebview, newTab, patchTab, tabOf, useBrowser } from './state';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A page with no size cannot be clicked or drawn: the right panel was put away. Bring the browser back for it. */
async function onScreen(tabId: string): Promise<void> {
  const laidOut = () => { const el = guestElOf(tabId); return !!el && el.offsetWidth > 0 && el.offsetHeight > 0; };
  if (!tabOf(tabId)?.src || laidOut()) return;
  showPanel('browser');
  frontTab(tabId);
  for (let i = 0; i < 30 && !laidOut(); i++) await sleep(50);
}

/** A picture is of what is drawn: the tab comes to the front of the browser, the browser to the front of the right panel. */
async function inFront(tabId: string): Promise<void> {
  const drawn = () => { const el = guestElOf(tabId); return !!el && el.offsetWidth > 0 && getComputedStyle(el).visibility === 'visible'; };
  if (!drawn()) {
    showPanel('browser');
    frontTab(tabId);
    for (let i = 0; i < 30 && !drawn(); i++) await sleep(50);
  }
  // two frames and a moment: what was just shown has to be painted before it can be pictured
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  await sleep(150);
}

/** One operation, in the tab this conversation's Agent works in (its first `open` makes the tab and shows the browser). */
export async function carryOut(c: BrowserCommand): Promise<BrowserAnswer> {
  const isolated = useStore.getState().settings['web.browser.isolated'] === true;
  // a search has a page of its own, off screen: it must not replace what the conversation has open
  if (c.op === 'search') return { search: await searchPage(String(c.args?.url ?? ''), isolated ? AGENT_PARTITION : USER_PARTITION) };
  let tab = agentTab(c.sessionId);
  if (!tab) {
    if (c.op !== 'open') throw new Error('这个对话还没有打开网页：先用 browser_open 打开一个网址。');
    const id = newTab({ agent: c.sessionId, partition: isolated ? AGENT_PARTITION : USER_PARTITION });
    // the Agent's own tab is new: the browser comes to the front once, so what it does is seen
    showPanel('browser');
    tab = tabOf(id)!;
  }
  const id = tab.id;
  await onScreen(id);
  // mouse and keyboard by position go by what is drawn, and answer with a picture of it
  if (c.op === 'screenshot' || c.op === 'computer') await inFront(id);
  patchTab(id, { busy: true });
  try {
    return await runOp(pageOf(id), c.op, c.args ?? {});
  } finally {
    patchTab(id, { busy: false });
  }
}

/** One operation at a time per conversation, in the order they were asked. */
const queues = new Map<string, Promise<void>>();

function take(c: BrowserCommand): void {
  const run = async () => {
    let msg: { ok: true; answer: BrowserAnswer } | { ok: false; error: string };
    try {
      msg = { ok: true, answer: await carryOut(c) };
    } catch (e) {
      msg = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 2000) };
    }
    // the server may have given up on it (30 s) or the connection may be gone: nothing more to do then
    await ws.request({ kind: 'browser.result', id: c.id, ...msg }).catch(() => {});
  };
  // searches belong to no conversation and have pages of their own (search-page.ts reads several at once)
  if (c.op === 'search') { void run(); return; }
  const next = (queues.get(c.sessionId) ?? Promise.resolve()).then(run, run);
  queues.set(c.sessionId, next);
  void next.finally(() => { if (queues.get(c.sessionId) === next) queues.delete(c.sessionId); });
}

/**
 * Installed once by App. The window that was used last is the one the server sends the operations to: it says so
 * again whenever it gets the focus, and after every reconnect.
 */
export function installBrowserHost(): () => void {
  if (!hasWebview()) return () => {};
  const announce = () => { if (useStore.getState().connected) void ws.request({ kind: 'browser.host', on: true }).catch(() => {}); };
  const offEvents = ws.on((e: ServerEvent) => { if (e.kind === 'browser.command' && e.command) take(e.command); });
  const offStore = useStore.subscribe((s, p) => { if (s.connected && !p.connected) announce(); });
  window.addEventListener('focus', announce);
  announce();
  return () => { offEvents(); offStore(); window.removeEventListener('focus', announce); };
}

// for scripts/browser-smoke.cjs: drive an operation without a server in between, and look at the tabs
(window as unknown as { __cwBrowser?: unknown }).__cwBrowser = { carryOut, state: useBrowser, canHost: hasWebview };
