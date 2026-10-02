// What the shell says when something fails: a Chinese sentence for the user, the raw text kept underneath as 原文.
// Spec §10's four sentences verbatim. Shaped like the server's errors/explain.ts output (a sentence + 原文) so the
// merge can swap this table for @errors (ruling R12a: that alias does not exist on this branch).
import type { DialErrorCode } from '@anywhere';

export interface Explained {
  /** One line for the user. */
  text: string;
  /** What the code said (English, from the core or the PC), shown small as 原文. */
  raw: string;
}

export const SAY = {
  'pc-silent': '电脑没有回应：电脑可能关机、睡眠，或 Claude Web 没在运行。',
  'no-broker': '连不上牵线服务器：这个网络可能拦了，换个网络试试。',
  relay: '直连没打通，已改用慢速转发：文字能用，文件预览和上传不能用。',
  unreachable: '连不上。可以先用 IM 机器人（设置 → IM 机器人）。',
  /** Pairing: nobody answers in a pairing room once its code expired, was used, or a newer code replaced it. */
  pairSilent: '电脑没有回应这个二维码：二维码可能已过期（10 分钟有效）、已经用过，或电脑上又生成了新的。在电脑上重新生成二维码再扫一次。',
  /** The link works but the app's files did not come over it. */
  files: '没能从电脑取到界面文件：再试一次；还不行就在电脑上重启 Claude Web。',
  /** A first-screen file the PC refused over the slow relay (413: a single response is capped at 2 MB). */
  relayLimit: '慢速转发有大小限制（单个文件不能超过 2 MB），界面文件取不过来：换个网络让直连打通再试。',
  /** The link ended on a frame this page does not know (protocol:…): the two sides run different versions. */
  version: '手机上的页面和电脑上的 Claude Web 版本不一致：刷新这个页面，或更新电脑上的 Claude Web。',
  /** No service worker or Cache Storage (a private window, an in-app browser): the app's files have nowhere to go. */
  noWorker: '这个浏览器不能运行界面（可能是无痕模式或 App 里的浏览器）：换个浏览器打开这个页面。',
  /** A `#p=` that does not read. */
  badLink: '这个配对链接读不出来：在电脑上重新生成二维码，再扫一次。',
  /** A `#p=` this page already paired with, or one the PC already refused. */
  usedLink: '这个配对链接已经用过了：需要再配对的话，在电脑上重新生成二维码。',
  /** A `#p=` first seen more than 10 minutes ago that never paired. */
  expiredLink: '这个配对链接已过期（10 分钟有效）：在电脑上重新生成二维码再扫一次。',
  /** A shell window that cannot be asked (service worker side). */
  noWindow: '连接电脑的页面没有回应：回到 Claude Web 重新连一次。',
  /** The shell window did not answer within the service worker's 60 s. */
  timeout: '电脑那边太久没有回应（60 秒）。',
  /** An app/api/… address opened as a page of its own, not from the app frame: never sent to the PC. */
  forbidden: '这个地址只能在 Claude Web 的界面里打开。',
} as const;

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}

const DIAL_CODES: readonly DialErrorCode[] = ['pc-silent', 'no-broker', 'unreachable'];

export interface DialContext {
  /** This browser has no RTCPeerConnection: the dial was the slow relay only (C4), and 原文 says why. */
  rtcMissing?: boolean;
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
  return { text: SAY[dialCode(e) ?? 'unreachable'], raw: dialRaw(e, c) };
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
  [/response was cut off/i, '电脑那边的响应中断了。'],
  [/no data from the listener/i, '电脑那边太久没有回应，这个请求已放弃。'],
  [/link to the PC has ended/i, '到电脑的连接断了。'],
  [/more than \d+ streams/i, '同时进行的请求太多了，稍后再试。'],
  [/request (head )?cannot be (read|made)|ended the request without a response|cannot be read/i, '电脑那边没能处理这个请求。'],
];

export function explainPcError(raw: string): Explained {
  const hit = PC_ERRORS.find(([re]) => re.test(raw));
  return { text: hit ? hit[1] : '电脑那边没能完成这个请求。', raw };
}

/** The sentence with its original after it, for a plain-text answer: 「…。（原文：…）」. */
export function withRaw(x: Explained): string {
  return x.raw ? `${x.text}（原文：${x.raw}）` : x.text;
}
