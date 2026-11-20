// 开场动画: what the main window shows while the server starts, as one self-contained page (a data: URL), so nothing
// of it can reach the app's own styles.
//
// - the classic one (design kit 2026-11-03, claude-web-opening): the 1.45 s wordmark 「Claude Web · by Super NB」;
//   its status line stays empty on a normal start and is only filled in when the start is slow (`setOpeningNote`);
// - the fancy ones (界面改版方案 第 7 版 #opening): a video pack — the built-in one is 「Claude Web 娘」, a 10 s film that
//   cuts to black at `logoAt`, where the logo lights up out of its last spark — or 点火 (no video: the logo drawn in
//   gold, filled, lit). Both end on the wordmark and wait there for the server, then the logo shrinks into the top-left
//   corner and the page hands over to the app (which fades in, `?opening=1`).
//
// Nothing here may import anything: the web app reuses this file (alias @opening) for 设置 › 外观 › 试放一次, and the
// page's script is `player.toString()` — it must not reach outside itself.

/** The kit's squircle and the three strokes of the r / slash / bar (opening-logo.svg). */
const SQ = 'M1024 512 L1024 643 L1023 689 L1022 723 L1021 751 L1019 775 L1016 796 L1014 816 L1010 833 L1007 849 L1003 864 L998 878 L993 891 L987 903 L981 914 L975 925 L968 934 L960 944 L952 952 L944 960 L934 968 L925 975 L914 981 L903 987 L891 993 L878 998 L864 1003 L849 1007 L833 1010 L816 1014 L796 1016 L775 1019 L751 1021 L723 1022 L689 1023 L643 1024 L512 1024 L381 1024 L335 1023 L301 1022 L273 1021 L249 1019 L228 1016 L208 1014 L191 1010 L175 1007 L160 1003 L146 998 L133 993 L121 987 L110 981 L99 975 L90 968 L80 960 L72 952 L64 944 L56 934 L49 925 L43 914 L37 903 L31 891 L26 878 L21 864 L17 849 L14 833 L10 816 L8 796 L5 775 L3 751 L2 723 L1 689 L0 643 L0 512 L0 381 L1 335 L2 301 L3 273 L5 249 L8 228 L10 208 L14 191 L17 175 L21 160 L26 146 L31 133 L37 121 L43 110 L49 99 L56 90 L64 80 L72 72 L80 64 L90 56 L99 49 L110 43 L121 37 L133 31 L146 26 L160 21 L175 17 L191 14 L208 10 L228 8 L249 5 L273 3 L301 2 L335 1 L381 0 L512 0 L643 0 L689 1 L723 2 L751 3 L775 5 L796 8 L816 10 L833 14 L849 17 L864 21 L878 26 L891 31 L903 37 L914 43 L925 49 L934 56 L944 64 L952 72 L960 80 L968 90 L975 99 L981 110 L987 121 L993 133 L998 146 L1003 160 L1007 175 L1010 191 L1014 208 L1016 228 L1019 249 L1021 273 L1022 301 L1023 335 L1024 381 Z';
const GL = ['M0 260 V0 H250 V110 H120 V260 Z', 'M300 0 H420 L360 260 H240 Z', 'M460 -140 H580 V260 H460 Z'];

/** The kit's logo (opening-logo.svg, unchanged). */
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Super NB"><path fill="#0B0B0C" d="${SQ}"/><g transform="translate(92 452)"><g fill="#FFFFFF"><path d="M0 260 V0 H250 V110 H120 V260 Z"/><path d="M300 0 H420 L360 260 H240 Z"/><rect x="460" y="-140" width="120" height="400"/><circle cx="710" cy="130" r="130" fill="#FF5A1F"/></g></g></svg>`;

/** The credit under the wordmark (界面改版方案 第 7 版: 「by Super」 became 「by Super NB」). */
export const OPENING_CREDIT = 'Super NB';

/** The kit's timeline ends at 1.45 s. */
export const OPENING_END_MS = 1450;
/**
 * A cold start is usually longer than the opening (measured: ~14 s for a dev build on this machine): once it has
 * played, a still screen for this much longer gets a quiet 「正在启动…」 line, so it does not read as frozen.
 */
export const OPENING_WAITING_MS = 3500;
/**
 * The app replaces the opening no earlier than this after the window opened: the animation reaches its end state and
 * is seen for a moment. A server that takes longer than this (the usual packaged cold start) costs nothing extra.
 */
export const OPENING_MIN_MS = 1600;

/** A video pack's film plays at most this long (opening.json `maxSeconds` may only make it shorter). */
export const OPENING_MAX_SECONDS = 12;
/** The video's logo phase: the wordmark is complete (and waits for the server) at HOLD, the logo has landed at END. */
export const LOGO_HOLD = 2.25;
export const LOGO_END = 2.95;
/** 点火: the wordmark starts at `word`, the logo waits at `out` and has landed at `end` (full length; 简短 plays it twice as fast). */
export const IGNITE = { word: 2.05, out: 3.7, end: 4.35 } as const;
export const IGNITE_SHORT_SPEED = 2;
/** The scheme the desktop shell serves pack files on to the opening page (desktop/src/opening-pack.ts). */
export const OPENING_SCHEME = 'cw-opening';
/**
 * Where the logo lands, in window pixels at zoom 1: the centre of the app's own logo, the app menu at the sidebar's
 * top-left (web Sidebar.tsx `BrandMenu`; before the redesign of 2026-11 it was the icon bar's first button, at 26). A
 * Mac's sidebar row starts after the traffic lights (styles.css `html.desktop.mac .sb-top`, 84px). ui-smoke measures
 * the sidebar's logo against both.
 */
export const LOGO_TARGET = { x: 28, y: 34, size: 20 } as const;
export const LOGO_TARGET_MAC = { x: 99, y: 34, size: 20 } as const;
export type LogoTarget = { x: number; y: number; size: number };
export function logoTarget(platform: string): LogoTarget { return platform === 'darwin' ? LOGO_TARGET_MAC : LOGO_TARGET; }

/** The kit's easing: quintic smoothstep. */
export function ease(x: number): number {
  const c = (v: number) => Math.max(0, Math.min(1, v));
  x = c(x);
  return c(x * x * x * (x * (x * 6 - 15) + 10));
}

/** Every animated value at `t` seconds (the kit's render()). */
export function frameAt(t: number) {
  const intro = ease(t / 0.24);
  const reveal = ease((t - 0.38) / 0.46);
  const line = ease((t - 0.32) / 0.46);
  const credit = ease((t - 0.85) / 0.32);
  const fade = ease((t - 0.8) / 0.2);
  return { claude: intro, webClip: (1 - reveal) * 100, stroke: line, strokeOpacity: 1 - fade, credit, creditY: (1 - credit) * 5 };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The classic page. Light: the kit's warm white. Dark (the system is dark): the kit's layout on the app's dark ground,
 * so a dark app does not open on a white flash — Claude stays orange, Web turns light; the logo is the kit's as is.
 * `still`: its last frame and nothing else (开场 set to 不放, or motion reduced in the app).
 */
export function openingHtml(o: { dark: boolean; lang: 'zh' | 'en'; title: string; note?: string; waiting?: string; still?: boolean }): string {
  const c = o.dark
    ? { bg: '#12110f', glow: '#1d1b18', web: '#e8e5df', by: '#8f8a83', note: '#868480' }
    : { bg: '#faf9f6', glow: '#ffffff', web: '#242b32', by: '#798087', note: '#8a857f' };
  const css = [
    `html,body{height:100%;margin:0;background:${c.bg};color:${c.web};-webkit-app-region:drag;user-select:none;cursor:default;overflow:hidden}`,
    '*{box-sizing:border-box}',
    `.op-stage{position:relative;width:100%;height:100%;background:radial-gradient(ellipse at 50% 44%,${c.glow} 0%,${c.glow}70 28%,transparent 64%);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}`,
    '.op-mark{position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)}',
    '.op-title{position:relative;display:flex;align-items:baseline;margin:0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(38px,8.2vw,86px);font-weight:400;line-height:1.2;letter-spacing:-.055em;white-space:nowrap}',
    '.op-claude{color:#d97757;opacity:0}',
    `.op-web{display:inline-block;margin-left:.22em;color:${c.web};clip-path:inset(0 100% 0 0)}`,
    '.op-stroke{position:absolute;left:0;right:0;bottom:.04em;height:2px;background:#d97757;transform:scaleX(0);transform-origin:left center}',
    '.op-sig{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:18px;font-size:clamp(19px,2.6vw,27px);font-weight:450;letter-spacing:-.025em;opacity:0}',
    `.op-by{color:${c.by};font-size:.8em;font-weight:400;margin-right:3px}`,
    '.op-logo{display:inline-block;flex:0 0 auto;width:clamp(56px,6.8vw,88px);height:clamp(56px,6.8vw,88px)}.op-logo svg{display:block;width:100%;height:100%}',
    `.op-note{position:absolute;left:0;right:0;bottom:44px;text-align:center;color:${c.note};font:13px "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;line-height:1.6;padding:0 24px;opacity:0;transition:opacity .4s}`,
    '.op-note.on{opacity:1}',
    '@media(max-width:600px){.op-sig{margin-top:12px;gap:8px}}',
    // dark: the logo's own black square would melt into the ground — a hairline around it, the SVG untouched
    o.dark ? '.op-logo{border-radius:23%;box-shadow:0 0 0 1px rgba(255,255,255,.14)}' : '',
  ].join('');
  // the kit's script, minus the preview tools (replay button, window.__opening); the media-query listener and the
  // frame loop end with the page (this page is replaced, never kept alive)
  const js = [
    "'use strict';",
    "const q=(s)=>document.querySelector(s),claude=q('.op-claude'),web=q('.op-web'),stroke=q('.op-stroke'),sig=q('.op-sig');",
    `const motion=matchMedia('(prefers-reduced-motion: reduce)'),still=${o.still ? 'true' : 'false'},END=${OPENING_END_MS / 1000};`,
    'const clamp=(x)=>Math.max(0,Math.min(1,x));',
    'const ease=(x)=>{x=clamp(x);return clamp(x*x*x*(x*(x*6-15)+10));};',
    'let started=0,raf=0,waitT=0;',
    'function render(t){const intro=ease(t/.24),reveal=ease((t-.38)/.46),line=ease((t-.32)/.46),credit=ease((t-.85)/.32),fade=ease((t-.8)/.2);',
    'claude.style.opacity=String(intro);web.style.clipPath=`inset(0 ${(1-reveal)*100}% 0 0)`;stroke.style.transform=`scaleX(${line})`;',
    'stroke.style.opacity=String(1-fade);sig.style.opacity=String(credit);sig.style.transform=`translateY(${(1-credit)*5}px)`;}',
    'function tick(now){raf=0;const t=still||motion.matches?END:Math.min(END,(now-started)/1000);render(t);if(t<END)raf=requestAnimationFrame(tick);}',
    'function play(){cancelAnimationFrame(raf);raf=0;started=performance.now();render(still||motion.matches?END:0);if(!still&&!motion.matches)raf=requestAnimationFrame(tick);}',
    "motion.addEventListener('change',()=>{if(motion.matches){cancelAnimationFrame(raf);raf=0;render(END);}});",
    "addEventListener('pagehide',()=>cancelAnimationFrame(raf));",
    "window.__setNote=(s)=>{clearTimeout(waitT);const n=q('.op-note');n.textContent=s||'';n.classList.toggle('on',!!s);};",
    `waitT=setTimeout(()=>{const n=q('.op-note');if(!n.textContent){n.textContent=${JSON.stringify(o.waiting ?? '')};n.classList.toggle('on',!!n.textContent);}},${OPENING_WAITING_MS});`,
    'play();',
  ].join('');
  const note = o.note ?? '';
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";
  return `<!doctype html><html lang="${o.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(o.title)}</title><style>${css}</style></head>`
    + `<body><main class="op-stage" aria-label="Claude Web · by ${OPENING_CREDIT}"><div class="op-mark">`
    + '<h1 class="op-title"><span class="op-claude">Claude</span><span class="op-web">Web</span><span class="op-stroke" aria-hidden="true"></span></h1>'
    + `<div class="op-sig"><span><span class="op-by">by</span> ${OPENING_CREDIT}</span><span class="op-logo">${LOGO}</span></div>`
    + `</div><div class="op-note${note ? ' on' : ''}" role="status">${esc(note)}</div></main><script>${js}</script></body></html>`;
}

/** The script that changes the status line of an opening already on screen (no reload: the animation is not replayed). */
export const setOpeningNote = (note: string) => `window.__setNote&&window.__setNote(${JSON.stringify(note)})`;

/** How long to hold the app back so the opening is seen through: what is left of OPENING_MIN_MS since `shownAt`. */
export const openingHold = (shownAt: number, now = Date.now()) => Math.max(0, OPENING_MIN_MS - (now - shownAt));

// ---------------------------------------------------------------------------------------------------------------
// the fancy openings

/** The texts of a fancy opening, already in the page's language. */
export interface OpeningTexts { skip: string; waiting: string; soundOn: string; soundOff: string; tap: string }

/** Everything the page's script gets (it has nothing else: no app styles, no network). */
export interface PlayerConfig {
  kind: 'video' | 'ignite';
  /** the desktop's window while the server starts, or 试放一次 over the app (an iframe) */
  mode: 'splash' | 'preview';
  /** 完整 / 简短 */
  full: boolean;
  sound: boolean;
  /** only the last frame: the app's own 减少动画 (the system's is read by the page itself) */
  reduced: boolean;
  /** 点火's palette: the ground it plays on is dark */
  dark: boolean;
  /** kind video: the film's address, the second its logo takes over (null: where the film ends), 简短's start */
  intro: string;
  logoAt: number | null;
  shortFrom: number;
  maxSeconds: number;
  target: { x: number; y: number; size: number };
  waitingMs: number;
  text: OpeningTexts;
}

export interface FancyOpeningOptions {
  kind: 'video' | 'ignite';
  mode?: 'splash' | 'preview';
  lang: 'zh' | 'en';
  title: string;
  full: boolean;
  sound: boolean;
  reduced?: boolean;
  /** the ground the page ends on: the app's shell ground ('transparent' in a preview: the app is right under it) */
  ground: string;
  dark: boolean;
  /** a preview: the app's own colour scheme — an iframe whose scheme differs from its page's gets an opaque canvas */
  colorScheme?: 'dark' | 'light';
  video?: { intro: string; logoAt?: number | null; shortFrom?: number | null; maxSeconds?: number | null };
  text: OpeningTexts;
  note?: string;
  /** where the logo lands (default LOGO_TARGET): the shell's `logoTarget(platform)`, a preview the app's logo on screen */
  target?: LogoTarget;
}

/** A pack's numbers made safe: the film at most OPENING_MAX_SECONDS, logoAt / shortFrom inside it. */
export function filmTimes(v: { logoAt?: unknown; shortFrom?: unknown; maxSeconds?: unknown }): { logoAt: number | null; shortFrom: number; maxSeconds: number } {
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const maxSeconds = Math.min(OPENING_MAX_SECONDS, num(v.maxSeconds) || OPENING_MAX_SECONDS);
  const logoAt = num(v.logoAt) === null ? null : Math.min(num(v.logoAt)!, maxSeconds);
  const end = logoAt ?? maxSeconds;
  const shortFrom = Math.min(num(v.shortFrom) ?? 0, Math.max(0, end - 1));
  return { logoAt, shortFrom, maxSeconds };
}

/** How long a fancy opening takes until its wordmark waits for the server, in ms (the shell's watchdog uses it). */
export function openingLength(o: { kind: 'video' | 'ignite'; full: boolean; logoAt?: number | null; shortFrom?: number; maxSeconds?: number }): number {
  if (o.kind === 'ignite') return (IGNITE.out / (o.full ? 1 : IGNITE_SHORT_SPEED)) * 1000;
  const t = filmTimes(o);
  return ((t.logoAt ?? t.maxSeconds) - (o.full ? 0 : t.shortFrom) + LOGO_HOLD) * 1000;
}

/**
 * A fancy opening's page: the film (kind video) or 点火, the logo, the wordmark, the sound button, the skip hint and
 * the status line. It tells the shell when it is done (`desktop.openingDone()`), waits for the server at its last
 * frame (`desktop.openingWait()`), and remembers a sound change (`desktop.openingSound()`); a preview tells its parent.
 */
export function fancyOpeningHtml(o: FancyOpeningOptions): string {
  const t = filmTimes(o.video ?? {});
  const cfg: PlayerConfig = {
    kind: o.kind, mode: o.mode ?? 'splash', full: o.full, sound: o.sound, reduced: !!o.reduced, dark: o.kind === 'video' ? true : o.dark,
    intro: o.video?.intro ?? '', logoAt: t.logoAt, shortFrom: t.shortFrom, maxSeconds: t.maxSeconds,
    target: { ...(o.target ?? LOGO_TARGET) }, waitingMs: OPENING_WAITING_MS, text: o.text,
  };
  const dark = cfg.dark;
  const preview = cfg.mode === 'preview';
  const video = o.kind === 'video';
  const word = dark ? { web: video ? '#f3eee6' : '#e8e5df', by: video ? '#b8b0a4' : '#8f8a83', byS: video ? '#8a8378' : '#77726b' } : { web: '#242b32', by: '#798087', byS: '#9aa0a6' };
  const glow = dark ? 'rgba(39,38,35,.85)' : 'rgba(255,255,255,.9)';
  const css = [
    o.colorScheme ? `:root{color-scheme:${o.colorScheme}}` : '',
    `html,body{height:100%;margin:0;overflow:hidden;background:${o.ground};user-select:none;cursor:default;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei UI",sans-serif}`,
    '*{box-sizing:border-box}[hidden]{display:none!important}',
    '.st{position:fixed;inset:0;overflow:hidden;cursor:pointer;outline:none}',
    // splash: a strip at the top still moves the window; everything else takes the click that skips
    preview ? '' : '.drag{position:absolute;left:0;right:0;top:0;height:36px;z-index:9;-webkit-app-region:drag}',
    '.film{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;background:#000}',
    '.blk{position:absolute;inset:0;z-index:2;background:#060505;opacity:0;pointer-events:none}',
    `.glow{position:absolute;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse 58% 52% at 50% 38%,${glow},transparent 72%)}`,
    '.cv{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}.cv.back{z-index:3}.cv.front{z-index:5}',
    '.stage{position:absolute;left:0;top:0;width:960px;height:600px;transform-origin:0 0;z-index:4;pointer-events:none}',
    '.center{position:absolute;left:0;top:0;width:960px;height:600px;transform-origin:480px 217px}',
    '.logo{position:absolute;left:405px;top:142px;width:150px;height:150px;overflow:visible}',
    `.sqf{stroke:${dark ? 'rgba(255,255,255,.16)' : 'transparent'};stroke-width:7}`,
    `.sql,.gl path,.dotl{fill:none;stroke:${dark ? '#e9bf6c' : '#b98a36'};stroke-width:14;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;opacity:0}`,
    '.gf{opacity:0}.dotf{transform-box:fill-box;transform-origin:center;opacity:0}',
    '.wb{position:absolute;left:0;top:0;width:960px;height:600px}',
    '.word{position:absolute;left:0;right:0;top:322px;display:flex;justify-content:center;font:400 60px/1.15 Georgia,"Times New Roman",serif;letter-spacing:-.055em;white-space:nowrap}',
    '.word .wm{position:relative;display:inline-flex;align-items:baseline}',
    '.word .c{color:#d97757;opacity:0}',
    `.word .w{margin-left:.22em;color:${word.web};clip-path:inset(0 100% 0 0)}`,
    '.word .u{position:absolute;left:0;right:0;bottom:.04em;height:2px;background:#d97757;transform:scaleX(0);transform-origin:left center}',
    `.by{position:absolute;left:0;right:0;top:410px;text-align:center;font:450 20px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.02em;color:${word.by};opacity:0}`,
    `.by span{color:${word.byS};font-size:.8em;margin-right:5px}`,
    '.bar{position:absolute;left:0;right:0;bottom:0;height:2px;z-index:6;background:rgba(255,255,255,.07);transition:opacity .4s}',
    '.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#d97757,#e9bf6c)}',
    '.snd{position:absolute;left:14px;bottom:14px;z-index:7;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:rgba(10,9,8,.5);color:#f3eee6;display:grid;place-items:center;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);transition:opacity .3s}',
    '.snd:hover{background:rgba(10,9,8,.72)}.snd:focus-visible{outline:2px solid #e9bf6c;outline-offset:2px}.snd[aria-pressed="true"]{color:#ffc46a}',
    `.hint{position:absolute;right:18px;bottom:17px;z-index:7;font-size:12px;color:${dark ? 'rgba(243,238,230,.75)' : 'rgba(36,43,50,.6)'};text-shadow:${dark ? '0 1px 3px rgba(0,0,0,.75)' : 'none'};pointer-events:none;animation:hint 3.4s forwards}`,
    '@keyframes hint{0%,72%{opacity:1}100%{opacity:0}}',
    '.tap{position:absolute;inset:0;z-index:8;display:grid;place-items:center;background:rgba(0,0,0,.22)}',
    '.tap span{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 20px;border-radius:999px;background:rgba(10,9,8,.68);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);font-size:14px;color:#f3eee6}',
    `.note{position:absolute;left:0;right:0;bottom:44px;z-index:7;text-align:center;color:${dark ? '#868480' : '#8a857f'};font:13px "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;line-height:1.6;padding:0 24px;opacity:0;transition:opacity .4s;pointer-events:none}`,
    '.note.on{opacity:1}',
  ].join('');
  const SND_OFF = '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const logo = '<svg class="logo" viewBox="0 0 1024 1024" aria-hidden="true">'
    + `<defs><clipPath id="risec"><rect class="rise" x="-20" y="1044" width="1064" height="1064"/></clipPath><clipPath id="sqc"><path d="${SQ}"/></clipPath>`
    + '<linearGradient id="sheen-g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'
    + `<path class="sqf" d="${SQ}" fill="#0B0B0C" clip-path="url(#risec)"/>`
    + `<g transform="translate(92 452)"><g class="gf" fill="#FFFFFF">${GL.map((d) => `<path d="${d}"/>`).join('')}</g></g>`
    + '<g clip-path="url(#sqc)"><rect class="sheen" x="-700" y="-120" width="300" height="1264" fill="url(#sheen-g)" transform="skewX(-18)"/></g>'
    + `<path class="sql" d="${SQ}" pathLength="1"/>`
    + `<g transform="translate(92 452)"><g class="gl">${GL.map((d) => `<path d="${d}" pathLength="1"/>`).join('')}</g>`
    + '<circle class="dotl" cx="710" cy="130" r="130" pathLength="1"/><circle class="dotf" cx="710" cy="130" r="130" fill="#FF5A1F"/></g></svg>';
  const note = o.note ?? '';
  const body = `<main class="st" aria-label="Claude Web · by ${OPENING_CREDIT}" tabindex="-1">`
    + (preview ? '' : '<div class="drag"></div>')
    + (video ? '<video class="film" muted playsinline preload="auto" aria-hidden="true"></video><div class="blk"></div>' : '<div class="glow"></div>')
    + '<canvas class="cv back"></canvas>'
    + `<div class="stage"><div class="center">${logo}<div class="wb"><div class="word"><span class="wm"><span class="c">Claude</span><span class="w">Web</span><i class="u"></i></span></div><div class="by"><span>by</span>${OPENING_CREDIT}</div></div></div></div>`
    + '<canvas class="cv front"></canvas>'
    + '<div class="bar"><i></i></div>'
    + (video ? `<button type="button" class="snd" aria-pressed="false" aria-label="${esc(o.text.soundOn)}">${SND_OFF}</button>` : '')
    + `<div class="hint">${esc(o.text.skip)}</div>`
    + `<div class="tap" hidden><span>${esc(o.text.tap)}</span></div>`
    + `<div class="note${note ? ' on' : ''}" role="status">${esc(note)}</div>`
    + '</main>';
  // `</` cannot end the script early: the config is JSON with `<` escaped
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  // nothing but its own script and styles, and the film: from the shell's scheme (a start) or the app's server (a preview)
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src ${preview ? 'http: https:' : `${OPENING_SCHEME}:`}`;
  return `<!doctype html><html lang="${o.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(o.title)}</title><style>${css}</style></head>`
    + `<body>${body}<script>(${player.toString()})(${json});</script></body></html>`;
}

/**
 * The page's script (serialized with toString(): nothing from outside this function exists in the page). Two scenes
 * share it: kind video (the reference player of the 第 7 版 pack, preview.html) and 点火 (the proposal's 轻量版).
 * Coordinates are the 960 × 600 stage of both references, scaled to fit the window; the canvases cover the window.
 */
function player(cfg: PlayerConfig): void {
  'use strict';
  const d = document;
  const q = <T extends Element>(s: string) => d.querySelector(s) as T | null;
  const st = q<HTMLElement>('.st')!;
  const film = q<HTMLVideoElement>('.film');
  const blk = q<HTMLElement>('.blk');
  const glowEl = q<HTMLElement>('.glow');
  const back = q<HTMLCanvasElement>('.cv.back')!;
  const front = q<HTMLCanvasElement>('.cv.front')!;
  const stage = q<HTMLElement>('.stage')!;
  const center = q<HTMLElement>('.center')!;
  const wb = q<HTMLElement>('.wb')!;
  const el = {
    sql: q<SVGPathElement>('.sql')!, gl: [...d.querySelectorAll<SVGPathElement>('.gl path')], dotl: q<SVGCircleElement>('.dotl')!,
    dotf: q<SVGCircleElement>('.dotf')!, rise: q<SVGRectElement>('.rise')!, gf: q<SVGGElement>('.gf')!, sheen: q<SVGRectElement>('.sheen')!,
    c: q<HTMLElement>('.word .c')!, w: q<HTMLElement>('.word .w')!, u: q<HTMLElement>('.word .u')!, by: q<HTMLElement>('.by')!,
    bar: q<HTMLElement>('.bar')!, fill: q<HTMLElement>('.bar i')!, snd: q<HTMLButtonElement>('.snd'), hint: q<HTMLElement>('.hint')!,
    tap: q<HTMLElement>('.tap')!, note: q<HTMLElement>('.note')!,
  };
  const bx = back.getContext('2d')!;
  const fx = front.getContext('2d')!;
  const video = cfg.kind === 'video';
  const W0 = 960, H0 = 600, LX = 405, LY = 142, KL = 150 / 1024;
  const P = (x: number, y: number, g: boolean) => ({ x: LX + (x + (g ? 92 : 0)) * KL, y: LY + (y + (g ? 452 : 0)) * KL });
  const DOT = P(710, 130, true);
  const E = (x: number) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * x * (x * (x * 6 - 15) + 10); };
  const R = (t: number, a: number, b: number) => E((t - a) / (b - a));
  const rnd = Math.random, TAU = Math.PI * 2;
  const HOLD = 2.25, LEND = 2.95;
  const IG = { word: 2.05, out: 3.7, end: 4.35 };
  const sp = video || cfg.full ? 1 : 2;
  const FW = [{ x: 250, y: 118 }, { x: 716, y: 104 }, { x: 178, y: 300 }, { x: 790, y: 286 }];
  const PAL = cfg.dark
    ? { gold: '#e9bf6c', tip: 'rgba(255,214,140,A)', glow: 'rgba(255,110,40,A)', ember: ['#fff3d4', '#ffc46a', '#ff8a3d', '#ff5a1f'], blend: 'lighter' as GlobalCompositeOperation }
    : { gold: '#a8741f', tip: 'rgba(214,150,50,A)', glow: 'rgba(255,120,50,A)', ember: ['#ffa53a', '#fb7d2c', '#ee5a24', '#b9410f'], blend: 'source-over' as GlobalCompositeOperation };
  const SND_ON = '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4M18.4 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const SND_OFF = '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const bridge = (window as any).desktop as { openingWait?: () => Promise<unknown>; openingDone?: () => void; openingSound?: (on: boolean) => void } | undefined;

  type Part = { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number; c: number };
  type Amb = { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number; p: number };
  let k = 1, ox = 0, oy = 0, vw = 0, vh = 0, dpr = 1;
  let phase: 'idle' | 'tap' | 'intro' | 'logo' | 'hold' | 'out' | 'end' = 'idle';
  let L = 0, T = 0, last = 0, raf = 0, t0 = 0, fired: Record<string, 1> = {}, LEN: number[] = [];
  let ready = cfg.mode === 'preview', lastCt = -1, lastCtWall = 0, introWall = 0, waitT = 0, sound = cfg.sound;
  const parts: Part[] = [], rings: { t: number; x: number; y: number; r: number }[] = [], amb: Amb[] = [];
  const dust: { x: number; y: number; v: number; s: number; p: number }[] = [];

  function layout() {
    vw = innerWidth; vh = innerHeight;
    k = Math.min(vw / W0, vh / H0) || 1; ox = (vw - W0 * k) / 2; oy = (vh - H0 * k) / 2;
    stage.style.transform = `translate(${ox}px,${oy}px) scale(${k})`;
    dpr = Math.min(2, devicePixelRatio || 1);
    for (const [c, x] of [[back, bx], [front, fx]] as const) {
      c.width = Math.max(1, Math.round(vw * dpr)); c.height = Math.max(1, Math.round(vh * dpr));
      x.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    }
  }
  const clear = (x: CanvasRenderingContext2D) => { x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, x.canvas.width, x.canvas.height); x.restore(); };
  // the window's edges in stage coordinates (embers and dust fill the window, not just the stage)
  const left = () => -ox / k, right = () => (vw - ox) / k, bottom = () => (vh - oy) / k;

  function once(key: string, cond: boolean, fn: () => void) { if (cond && !fired[key]) { fired[key] = 1; fn(); } }
  function burst(x: number, y: number, n: number, pw: number) {
    for (let i = 0; i < n; i++) { const a = rnd() * TAU, v = pw * (0.22 + rnd() * 0.78); parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - pw * 0.1, life: 0, max: 0.7 + rnd() * 1.15, s: 0.8 + rnd() * 2, c: rnd() }); }
  }
  function spark(x: number, y: number) { parts.push({ x, y, vx: (rnd() - 0.5) * 110, vy: (rnd() - 0.5) * 110 - 30, life: 0, max: 0.22 + rnd() * 0.38, s: 0.6 + rnd() * 1.1, c: rnd() }); }
  function step(dt: number) {
    const dk = Math.exp(-2.3 * dt);
    for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.life += dt; if (p.life >= p.max) { parts.splice(i, 1); continue; } p.vx *= dk; p.vy = p.vy * dk - 28 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
  }
  function drawParts(x: CanvasRenderingContext2D) {
    if (!parts.length) return;
    x.save(); x.globalCompositeOperation = PAL.blend; x.lineCap = 'round';
    for (const p of parts) {
      const kk = p.life / p.max;
      x.globalAlpha = Math.max(0, Math.pow(1 - kk, 1.25) * (0.72 + 0.28 * Math.sin(p.life * 40 + p.c * 20)));
      x.strokeStyle = PAL.ember[Math.min(3, (kk * 4) | 0)]; x.lineWidth = p.s * (1 - 0.45 * kk);
      x.beginPath(); x.moveTo(p.x - p.vx * 0.032, p.y - p.vy * 0.032); x.lineTo(p.x + 0.01, p.y); x.stroke();
    }
    x.restore();
  }
  function glowAt(x: CanvasRenderingContext2D, gx: number, gy: number, r: number, col: string, a: number) {
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, col.replace('A', String(a))); g.addColorStop(1, col.replace('A', '0'));
    x.save(); x.globalCompositeOperation = PAL.blend; x.fillStyle = g; x.beginPath(); x.arc(gx, gy, r, 0, TAU); x.fill(); x.restore();
  }
  function drawRings(x: CanvasRenderingContext2D, t: number) {
    for (const rg of rings) {
      const kk = (t - rg.t) / 0.8; if (kk < 0 || kk > 1) continue;
      x.save(); x.globalCompositeOperation = PAL.blend; x.globalAlpha = (1 - kk) * 0.7; x.strokeStyle = PAL.ember[1]; x.lineWidth = 3 * (1 - kk) + 0.5;
      x.beginPath(); x.arc(rg.x, rg.y, 12 + rg.r * E(kk), 0, TAU); x.stroke(); x.restore();
    }
  }
  function embers(x: CanvasRenderingContext2D, dt: number, a: number) {
    if (dt > 0 && rnd() < dt * 16) amb.push({ x: left() + rnd() * (right() - left()), y: bottom() + 6, vx: (rnd() - 0.5) * 12, vy: -(26 + rnd() * 40), life: 0, max: 4 + rnd() * 4, s: 0.8 + rnd() * 1.6, p: rnd() * TAU });
    x.save(); x.globalCompositeOperation = PAL.blend;
    for (let i = amb.length - 1; i >= 0; i--) {
      const e = amb[i]; e.life += dt; if (e.life > e.max || e.y < -oy / k - 8) { amb.splice(i, 1); continue; }
      e.x += (e.vx + Math.sin(e.life * 1.3 + e.p) * 8) * dt; e.y += e.vy * dt;
      const kk = e.life / e.max; x.globalAlpha = Math.max(0, a * Math.min(1, e.life * 2) * (1 - kk) * (0.6 + 0.4 * Math.sin(e.life * 6 + e.p)));
      x.fillStyle = PAL.ember[1 + (((kk * 3) | 0) % 3)]; x.beginPath(); x.arc(e.x, e.y, e.s, 0, TAU); x.fill();
    }
    x.restore();
  }
  function dustDraw(t: number, dt: number, a: number) {
    if (!dust.length) for (let i = 0; i < 60; i++) dust.push({ x: left() + rnd() * (right() - left()), y: rnd() * bottom(), v: 4 + rnd() * 10, s: 0.6 + rnd() * 1.4, p: rnd() * TAU });
    bx.save(); bx.globalCompositeOperation = PAL.blend; bx.fillStyle = PAL.gold;
    for (const m of dust) {
      m.y -= m.v * dt; if (m.y < -oy / k - 4) { m.y = bottom() + 4; m.x = left() + rnd() * (right() - left()); }
      bx.globalAlpha = Math.max(0, a * (0.18 + 0.14 * Math.sin(t * 2 + m.p))); bx.beginPath(); bx.arc(m.x, m.y, m.s, 0, TAU); bx.fill();
    }
    bx.restore();
  }
  type LogoState = { ls: number; lg: number[]; ld: number; la: number; rise: number; gf: number; da: number; ds: number; sh: number };
  function setLogo(o: LogoState) {
    el.sql.style.strokeDashoffset = String(1 - o.ls); el.sql.style.opacity = String(o.ls > 0 ? o.la : 0);
    el.gl.forEach((p, i) => { p.style.strokeDashoffset = String(1 - o.lg[i]); p.style.opacity = String(o.lg[i] > 0 ? o.la : 0); });
    el.dotl.style.strokeDashoffset = String(1 - o.ld); el.dotl.style.opacity = String(o.ld > 0 ? o.la : 0);
    el.rise.setAttribute('y', String(1044 - 1064 * o.rise));
    el.gf.style.opacity = String(o.gf);
    el.dotf.style.opacity = String(o.da); el.dotf.style.transform = `scale(${o.ds})`;
    el.sheen.setAttribute('x', String(o.sh < 0 ? -700 : -420 + 1760 * o.sh));
  }
  const DONE: LogoState = { ls: 1, lg: [1, 1, 1], ld: 0, la: 0, rise: 1, gf: 1, da: 1, ds: 1, sh: -1 };
  function word(t: number) {
    const i = E(t / 0.24), reveal = E((t - 0.38) / 0.46), line = E((t - 0.32) / 0.46), credit = E((t - 0.85) / 0.32), fade = E((t - 0.8) / 0.2);
    el.c.style.opacity = String(i); el.w.style.clipPath = `inset(0 ${(1 - reveal) * 100}% 0 0)`;
    el.u.style.transform = `scaleX(${line})`; el.u.style.opacity = String(1 - fade);
    el.by.style.opacity = String(credit); el.by.style.transform = `translateY(${(1 - credit) * 5}px)`;
  }
  /** the logo on its way to the top-left corner (p 0 → 1), in stage units around its centre (480, 217) */
  function flight(p: number) {
    if (p <= 0) return 'none';
    const tx = (cfg.target.x - ox) / k, ty = (cfg.target.y - oy) / k;
    const s = 1 + (cfg.target.size / (150 * k) - 1) * p;
    return `translate(${(tx - 480) * p}px,${(ty - 217) * p}px) scale(${s})`;
  }
  function geom() { LEN = [el.sql, ...el.gl, el.dotl].map((p) => p.getTotalLength()); }
  function tips(x: CanvasRenderingContext2D, segs: [SVGGeometryElement, number, boolean, number][], dt: number) {
    for (const [elm, v, g, i] of segs) {
      if (v <= 0 || v >= 1) continue;
      const pt = elm.getPointAtLength(v * LEN[i]), p = P(pt.x, pt.y, g);
      glowAt(x, p.x, p.y, 13, PAL.tip, 0.85);
      if (dt > 0 && rnd() < 0.85) spark(p.x, p.y);
    }
  }

  // ---- kind video: the logo phase, t seconds after the film went black (the reference's renderLogo)
  function renderLogo(t: number, dt: number) {
    clear(bx);
    // the dot's glow dies down to a fifth, and goes with the logo when it flies (not left behind in the middle)
    const g0 = R(t, 0, 0.2) * (1 - 0.8 * R(t, 0.45, 1.5)) * (1 - R(t, HOLD, HOLD + 0.35));
    if (g0 > 0.01) glowAt(bx, DOT.x, DOT.y, 34 + 86 * R(t, 0, 0.32), 'rgba(255,214,150,A)', 0.95 * g0);
    once('burst', t >= 0.2, () => { burst(DOT.x, DOT.y, 230, 330); rings.push({ t, x: DOT.x, y: DOT.y, r: 320 }); });
    const o: LogoState = { ls: R(t, 0.24, 0.64), lg: [R(t, 0.36, 0.68), R(t, 0.44, 0.74), R(t, 0.5, 0.8)], ld: 0, la: 1 - R(t, 0.98, 1.3), rise: R(t, 0.64, 1.0), gf: R(t, 0.8, 1.0), da: R(t, 0.17, 0.24), ds: 1, sh: t > 1.0 && t < 1.55 ? (t - 1.0) / 0.55 : -1 };
    o.ds = t < 0.4 ? 0.3 + 0.95 * R(t, 0.18, 0.4) : 1.25 - 0.25 * R(t, 0.4, 0.62);
    setLogo(o);
    if (t < 0.85) tips(bx, [[el.sql, o.ls, false, 0], [el.gl[0], o.lg[0], true, 1], [el.gl[1], o.lg[1], true, 2], [el.gl[2], o.lg[2], true, 3]], dt);
    word(t - 1.02);
    const pr = R(t, HOLD, LEND);
    center.style.opacity = String(1 - R(t, 2.65, LEND));
    center.style.transform = flight(pr);
    wb.style.opacity = String(1 - R(t, HOLD, 2.53));
    // the film's last frame gives way to black (the built-in film is black there already), black to the app's ground
    blk!.style.opacity = String(Math.min(R(t, 0, 0.25), 1 - pr));
    if (film && t > 0.3 && film.style.opacity !== '0') film.style.opacity = '0';
    embers(bx, dt, 1 - R(t, 2.3, 2.9));
    step(dt); drawParts(bx); drawRings(bx, t);
  }

  // ---- 点火: T seconds into the scene (the proposal's ignite())
  function renderIgnite(t: number, dt: number) {
    clear(bx); clear(fx);
    if (t < IG.out + 0.3) {
      const o: LogoState = { ls: R(t, 0.1, 0.7), lg: [R(t, 0.34, 0.76), R(t, 0.44, 0.84), R(t, 0.5, 0.9)], ld: R(t, 0.58, 0.98), la: 1 - R(t, 1.2, 1.6), rise: R(t, 0.95, 1.4), gf: R(t, 1.15, 1.45), da: R(t, 1.5, 1.6), ds: 1, sh: t > 1.28 && t < 1.92 ? (t - 1.28) / 0.64 : -1 };
      o.ds = t < 1.74 ? 0.25 + R(t, 1.55, 1.74) : 1.25 - 0.25 * R(t, 1.74, 1.98);
      setLogo(o);
      if (t < 1.0) tips(fx, [[el.sql, o.ls, false, 0], [el.gl[0], o.lg[0], true, 1], [el.gl[1], o.lg[1], true, 2], [el.gl[2], o.lg[2], true, 3], [el.dotl, o.ld, true, 4]], dt);
      const gA = R(t, 1.55, 1.7) * (1 - 0.75 * R(t, 1.95, 2.8));
      if (gA > 0.01) glowAt(fx, DOT.x, DOT.y, 70, PAL.glow, 0.55 * gA);
      once('burst', t >= 1.62, () => { burst(DOT.x, DOT.y, cfg.full ? 240 : 150, 310); rings.push({ t, x: DOT.x, y: DOT.y, r: 250 }); });
      if (cfg.full) FW.forEach((f, i) => once(`fw${i}`, t >= 1.98 + i * 0.14, () => { burst(f.x, f.y, 74, 215); rings.push({ t, x: f.x, y: f.y, r: 110 }); }));
    }
    dustDraw(t, dt, 1 - 0.6 * R(t, 2.4, 3.4));
    word(t - IG.word);
    const p = R(t, IG.out, IG.end);
    center.style.transform = flight(p);
    center.style.opacity = String(1 - R(t, IG.out + 0.4, IG.end));
    wb.style.opacity = String(1 - R(t, IG.out, IG.out + 0.28));
    if (glowEl) glowEl.style.opacity = String(1 - p);
    step(dt); drawParts(fx); drawRings(fx, t);
  }

  function report(what: 'done' | 'sound', v?: boolean) {
    try {
      if (cfg.mode === 'splash') { if (what === 'done') bridge?.openingDone?.(); else bridge?.openingSound?.(!!v); }
      else parent.postMessage({ cwOpening: what, value: v }, '*');
    } catch { /* the shell went away: nothing to tell */ }
  }
  function setNote(s: string) { el.note.textContent = s || ''; el.note.classList.toggle('on', !!s); }
  (window as any).__setNote = (s: string) => { clearTimeout(waitT); setNote(s); };
  function progress(v: number) { el.fill.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`; }
  function filmEnd() {
    const dur = film && Number.isFinite(film.duration) ? film.duration : Infinity;
    return Math.min(cfg.logoAt ?? Infinity, cfg.maxSeconds, dur);
  }
  function showSound() {
    if (!el.snd) return;
    el.snd.setAttribute('aria-pressed', String(sound));
    el.snd.setAttribute('aria-label', sound ? cfg.text.soundOff : cfg.text.soundOn);
    el.snd.innerHTML = sound ? SND_ON : SND_OFF;
  }

  function enterLogo() {
    if (!video) return;
    phase = 'logo'; L = 0; fired = {}; parts.length = 0; rings.length = 0; amb.length = 0;
    if (!LEN.length) geom();
    film?.pause();
    center.style.opacity = '1'; center.style.transform = 'none'; wb.style.opacity = '1';
    setLogo({ ls: 0, lg: [0, 0, 0], ld: 0, la: 1, rise: 0, gf: 0, da: 0, ds: 0.3, sh: -1 }); word(-1);
  }
  /** the wordmark complete: wait here for the server (a line after a while), then fly */
  function enterHold() {
    phase = 'hold';
    el.hint.hidden = true;
    if (ready) { startOut(); return; }
    clearTimeout(waitT);
    waitT = setTimeout(() => { if (phase === 'hold' && !el.note.textContent) setNote(cfg.text.waiting); }, cfg.waitingMs) as unknown as number;
  }
  function startOut() {
    clearTimeout(waitT);
    setNote('');
    el.bar.style.opacity = '0';
    if (el.snd) el.snd.style.opacity = '0';
    // motion reduced: no flight, the app comes in at once; hidden: nobody to fly for (and no frames would come)
    if (reduced() || d.hidden) { finish(); return; }
    phase = 'out';
    kick();
  }
  function finish() {
    phase = 'end';
    cancelAnimationFrame(raf); raf = 0;
    film?.pause();
    report('done');
  }
  /** straight to the last frame (a click, a key, the window hidden, motion reduced) */
  function toHold() {
    parts.length = 0; rings.length = 0;
    fired = { burst: 1, fw0: 1, fw1: 1, fw2: 1, fw3: 1 };
    el.tap.hidden = true;
    if (!LEN.length) geom();
    if (video) {
      film?.pause();
      if (film) film.style.opacity = '0';
      L = HOLD; phase = 'logo';
      renderLogo(HOLD, 0);
      blk!.style.opacity = '1';
    } else {
      T = IG.out; renderIgnite(IG.out, 0);
    }
    setLogo(DONE); word(9);
    progress(1);
    enterHold();
  }
  const reduced = () => cfg.reduced || reduce.matches;

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    if (phase === 'intro' && film) {
      const t = film.currentTime;
      if (t > lastCt + 0.01) { lastCt = t; lastCtWall = now; }
      const end = filmEnd();
      progress(Number.isFinite(end) ? (t - t0) / (end - t0 + HOLD) : 0);
      // the film over (its logoAt, its end, 12 s), or stuck: the logo takes over
      if (t >= end || film.ended || now - lastCtWall > 6000 || now - introWall > ((Number.isFinite(end) ? end : cfg.maxSeconds) - t0 + 8) * 1000) enterLogo();
    }
    if (video && (phase === 'logo' || phase === 'hold' || phase === 'out')) {
      if (phase === 'logo') { L = Math.min(HOLD, L + dt); if (L >= HOLD) enterHold(); }
      else if (phase === 'out') { L = Math.min(LEND, L + dt); }
      renderLogo(L, dt);
      const end = filmEnd();
      if (phase === 'logo' && Number.isFinite(end)) progress((end - t0 + L) / (end - t0 + HOLD));
      if (phase === 'out' && L >= LEND) { finish(); return; }
    }
    if (!video && (phase === 'logo' || phase === 'hold' || phase === 'out')) {
      if (phase === 'logo') { T = Math.min(IG.out, T + dt * sp); progress(T / IG.out); if (T >= IG.out) enterHold(); }
      else if (phase === 'out') T = Math.min(IG.end, T + dt * sp);
      renderIgnite(T, dt * sp);
      if (phase === 'out' && T >= IG.end) { finish(); return; }
    }
    // (a kick() during this frame has already asked for the next one)
    if (!raf && phase !== 'end' && phase !== 'idle' && phase !== 'tap') raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf && phase !== 'end') { last = performance.now(); raf = requestAnimationFrame(frame); } }

  function playFilm() {
    if (!film) return;
    const p = film.play();
    if (p && p.catch) p.catch(() => {
      if (phase !== 'intro') return;
      // with sound, a page may not start by itself: without it then, the button can turn it back on
      if (!film.muted) { film.muted = true; sound = false; showSound(); film.play().catch(() => { if (phase === 'intro') { phase = 'tap'; el.tap.hidden = false; } }); return; }
      phase = 'tap'; el.tap.hidden = false;
    });
  }
  function start() {
    layout();
    showSound();
    // motion reduced: the last frame only; no film plays, so no sound button and no progress line either
    if (reduced()) { el.hint.hidden = true; el.bar.style.opacity = '0'; if (el.snd) el.snd.hidden = true; toHold(); return; }
    if (video && film) {
      phase = 'intro';
      t0 = cfg.full ? 0 : cfg.shortFrom;
      film.muted = !sound;
      film.addEventListener('loadedmetadata', () => { if (phase === 'intro' && film.currentTime < t0 - 0.2) film.currentTime = t0; }, { once: true });
      film.addEventListener('error', () => { if (phase === 'intro') { enterLogo(); kick(); } });
      film.src = cfg.intro;
      try { film.currentTime = t0; } catch { /* set again once the metadata is in */ }
      introWall = lastCtWall = performance.now();
      playFilm();
    } else {
      phase = 'logo'; T = 0;
      geom();
    }
    kick();
  }
  function skip() {
    if (phase === 'tap') { el.tap.hidden = true; phase = 'intro'; introWall = lastCtWall = performance.now(); playFilm(); kick(); return; }
    if (phase === 'intro' || phase === 'logo') toHold();
    else if (phase === 'hold' && ready) startOut();
  }
  st.addEventListener('click', skip);
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.target === el.snd || e.ctrlKey || e.metaKey || e.altKey || ['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock'].includes(e.key)) return;
    e.preventDefault();
    skip();
  });
  el.snd?.addEventListener('click', (e) => {
    e.stopPropagation();
    sound = !sound;
    if (film) film.muted = !sound;
    showSound();
    report('sound', sound);
  });
  // hidden (minimized, put away to the tray) in the middle: there is nobody to play it to
  d.addEventListener('visibilitychange', () => { if (d.hidden && (phase === 'intro' || phase === 'logo')) toHold(); });
  window.addEventListener('resize', () => { layout(); if (phase === 'hold' || phase === 'end') { if (video) renderLogo(L, 0); else renderIgnite(T, 0); } });
  window.addEventListener('pagehide', () => { cancelAnimationFrame(raf); film?.pause(); });
  // the server is up (the splash asks the shell; a preview has nothing to wait for)
  if (cfg.mode === 'splash') {
    const w = bridge?.openingWait?.();
    if (w && typeof w.then === 'function') w.then(() => { ready = true; if (phase === 'hold') startOut(); }, () => { /* the shell reports the failure itself */ });
    else ready = true;
  }
  start();
}
