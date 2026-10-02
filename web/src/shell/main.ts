// The phone shell (spec §6): pairs through the QR link, lists the paired PCs, dials one (direct first, the slow
// relay when that does not get through), and runs the app — fetched from that PC — in a same-origin frame whose
// WebSockets (window.__cwTunnel) and requests (the service worker, sw.ts) go over the link.
import './shell.css';
import { Brokers, DEFAULT_BROKERS, DEFAULT_STUN, b64u, dial, type DialState, type RtcCtor } from '@anywhere';
import type { CachesLike } from './assets';
import { idbDevices, memoryDevices, type DeviceRec, type DeviceStore } from './devices';
import { SAY, noRtc, type Explained } from './explain';
import { readShellRequest, replyFromError } from './forward';
import { parsePairLink, type PairLink } from './pair-link';
import { Session, explain, pairWith, type Dialer, type SessionView } from './session';
import { Ui, type BarState } from './ui';

const scope = new URL('./', location.href).href;
/** This window, on its app frame's address: the service worker hands that frame's requests to this window only. */
const owner = b64u(crypto.getRandomValues(new Uint8Array(9)));
const ui = new Ui(document.getElementById('root')!);
const rtc = (globalThis as unknown as { RTCPeerConnection?: RtcCtor }).RTCPeerConnection ?? null;
const brokers = new Brokers(DEFAULT_BROKERS);
const HINT_KEY = 'cw.shell.iosHint';

const STEP: Record<DialState, string> = {
  finding: '正在找电脑…',
  connecting: '找到了，正在直连…',
  relay: '直连没打通，正在改用慢速转发…',
};

/** No RTCPeerConnection here (C4): the dial goes straight to the slow relay, so this is never constructed. */
const NoRtc = class {
  constructor() {
    throw new Error('RTCPeerConnection missing');
  }
} as unknown as RtcCtor;

const dialer: Dialer = {
  dial(room, onstate, fresh) {
    // after a network change the old broker connections are likely dead: start them again at once
    if (fresh) brokers.stop();
    brokers.start();
    return dial({ brokers, room, stun: DEFAULT_STUN, rtc: rtc ?? NoRtc, forceRelay: !rtc, onstate });
  },
  idle() {
    brokers.stop();
  },
};

let store: DeviceStore = typeof indexedDB === 'undefined' ? memoryDevices() : idbDevices();
let session: Session | null = null;
/** Bumped by every new screen flow: an older one's late results are dropped. */
let flow = 0;
const worker = startWorker();

function setTunnel(s: Session | null): void {
  const w = window as Window & { __cwTunnel?: unknown };
  if (s) w.__cwTunnel = s.tunnel;
  else delete w.__cwTunnel;
}

function persist(): void {
  // asks the browser not to clear the pairing under storage pressure (a no-op where it is not offered)
  navigator.storage?.persist?.().catch(() => {});
}

function iosHintWanted(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  try {
    return ios && !standalone && localStorage.getItem(HINT_KEY) !== '1';
  } catch {
    return ios && !standalone;
  }
}

async function devices(): Promise<DeviceRec[]> {
  try {
    return await store.list();
  } catch (e) {
    console.error('[shell] devices:', e);
    // IndexedDB refused (a private window): this visit only
    store = memoryDevices();
    return [];
  }
}

async function keep(d: DeviceRec): Promise<void> {
  try {
    await store.put(d);
  } catch (e) {
    console.error('[shell] keep device:', e);
    store = memoryDevices();
    await store.put(d);
  }
}

async function showList(notice: Explained | null = null): Promise<void> {
  const mine = ++flow;
  const list = await devices();
  if (mine !== flow) return;
  ui.devices(list, {
    notice,
    connect: (d) => void connect(d),
    remove: (d) => void store.remove(d.id).catch(() => {}).then(() => showList()),
    iosHint: iosHintWanted()
      ? () => {
          try {
            localStorage.setItem(HINT_KEY, '1');
          } catch {
            // private mode: shown again next time
          }
          void showList(notice);
        }
      : null,
  });
}

/** Ends the connection (and the app frame with it); `rest`: no dial follows, the broker connections close too. */
function leave(rest = false): void {
  session?.close();
  session = null;
  setTunnel(null);
  if (rest) brokers.stop();
}

function back(): void {
  leave(true);
  void showList();
}

async function pair(p: PairLink): Promise<void> {
  leave();
  const mine = ++flow;
  const title = `正在配对 ${p.pc || '电脑'}`;
  const busy = (step: DialState) => {
    if (mine === flow) ui.busy(title, STEP[step], { note: rtc ? null : noRtc(), cancel: back });
  };
  busy('finding');
  try {
    const rec = await pairWith(p, dialer, busy, navigator.userAgent);
    // kept even if the user went back meanwhile: the PC has the device already
    await keep(rec);
    persist();
    if (mine === flow) void connect(rec, true);
  } catch (e) {
    if (mine === flow) ui.failed('配对没有成功', explain(e), { retry: () => void pair(p), back });
  }
}

const relayBar = (): BarState => ({ text: SAY.relay, tone: 'warn', closable: true });

async function connect(d: DeviceRec, justPaired = false): Promise<void> {
  leave();
  const mine = ++flow;
  const title = `正在连接 ${d.pcName}`;
  const note = rtc ? null : noRtc();
  ui.busy(title, STEP.finding, { note, cancel: back });
  const caches = (globalThis as unknown as { caches?: CachesLike }).caches;
  if (!(await worker) || !caches) {
    if (mine === flow) ui.failed('没连上', { text: SAY.noWorker, raw: 'no service worker' }, { back });
    return;
  }
  if (mine !== flow) return;
  const s: Session = new Session({
    device: d,
    dialer,
    caches,
    scope,
    owner,
    justPaired,
    onview: (v) => view(s, v, title, note),
    onopened: () => void keep({ ...d, lastAt: Date.now() }),
  });
  session = s;
  // before the frame exists: the app looks for it once, when it loads
  setTunnel(s);
  await s.start();
}

function view(s: Session, v: SessionView, title: string, note: Explained | null): void {
  if (s !== session) return;
  const open = s.isOpen;
  switch (v.k) {
    case 'dialing':
      if (open) ui.setBar({ text: `连接断了，正在重新连接：${STEP[v.step]}`, tone: 'warn', busy: true });
      else ui.busy(title, STEP[v.step], { note, cancel: back });
      return;
    case 'files': {
      const line = `正在取界面文件…（${v.done}/${v.total}）`;
      if (open) ui.setBar({ text: line, tone: 'info', busy: true });
      else ui.busy(title, line, { progress: v.total ? v.done / v.total : 0, note, cancel: back });
      return;
    }
    case 'open':
      ui.app(v.url, () => s.tunnel.closeAll());
      ui.setBar(v.kind === 'relay' ? relayBar() : null);
      return;
    case 'relinking':
      ui.setBar({ text: '连接断了，正在重新连接…', tone: 'warn', busy: true });
      return;
    case 'linked':
      ui.setBar(v.kind === 'relay' ? relayBar() : null);
      return;
    case 'updating':
      ui.setBar({ text: '电脑上的 Claude Web 更新了，正在取新版本的界面文件…', tone: 'info', busy: true });
      return;
    case 'refused':
      ui.setBar({ text: v.text, tone: 'warn', closable: true });
      return;
    case 'down':
      ui.setBar({ text: v.why.text, raw: v.why.raw, tone: 'err', actions: [{ label: '重新连接', run: () => void s.redial() }, { label: '返回', run: back }] });
      return;
    case 'failed':
      ui.failed('没连上', v.why, { retry: () => void connect(s.device), back });
      return;
  }
}

/** The service worker's requests for the app frame: answered here, over this window's link (forward.ts). */
function onWorkerMessage(ev: MessageEvent): void {
  const port = ev.ports[0];
  const m = readShellRequest(ev.data);
  if (!port || !m) return;
  const s = session;
  if (!s || !s.isOpen || (m.owner && m.owner !== owner)) return port.postMessage({ skip: true });
  s.serve(m).then(
    (r) => port.postMessage(r, r.body ? [r.body] : []),
    (e) => port.postMessage(replyFromError(e)),
  );
}

/** The service worker that serves the app frame; true once one is active (the frame is only made after that). */
async function startWorker(): Promise<boolean> {
  const sw = navigator.serviceWorker;
  if (!sw) return false;
  sw.addEventListener('message', onWorkerMessage);
  sw.startMessages();
  try {
    await sw.register('./sw.js', { scope: './' });
    const ready = await Promise.race([sw.ready, new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
    return !!ready?.active;
  } catch (e) {
    console.error('[shell] service worker:', e);
    return false;
  }
}

function clearHash(): void {
  history.replaceState(null, '', location.pathname + location.search);
}

// a phone that changed networks, or came back to this page: a link that has dropped is dialed again
window.addEventListener('online', () => void session?.redial());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void session?.redial();
});

/** A pairing link in the address: taken (and cleared: the code is single-use, a reload must not try it again). */
function takePairLink(): boolean {
  const hash = location.hash;
  if (!/^#p=/.test(hash)) return false;
  clearHash();
  const p = parsePairLink(hash);
  if (p) void pair(p);
  else void showList({ text: SAY.badLink, raw: 'unreadable #p= link' });
  return true;
}

// a QR scanned while the shell is already open in this tab only changes the fragment
window.addEventListener('hashchange', () => void takePairLink());
if (!takePairLink()) {
  void showList();
  persist();
}
