// The phone shell (spec §6): pairs through the QR link, lists the paired PCs, dials one (direct first, the slow
// relay when that does not get through), and runs the app — fetched from that PC — in a same-origin frame whose
// WebSockets (window.__cwTunnel) and requests (the service worker, sw.ts) go over the link.
import './shell.css';
import { Brokers, b64u, dial, type BrokerDef, type DialState, type RtcCtor } from '@anywhere';
import { appCaches, type CachesLike } from './assets';
import { idbDevices, memoryDevices, type DeviceRec, type DeviceStore } from './devices';
import { SAY, type Explained } from './explain';
import { readShellRequest, replyFromError } from './forward';
import { BROKERS_KEY, STUN_KEY, brokerOverride, dialLists, overrideNote, stunOverride } from './override';
import {
  BAD_LISTS,
  HANDOFF_COOKIE,
  handoffClear,
  handoffCookie,
  linkKey,
  linkState,
  pairPlan,
  parsePairLink,
  rememberLink,
  startLink,
  type LinkMemory,
  type PairLink,
} from './pair-link';
import { Session, ShellError, explain, pairWith, type Dialer, type SessionView } from './session';
import { EMPTY_HOME, Ui, type BarState } from './ui';
import { tr } from './i18n';

const scope = new URL('./', location.href).href;
const SW_URL = new URL('sw.js', scope).href;
/** This window, on its app frame's address: the service worker hands that frame's requests to this window only. */
const owner = b64u(crypto.getRandomValues(new Uint8Array(9)));
const ui = new Ui(document.getElementById('root')!);
const rtc = (globalThis as unknown as { RTCPeerConnection?: RtcCtor }).RTCPeerConnection ?? null;
const rtcMissing = !rtc;
// tests and power users can replace both lists in localStorage (override.ts); read once, here, and said in the console
const override = { brokers: brokerOverride(local(BROKERS_KEY)), stun: stunOverride(local(STUN_KEY)) };
const note = overrideNote(override.brokers, override.stun);
if (note) console.info(note);
const HINT_KEY = 'cw.shell.iosHint';
const LINKS_KEY = 'cw.shell.pairLinks';
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
/** The shell's folder on its host: where the handoff cookie lives (pair-link.ts). */
const scopePath = new URL(scope).pathname;
const INSTALL_KEY = 'cw.shell.installBar';

// the home-screen icon (iOS reads it when the page is added), and everywhere but iOS a manifest: what has Android's
// browsers offer to install. Not on iOS: there a manifest's start_url would replace the address a home-screen app
// opens, #p= and all
for (const [rel, href] of [['apple-touch-icon', 'icon-192.png'], ...(ios ? [] : [['manifest', 'manifest.webmanifest']])]) {
  const l = document.createElement('link');
  l.rel = rel;
  l.href = href;
  document.head.append(l);
}

const STEP: Record<DialState, string> = {
  finding: tr('正在找电脑…'),
  connecting: tr('找到了，正在直连…'),
  relay: tr('直连没打通，正在改用慢速转发…'),
};

/** No RTCPeerConnection here (C4): the dial goes straight to the slow relay, so this is never constructed. */
const NoRtc = class {
  constructor() {
    throw new Error('RTCPeerConnection missing');
  }
} as unknown as RtcCtor;

/**
 * The broker pool of the PC being dialed: one PC at a time, so one pool, made again when a dial names other brokers
 * (another PC's lists; the pairing and the first connection after it share theirs).
 */
let pool: { key: string; brokers: Brokers } | null = null;

function brokersFor(list: BrokerDef[]): Brokers {
  const key = JSON.stringify(list);
  if (pool?.key !== key) {
    pool?.brokers.stop();
    pool = { key, brokers: new Brokers(list) };
  }
  return pool.brokers;
}

const dialer: Dialer = {
  dial(room, onstate, plan) {
    // the override, else the PC's own lists (its pairing link, its device record), else the defaults
    const lists = dialLists(override, plan.lists);
    const brokers = brokersFor(lists.brokers);
    // after a network change the old broker connections are likely dead: start them again at once
    if (plan.fresh) brokers.stop();
    brokers.start();
    return dial({ brokers, room, stun: lists.stun, rtc: rtc ?? NoRtc, forceRelay: rtcMissing, onstate, iceTimeoutMs: plan.iceMs });
  },
  idle() {
    pool?.brokers.stop();
  },
  restart() {
    pool?.brokers.stop();
    pool?.brokers.start();
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

function cookies(): string {
  try {
    return document.cookie;
  } catch {
    return '';
  }
}

function setCookie(assignment: string | null): void {
  if (!assignment) return;
  try {
    document.cookie = assignment;
  } catch {
    // cookies refused: the address and the paste field are left
  }
}

/** The pairing link's copy for a home-screen app (pair-link.ts: handoffCookie), removed once it has done its work. */
function clearHandoff(): void {
  if (cookies().includes(`${HANDOFF_COOKIE}=`)) setCookie(handoffClear(scopePath));
}

/** Called in the tap itself: iOS refuses a clipboard write that comes after an await. */
function copyText(text: string): Promise<boolean> {
  try {
    const w = navigator.clipboard?.writeText(text);
    return w ? w.then(() => true, () => false) : Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

/** 「从剪贴板粘贴」: read in the tap (iOS shows its own 粘贴 bubble first); declined or unavailable is null. */
const readClipboard = typeof navigator.clipboard?.readText === 'function' ? () => navigator.clipboard.readText().catch(() => null) : null;

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

/**
 * A device removed: its record and every PC's app caches (assets.appCaches: a removed PC may have rewritten the
 * others' cached app files; each PC's app comes over its link again on the next connect).
 */
async function forget(d: DeviceRec): Promise<void> {
  await store.remove(d.id).catch((e) => console.error('[shell] remove device:', e));
  const caches = cacheStorage();
  if (!caches) return;
  for (const k of appCaches(await caches.keys().catch(() => []))) await caches.delete(k).catch(() => false);
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
      if (p === BAD_LISTS) return SAY.badLists;
      // pasted here on purpose: pair here, whatever browser this is
      void takeLink(p, 'pair', { pasted: true });
      return null;
    },
    readClipboard,
    empty: ios && standalone ? EMPTY_HOME : undefined,
  });
}

/** Ends the connection and any pairing (the app frame with them); `rest`: no dial follows, the brokers close too. */
function leave(rest = false): void {
  pairing?.abort();
  pairing = null;
  session?.close();
  session = null;
  setTunnel(null);
  if (rest) dialer.idle();
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
 * A pairing link from the address, the handoff cookie or the paste field: one already used here, or past its 10
 * minutes, is not tried again (a home-screen app may reopen its saved address, #p= and all); on iOS Safari the user
 * chooses first (R12b). `raw`: the link as it came (`#p=…`), for the cookie and the clipboard.
 */
async function takeLink(p: PairLink, plan: 'ask' | 'pair', o: { pasted?: boolean; raw?: string } = {}): Promise<void> {
  const key = await linkKey(p);
  const state = linkState(linkMemory(), key, Date.now());
  if (state !== 'fresh') {
    clearHash();
    // a used link in the address is the home-screen bookmark opening again: just the list (it paired already)
    return showList(state === 'expired' ? { text: SAY.expiredLink, raw: '' } : o.pasted ? { text: SAY.usedLink, raw: '' } : null);
  }
  setLocal(LINKS_KEY, JSON.stringify(rememberLink(linkMemory(), key, Date.now(), false)));
  if (plan === 'ask') {
    leave();
    ++flow;
    const raw = o.raw ?? location.hash;
    // the link stays in the address, and goes into the cookie iOS copies into a home-screen app added now: that app
    // takes it from there on its first start (the address's #p= did not survive on a real iPhone)
    setCookie(handoffCookie(raw, scopePath));
    ui.askPair(p.pc, {
      here: () => {
        clearHandoff();
        clearHash();
        void pair(p, key);
      },
      back: () => {
        clearHandoff();
        clearHash();
        back();
      },
      copy: () => copyText(new URL(raw, location.href).href),
    });
    return;
  }
  clearHash();
  return pair(p, key);
}

async function pair(p: PairLink, key: string): Promise<void> {
  leave();
  const mine = ++flow;
  const title = tr('正在配对 {pc}', { pc: p.pc || tr('电脑') });
  ui.busy(title, tr('正在准备…'), { cancel: back });
  // before any dial: the code is single-use, a browser that cannot run the app must not spend it
  if (!(await appReady())) {
    if (mine === flow) ui.failed(tr('配对没有成功'), noWorker(), { back });
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
    if (mine === flow) ui.failed(tr('配对没有成功'), explain(e, { rtcMissing }), { retry: () => void pair(p, key), back });
  }
}

const relayBar = (): BarState => ({ text: SAY.relay, tone: 'warn', closable: true });

async function connect(d: DeviceRec, justPaired = false): Promise<void> {
  leave();
  const mine = ++flow;
  const title = tr('正在连接 {pcName}', { pcName: d.pcName });
  ui.busy(title, STEP.finding, { cancel: back });
  const caches = await appReady();
  if (mine !== flow) return;
  if (!caches) return ui.failed(tr('没连上'), noWorker(), { retry: () => void connect(d), back });
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
      if (open) ui.setBar({ text: tr('连接断了，正在重新连接：{v}', { v: STEP[v.step] }), tone: 'warn', busy: true });
      else ui.busy(title, STEP[v.step], { cancel: back });
      return;
    case 'files': {
      const line = tr('正在取界面文件…（{done}/{total}）', { done: v.done, total: v.total });
      if (open) ui.setBar({ text: line, tone: 'info', busy: true });
      else ui.busy(title, line, { progress: v.total ? v.done / v.total : 0, cancel: back });
      return;
    }
    case 'open':
      ui.app(v.url, () => s.tunnel.closeAll());
      ui.setBar(v.kind === 'relay' ? relayBar() : null);
      offerInstall();
      return;
    case 'relinking':
      if (open) ui.setBar({ text: tr('连接断了，正在重新连接…'), tone: 'warn', busy: true });
      else ui.busy(title, tr('连接断了，正在重新连接…'), { cancel: back });
      return;
    case 'linked':
      ui.setBar(v.kind === 'relay' ? relayBar() : null);
      offerInstall();
      return;
    case 'updating':
      ui.setBar({ text: tr('电脑上的 Claude Web 更新了，正在取新版本的界面文件…'), tone: 'info', busy: true });
      return;
    case 'refused':
      ui.setBar({ text: v.text, tone: 'warn', closable: true });
      return;
    case 'down':
      ui.setBar({ text: v.why.text, raw: v.why.raw, tone: 'err', actions: [{ label: tr('重新连接'), run: () => void s.redial() }, { label: tr('返回'), run: back }] });
      return;
    case 'failed':
      ui.failed(tr('没连上'), v.why, { retry: () => void connect(s.device), back });
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

/**
 * A pairing link in the address, or in a home-screen app the one the handoff cookie brought: iOS Safari asks first and
 * keeps it in the address; elsewhere it is taken (and cleared).
 */
function takePairLink(): boolean {
  const start = startLink({ hash: location.hash, cookies: cookies(), standalone });
  // a home-screen app takes the cookie's link once: from then on the link memory (pairLinks) answers for it
  if (standalone) clearHandoff();
  const plan = pairPlan({ ios, standalone, hasPairLink: !!start });
  if (plan === 'list' || !start) return false;
  const p = parsePairLink(start.link);
  if (!p || p === BAD_LISTS) {
    clearHash();
    void showList(p ? { text: SAY.badLists, raw: 'the link names a server list with nothing usable in it' } : { text: SAY.badLink, raw: `unreadable #p= link (from the ${start.from})` });
  } else void takeLink(p, plan, { raw: start.link });
  return true;
}

/** The browser's install prompt (beforeinstallprompt: Android's Chrome and the like), kept for our own button. */
type InstallPrompt = Event & { prompt(): Promise<unknown> };
let installEv: InstallPrompt | null = null;
let installBarShown = false;

/**
 * 安装到主屏幕, while the browser offers it: the list's card, and once a visit a bar over the open app when the bar has
 * nothing to say about the connection (its × keeps it away). On Android the installed app shares this browser's
 * storage, so it opens with the PCs paired here.
 */
function offerInstall(): void {
  ui.setInstall(installEv ? () => void install() : null);
  if (!installEv || installBarShown || local(INSTALL_KEY) === 'no' || !ui.barFree()) return;
  installBarShown = true;
  ui.setBar({
    text: tr('装到主屏幕，以后点图标就能用'),
    tone: 'info',
    actions: [
      {
        label: tr('安装'),
        run: () => {
          ui.setBar(null);
          void install();
        },
      },
    ],
    closable: true,
    onClose: () => setLocal(INSTALL_KEY, 'no'),
  });
}

async function install(): Promise<void> {
  const ev = installEv;
  if (!ev) return;
  // one prompt per event: the browser sends a new one when it would offer again
  installEv = null;
  ui.setInstall(null);
  await ev.prompt().catch((e) => console.error('[shell] install prompt:', e));
}

window.addEventListener('beforeinstallprompt', (e) => {
  // our own button (the list, the bar), not the browser's banner over the app
  e.preventDefault();
  installEv = e as InstallPrompt;
  offerInstall();
});
window.addEventListener('appinstalled', () => {
  installEv = null;
  ui.setInstall(null);
});

// a phone that changed networks, or came back to this page: a relay link's brokers start over at once, a link that
// has dropped is dialed again (Session.networkChanged / pageShown: only the first counts as a network change)
window.addEventListener('online', () => void session?.networkChanged());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void session?.pageShown();
});
// a QR scanned while the shell is already open in this tab only changes the fragment
window.addEventListener('hashchange', () => void takePairLink());

// installed early (its precache), whatever comes next
void appReady();
if (!takePairLink()) {
  void showList();
  persist();
}
