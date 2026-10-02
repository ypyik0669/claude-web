// The phone shell (spec §6): pairs through the QR link, lists the paired PCs, dials one (direct first, the slow
// relay when that does not get through), and runs the app — fetched from that PC — in a same-origin frame whose
// WebSockets (window.__cwTunnel) and requests (the service worker, sw.ts) go over the link.
import './shell.css';
import { Brokers, DEFAULT_BROKERS, DEFAULT_STUN, b64u, dial, type DialState, type RtcCtor } from '@anywhere';
import { deviceCaches, type CachesLike } from './assets';
import { idbDevices, memoryDevices, type DeviceRec, type DeviceStore } from './devices';
import { SAY, type Explained } from './explain';
import { readShellRequest, replyFromError } from './forward';
import { BROKERS_KEY, STUN_KEY, brokerOverride, overrideNote, stunOverride } from './override';
import { linkKey, linkState, pairPlan, parsePairLink, rememberLink, type LinkMemory, type PairLink } from './pair-link';
import { Session, ShellError, explain, pairWith, type Dialer, type SessionView } from './session';
import { Ui, type BarState } from './ui';

const scope = new URL('./', location.href).href;
const SW_URL = new URL('sw.js', scope).href;
/** This window, on its app frame's address: the service worker hands that frame's requests to this window only. */
const owner = b64u(crypto.getRandomValues(new Uint8Array(9)));
const ui = new Ui(document.getElementById('root')!);
const rtc = (globalThis as unknown as { RTCPeerConnection?: RtcCtor }).RTCPeerConnection ?? null;
const rtcMissing = !rtc;
// tests and power users can replace both lists in localStorage (override.ts); read once, here, and said in the console
const brokerList = brokerOverride(local(BROKERS_KEY));
const stunList = stunOverride(local(STUN_KEY));
const brokers = new Brokers(brokerList ?? DEFAULT_BROKERS);
const stun = stunList ?? DEFAULT_STUN;
const note = overrideNote(brokerList, stunList);
if (note) console.info(note);
const HINT_KEY = 'cw.shell.iosHint';
const LINKS_KEY = 'cw.shell.pairLinks';
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

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
    return dial({ brokers, room, stun, rtc: rtc ?? NoRtc, forceRelay: rtcMissing, onstate });
  },
  idle() {
    brokers.stop();
  },
};

let store: DeviceStore = typeof indexedDB === 'undefined' ? memoryDevices() : idbDevices();
let session: Session | null = null;
/** The pairing in flight: cancelled by a newer one or by leaving its screen (its link closed, its result dropped). */
let pairing: AbortController | null = null;
/** Bumped by every new screen flow: an older one's late results are dropped. */
let flow = 0;

function setTunnel(s: Session | null): void {
  const w = window as Window & { __cwTunnel?: unknown };
  if (s) w.__cwTunnel = s.tunnel;
  else delete w.__cwTunnel;
}

function persist(): void {
  // asks the browser not to clear the pairing under storage pressure (a no-op where it is not offered)
  navigator.storage?.persist?.().catch(() => {});
}

function local(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: forgotten with the visit
  }
}

function linkMemory(): LinkMemory {
  try {
    return JSON.parse(local(LINKS_KEY) ?? '{}') as LinkMemory;
  } catch {
    return {};
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

/** A device removed: its record and the app caches of its PC. */
async function forget(d: DeviceRec): Promise<void> {
  await store.remove(d.id).catch((e) => console.error('[shell] remove device:', e));
  const caches = cacheStorage();
  if (!caches) return;
  for (const k of deviceCaches(await caches.keys().catch(() => []), d.id)) await caches.delete(k).catch(() => false);
}

async function showList(notice: Explained | null = null): Promise<void> {
  const mine = ++flow;
  const list = await devices();
  if (mine !== flow) return;
  ui.devices(list, {
    notice,
    connect: (d) => void connect(d),
    remove: (d) => void forget(d).then(() => showList()),
    iosHint:
      ios && !standalone && local(HINT_KEY) !== '1'
        ? () => {
            setLocal(HINT_KEY, '1');
            void showList(notice);
          }
        : null,
    paste: (text) => {
      const p = parsePairLink(text);
      if (!p) return SAY.badLink;
      // pasted here on purpose: pair here, whatever browser this is
      void takeLink(p, 'pair', true);
      return null;
    },
  });
}

/** Ends the connection and any pairing (the app frame with them); `rest`: no dial follows, the brokers close too. */
function leave(rest = false): void {
  pairing?.abort();
  pairing = null;
  session?.close();
  session = null;
  setTunnel(null);
  if (rest) brokers.stop();
}

function back(): void {
  leave(true);
  void showList();
}

function cacheStorage(): CachesLike | null {
  return (globalThis as unknown as { caches?: CachesLike }).caches ?? null;
}

let listening = false;

/**
 * The service worker that serves the app frame, active, and Cache Storage: what running the app needs. Asked on
 * every connect and before every pairing (a pairing in a browser that cannot run the app would spend the code).
 */
async function appReady(): Promise<CachesLike | null> {
  const sw = navigator.serviceWorker;
  const caches = cacheStorage();
  if (!sw || !caches) return null;
  if (!listening) {
    sw.addEventListener('message', onWorkerMessage);
    sw.startMessages();
    listening = true;
  }
  try {
    await sw.register('./sw.js', { scope: './' });
    const ready = await Promise.race([sw.ready, new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
    return ready?.active ? caches : null;
  } catch (e) {
    console.error('[shell] service worker:', e);
    return null;
  }
}

const noWorker = (): Explained => ({ text: SAY.noWorker, raw: 'no active service worker or no Cache Storage' });

/**
 * A pairing link from the address or the paste field: one already used here, or past its 10 minutes, is not tried
 * again (a home-screen app reopens its saved address, #p= and all); on iOS Safari the user chooses first (R12b).
 */
async function takeLink(p: PairLink, plan: 'ask' | 'pair', pasted = false): Promise<void> {
  const key = await linkKey(p);
  const state = linkState(linkMemory(), key, Date.now());
  if (state !== 'fresh') {
    clearHash();
    // a used link in the address is the home-screen bookmark opening again: just the list (it paired already)
    return showList(state === 'expired' ? { text: SAY.expiredLink, raw: '' } : pasted ? { text: SAY.usedLink, raw: '' } : null);
  }
  setLocal(LINKS_KEY, JSON.stringify(rememberLink(linkMemory(), key, Date.now(), false)));
  if (plan === 'ask') {
    leave();
    ++flow;
    // the link stays in the address: a home-screen bookmark made now keeps it
    ui.askPair(p.pc, {
      here: () => {
        clearHash();
        void pair(p, key);
      },
      back: () => {
        clearHash();
        back();
      },
    });
    return;
  }
  clearHash();
  return pair(p, key);
}

async function pair(p: PairLink, key: string): Promise<void> {
  leave();
  const mine = ++flow;
  const title = `正在配对 ${p.pc || '电脑'}`;
  ui.busy(title, '正在准备…', { cancel: back });
  // before any dial: the code is single-use, a browser that cannot run the app must not spend it
  if (!(await appReady())) {
    if (mine === flow) ui.failed('配对没有成功', noWorker(), { back });
    return;
  }
  if (mine !== flow) return;
  const ac = new AbortController();
  pairing = ac;
  const busy = (step: DialState) => {
    if (mine === flow) ui.busy(title, STEP[step], { cancel: back });
  };
  busy('finding');
  try {
    const rec = await pairWith(p, dialer, busy, navigator.userAgent, { signal: ac.signal, rtcMissing });
    if (pairing === ac) pairing = null;
    setLocal(LINKS_KEY, JSON.stringify(rememberLink(linkMemory(), key, Date.now(), true)));
    await keep(rec);
    persist();
    if (mine === flow) void connect(rec, true);
  } catch (e) {
    if (pairing === ac) pairing = null;
    if (ac.signal.aborted) return;
    // refused by the PC (a wrong code, too many tries): this link is spent
    if (e instanceof ShellError && e.pcAnswered) setLocal(LINKS_KEY, JSON.stringify(rememberLink(linkMemory(), key, Date.now(), true)));
    if (mine === flow) ui.failed('配对没有成功', explain(e, { rtcMissing }), { retry: () => void pair(p, key), back });
  }
}

const relayBar = (): BarState => ({ text: SAY.relay, tone: 'warn', closable: true });

async function connect(d: DeviceRec, justPaired = false): Promise<void> {
  leave();
  const mine = ++flow;
  const title = `正在连接 ${d.pcName}`;
  ui.busy(title, STEP.finding, { cancel: back });
  const caches = await appReady();
  if (mine !== flow) return;
  if (!caches) return ui.failed('没连上', noWorker(), { retry: () => void connect(d), back });
  const s: Session = new Session({
    device: d,
    dialer,
    caches,
    scope,
    owner,
    justPaired,
    rtcMissing,
    onview: (v) => view(s, v, title),
    onopened: () => void keep({ ...d, lastAt: Date.now() }),
  });
  session = s;
  // before the frame exists: the app looks for it once, when it loads
  setTunnel(s);
  await s.start();
}

function view(s: Session, v: SessionView, title: string): void {
  if (s !== session) return;
  const open = s.isOpen;
  switch (v.k) {
    case 'dialing':
      if (open) ui.setBar({ text: `连接断了，正在重新连接：${STEP[v.step]}`, tone: 'warn', busy: true });
      else ui.busy(title, STEP[v.step], { cancel: back });
      return;
    case 'files': {
      const line = `正在取界面文件…（${v.done}/${v.total}）`;
      if (open) ui.setBar({ text: line, tone: 'info', busy: true });
      else ui.busy(title, line, { progress: v.total ? v.done / v.total : 0, cancel: back });
      return;
    }
    case 'open':
      ui.app(v.url, () => s.tunnel.closeAll());
      ui.setBar(v.kind === 'relay' ? relayBar() : null);
      return;
    case 'relinking':
      if (open) ui.setBar({ text: '连接断了，正在重新连接…', tone: 'warn', busy: true });
      else ui.busy(title, '连接断了，正在重新连接…', { cancel: back });
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
  // only our own service worker asks (a message from anything else is not answered at all)
  const src = ev.source as { scriptURL?: unknown } | null;
  if (!src || src.scriptURL !== SW_URL) return;
  const port = ev.ports[0];
  if (!port) return;
  const m = readShellRequest(ev.data);
  const s = session;
  // one this page cannot read (a newer service worker's) is a skip too: the worker is not left waiting 60 s
  if (!m || !s || !s.isOpen || (m.owner && m.owner !== owner)) return port.postMessage({ skip: true });
  s.serve(m).then(
    (r) => port.postMessage(r, r.body ? [r.body] : []),
    (e) => port.postMessage(replyFromError(e)),
  );
}

function clearHash(): void {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

/** A pairing link in the address: iOS Safari asks first and keeps it there; elsewhere it is taken (and cleared). */
function takePairLink(): boolean {
  const hash = location.hash;
  const plan = pairPlan({ ios, standalone, hasPairLink: /^#p=/.test(hash) });
  if (plan === 'list') return false;
  const p = parsePairLink(hash);
  if (!p) {
    clearHash();
    void showList({ text: SAY.badLink, raw: 'unreadable #p= link' });
  } else void takeLink(p, plan);
  return true;
}

// a phone that changed networks, or came back to this page: a link that has dropped is dialed again
window.addEventListener('online', () => void session?.redial());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void session?.redial();
});
// a QR scanned while the shell is already open in this tab only changes the fragment
window.addEventListener('hashchange', () => void takePairLink());

// installed early (its precache), whatever comes next
void appReady();
if (!takePairLink()) {
  void showList();
  persist();
}
