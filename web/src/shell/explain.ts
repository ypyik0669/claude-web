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
  /** The link works but the app's files did not come over it. */
  files: '没能从电脑取到界面文件：再试一次；还不行就在电脑上重启 Claude Web。',
  /** The link ended on a frame this page does not know (protocol:…): the two sides run different versions. */
  version: '手机上的页面和电脑上的 Claude Web 版本不一致：刷新这个页面，或更新电脑上的 Claude Web。',
  /** No service worker (a private window, an in-app browser): the app's files have nowhere to come from. */
  noWorker: '这个浏览器不能运行界面（可能是无痕模式或 App 里的浏览器）：换个浏览器打开这个页面。',
  /** A `#p=` that does not read. */
  badLink: '这个配对链接读不出来：在电脑上重新生成二维码，再扫一次。',
  /** A shell window that cannot be asked (service worker side). */
  noWindow: '连接电脑的页面没有回应：回到 Claude Web 重新连一次。',
} as const;

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}

const DIAL_CODES: readonly DialErrorCode[] = ['pc-silent', 'no-broker', 'unreachable'];

/** A failed dial (DialError's code); anything else counts as unreachable. */
export function explainDial(e: unknown): Explained {
  const code = (e as { code?: unknown } | null)?.code;
  const known = typeof code === 'string' && (DIAL_CODES as readonly string[]).includes(code);
  return { text: SAY[known ? (code as DialErrorCode) : 'unreachable'], raw: errText(e) };
}

/** The connection status once the dial ended on the slow relay. */
export function relayStatus(): string {
  return SAY.relay;
}

/** No RTCPeerConnection in this browser (C4): said, and the dial goes straight to the slow relay. */
export function noRtc(): Explained {
  return { text: SAY.unreachable, raw: 'RTCPeerConnection missing' };
}

export function explainFiles(e: unknown): Explained {
  return { text: SAY.files, raw: errText(e) };
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
