// What the shell says when something fails: a Chinese sentence for the user, the raw text kept underneath as 原文.
// Spec §10's four sentences verbatim. Shaped like the server's errors/explain.ts output (a sentence + 原文), but kept
// as the shell's own small table on purpose (ruling R12a): it explains only what goes wrong with the link and the
// bridge, where @errors speaks of providers, server.log and proxies — none of which a phone has.
import type { DialErrorCode } from '@anywhere';
import { tr } from './i18n';

export interface Explained {
  /** One line for the user. */
  text: string;
  /** What the code said (English, from the core or the PC), shown small as 原文. */
  raw: string;
}

export const SAY = {
  'pc-silent': tr('电脑没有回应：电脑可能关机、睡眠，或 Claude Web 没在运行。'),
  'no-broker': tr('连不上牵线服务器：这个网络可能拦了，换个网络试试。'),
  relay: tr('直连没打通，已改用慢速转发：文字能用，文件预览和上传不能用。'),
  unreachable: tr('连不上。可以先用 IM 机器人（设置 → IM 机器人）。'),
  /** A paired PC's room is silent: off, asleep, not running — or this phone was revoked there (its room is gone). */
  deviceSilent: tr('电脑没有回应：电脑可能关机、睡眠，或 Claude Web 没在运行。如果在电脑上吊销了这台手机，需要重新扫码配对。'),
  /** Pairing: nobody answers in a pairing room once its code expired, was used, or a newer code replaced it. */
  pairSilent: tr('电脑没有回应这个二维码：二维码可能已过期（10 分钟有效）、已经用过，或电脑上又生成了新的。在电脑上重新生成二维码再扫一次。'),
  /** The link works but the app's files did not come over it. */
  files: tr('没能从电脑取到界面文件：再试一次；还不行就在电脑上重启 Claude Web。'),
  /** A first-screen file the PC refused over the slow relay (413: a single response is capped at 2 MB). */
  relayLimit: tr('慢速转发有大小限制（单个文件不能超过 2 MB），界面文件取不过来：换个网络让直连打通再试。'),
  /** The link ended on a frame this page does not know (protocol:…): the two sides run different versions. */
  version: tr('手机上的页面和电脑上的 Claude Web 版本不一致：刷新这个页面，或更新电脑上的 Claude Web。'),
  /** No service worker or Cache Storage (a private window, an in-app browser): the app's files have nowhere to go. */
  noWorker: tr('这个浏览器不能运行界面（可能是无痕模式或 App 里的浏览器）：换个浏览器打开这个页面。'),
  /** A `#p=` that does not read. */
  badLink: tr('这个二维码读不出来：在电脑上重新生成配对码，再扫一次。'),
  /** A `#p=` that reads, but the server list it carries has nothing usable in it. */
  badLists: tr('这个二维码里的服务器列表读不出来：在电脑上重新生成配对码，再扫一次。'),
  /** A `#p=` this page already paired with, or one the PC already refused. */
  usedLink: tr('这个二维码已经用过了：要再配对，在电脑上重新生成配对码。'),
  /** A `#p=` first seen more than 10 minutes ago that never paired. */
  expiredLink: tr('这个二维码已过期（10 分钟有效）：在电脑上重新生成配对码再扫一次。'),
  /** 扫码配对 read the 「只在局域网」 QR (only the PC's own /pair page takes it). */
  lanQr: tr('这是「只在局域网」的二维码：在电脑上切到「在哪都能用」再扫。'),
  /** 扫码配对 read a QR that is nothing of ours. */
  notPairQr: tr('这不是 Claude Web 的配对二维码。'),
  /** The camera was refused (here, or in the phone's settings). */
  cameraDenied: tr('没能打开相机：允许 Claude Web 使用相机后再试一次，或者用手机自带的相机扫码。'),
  /** No camera this page can use. */
  noCamera: tr('这台设备上没有能用的相机。'),
  /** The camera did not open for another reason. */
  cameraFailed: tr('相机打不开。'),
  /** A shell window that cannot be asked (service worker side). */
  noWindow: tr('连接电脑的页面没有回应：回到 Claude Web 重新连一次。'),
  /** The shell window did not answer within the service worker's 60 s. */
  timeout: tr('电脑那边太久没有回应（60 秒）。'),
  /** An app/api/… address opened as a page of its own, not from the app frame: never sent to the PC. */
  forbidden: tr('这个地址只能在 Claude Web 的界面里打开。'),
} as const;

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}

const DIAL_CODES: readonly DialErrorCode[] = ['pc-silent', 'no-broker', 'unreachable'];

export interface DialContext {
  /** This browser has no RTCPeerConnection: the dial was the slow relay only (C4), and 原文 says why. */
  rtcMissing?: boolean;
  /** A dial into a paired device's room: its silence may also mean this phone was revoked on the PC. */
  device?: boolean;
}

function dialCode(e: unknown): DialErrorCode | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (DIAL_CODES as readonly string[]).includes(code) ? (code as DialErrorCode) : null;
}

function dialRaw(e: unknown, c: DialContext): string {
  return c.rtcMissing ? `RTCPeerConnection missing; ${errText(e)}` : errText(e);
}

/** A failed dial (DialError's code); anything else counts as unreachable. */
export function explainDial(e: unknown, c: DialContext = {}): Explained {
  const code = dialCode(e) ?? 'unreachable';
  return { text: code === 'pc-silent' && c.device ? SAY.deviceSilent : SAY[code], raw: dialRaw(e, c) };
}

/** A failed dial into a pairing room: silence there means the QR, not the PC (its code is gone). */
export function explainPairDial(e: unknown, c: DialContext = {}): Explained {
  return dialCode(e) === 'pc-silent' ? { text: SAY.pairSilent, raw: dialRaw(e, c) } : explainDial(e, c);
}

/** The connection status once the dial ended on the slow relay. */
export function relayStatus(): string {
  return SAY.relay;
}

/** The app's files did not come: the relay's size limit (a 413) is said as that, anything else as a files failure. */
export function explainFiles(e: unknown): Explained {
  const status = (e as { status?: unknown } | null)?.status;
  return { text: status === 413 ? SAY.relayLimit : SAY.files, raw: errText(e) };
}

/** A link that ended on a protocol error (relay-link / bridge: `protocol: …`); null for any other end. */
export function explainLinkEnd(why: string): Explained | null {
  return why.startsWith('protocol:') ? { text: SAY.version, raw: why } : null;
}

/** The PC's (or the Mux's) English reason a request failed, in Chinese (R8c). */
const PC_ERRORS: [RegExp, string][] = [
  // the bridge could not reach the PC's own remote-access listener (it relays to 127.0.0.1:<port>)
  [/ECONNREFUSED/, tr('电脑上的远程访问没在运行：在电脑上打开 设置 → 手机与远程 →「允许其它设备访问」。')],
  [/response was cut off/i, tr('电脑那边的响应中断了。')],
  [/no data from the listener/i, tr('电脑那边太久没有回应，这个请求已放弃。')],
  [/link to the PC has ended/i, tr('到电脑的连接断了。')],
  [/more than \d+ streams/i, tr('同时进行的请求太多了，稍后再试。')],
  [/request (head )?cannot be (read|made)|ended the request without a response|cannot be read/i, tr('电脑那边没能处理这个请求。')],
];

export function explainPcError(raw: string): Explained {
  const hit = PC_ERRORS.find(([re]) => re.test(raw));
  return { text: hit ? hit[1] : tr('电脑那边没能完成这个请求。'), raw };
}

/** The sentence with its original after it, for a plain-text answer: 「…。（原文：…）」. */
export function withRaw(x: Explained): string {
  return x.raw ? tr('{text}（原文：{raw}）', { text: x.text, raw: x.raw }) : x.text;
}
