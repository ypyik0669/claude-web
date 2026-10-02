// Cross-window group migration over BroadcastChannel (same origin → no IPC needed; also works for browser tabs).
import { useStore } from '@/store';
import { winId } from '@/store/paneContext';
import { desktop } from '@/desktop';
import { canOpenWindow } from '@/ws/tunnel';
import type { Group } from '@/model/layout';

type Msg =
  | { t: 'hello'; from: string }
  | { t: 'here'; from: string }
  | { t: 'group.offer'; from: string; to: string; group: Group }
  | { t: 'group.ack'; from: string; to: string; groupId: string }
  | { t: 'claim'; sessionId: string };

const ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cw.workbench') : null;
const peers = new Set<string>();
const waiting = new Map<string, () => void>(); // groupId -> resolve

ch?.addEventListener('message', (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  if (m.t === 'hello') { peers.add(m.from); ch.postMessage({ t: 'here', from: winId } satisfies Msg); }
  else if (m.t === 'here') peers.add(m.from);
  else if (m.t === 'group.offer' && m.to === winId) {
    useStore.getState().dispatchLayout({ t: 'group.add', group: m.group });
    useStore.getState().dispatchLayout({ t: 'group.activate', id: m.group.id });
    ch.postMessage({ t: 'group.ack', from: winId, to: m.from, groupId: m.group.id } satisfies Msg);
  } else if (m.t === 'group.ack' && m.to === winId) {
    waiting.get(m.groupId)?.();
    waiting.delete(m.groupId);
  } else if (m.t === 'claim') {
    // another window could not find the session; first window takes it
    if (winId === 'main') {
      const st = useStore.getState();
      st.open[m.sessionId] ? st.setActive(m.sessionId) : void st.loadHistory(m.sessionId);
    }
  }
});
ch?.postMessage({ t: 'hello', from: winId } satisfies Msg);

export const listPeers = () => [...peers];

/** Send a group to `to` (an existing window id); resolves once the peer acknowledged and the group was removed here. */
export function sendGroupTo(groupId: string, to: string): Promise<void> {
  const st = useStore.getState();
  const g = st.layout.groups.find((x) => x.id === groupId);
  if (!g || !ch) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(groupId); st.toast('目标窗口没有响应'); resolve(); }, 8000);
    waiting.set(groupId, () => {
      clearTimeout(timer);
      useStore.getState().dispatchLayout({ t: 'group.remove', id: groupId });
      resolve();
    });
    ch.postMessage({ t: 'group.offer', from: winId, to, group: g } satisfies Msg);
  });
}

/**
 * Desktop: open a new window and hand it the group once it says hello (a browser: a new tab of the app). Never inside
 * the phone shell: the new page would be a top-level app/index.html with no tunnel to the computer.
 */
export async function offerGroupToNewWindow(groupId: string) {
  if (!canOpenWindow()) return;
  const st = useStore.getState();
  if (st.layout.groups.length < 2) { st.toast('至少保留一个分组在当前窗口；先新建一个分组再迁移'); return; }
  if (!desktop?.newWindow) { window.open(`${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), win: `w${Date.now().toString(36)}` })}`, '_blank'); return; }
  const id = await desktop.newWindow();
  // wait for the peer's hello
  const until = Date.now() + 15000;
  while (!peers.has(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (!peers.has(id)) { st.toast('新窗口没有就绪'); return; }
  await sendGroupTo(groupId, id);
}

export function claimSession(sessionId: string) {
  ch?.postMessage({ t: 'claim', sessionId } satisfies Msg);
}
