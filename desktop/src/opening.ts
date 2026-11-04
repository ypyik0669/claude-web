// 开场动画 (design kit 2026-11-03, claude-web-opening): what the main window shows while the server starts. The
// timeline, easing, sizes and colours are the kit's; everything is inside this one page (a data: URL), so nothing of
// it can reach the app's own styles. The status line is ours — the kit has no loading state: it stays empty on a
// normal start and is only filled in when the start is slow (`setOpeningNote`), so a fast start is just the opening.

/** The kit's logo (opening-logo.svg, unchanged). */
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Super"><path fill="#0B0B0C" d="M1024 512 L1024 643 L1023 689 L1022 723 L1021 751 L1019 775 L1016 796 L1014 816 L1010 833 L1007 849 L1003 864 L998 878 L993 891 L987 903 L981 914 L975 925 L968 934 L960 944 L952 952 L944 960 L934 968 L925 975 L914 981 L903 987 L891 993 L878 998 L864 1003 L849 1007 L833 1010 L816 1014 L796 1016 L775 1019 L751 1021 L723 1022 L689 1023 L643 1024 L512 1024 L381 1024 L335 1023 L301 1022 L273 1021 L249 1019 L228 1016 L208 1014 L191 1010 L175 1007 L160 1003 L146 998 L133 993 L121 987 L110 981 L99 975 L90 968 L80 960 L72 952 L64 944 L56 934 L49 925 L43 914 L37 903 L31 891 L26 878 L21 864 L17 849 L14 833 L10 816 L8 796 L5 775 L3 751 L2 723 L1 689 L0 643 L0 512 L0 381 L1 335 L2 301 L3 273 L5 249 L8 228 L10 208 L14 191 L17 175 L21 160 L26 146 L31 133 L37 121 L43 110 L49 99 L56 90 L64 80 L72 72 L80 64 L90 56 L99 49 L110 43 L121 37 L133 31 L146 26 L160 21 L175 17 L191 14 L208 10 L228 8 L249 5 L273 3 L301 2 L335 1 L381 0 L512 0 L643 0 L689 1 L723 2 L751 3 L775 5 L796 8 L816 10 L833 14 L849 17 L864 21 L878 26 L891 31 L903 37 L914 43 L925 49 L934 56 L944 64 L952 72 L960 80 L968 90 L975 99 L981 110 L987 121 L993 133 L998 146 L1003 160 L1007 175 L1010 191 L1014 208 L1016 228 L1019 249 L1021 273 L1022 301 L1023 335 L1024 381 Z"/><g transform="translate(92 452)"><g fill="#FFFFFF"><path d="M0 260 V0 H250 V110 H120 V260 Z"/><path d="M300 0 H420 L360 260 H240 Z"/><rect x="460" y="-140" width="120" height="400"/><circle cx="710" cy="130" r="130" fill="#FF5A1F"/></g></g></svg>';

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
 * The page. Light: the kit's warm white. Dark (the system is dark): the kit's layout on the app's dark ground, so a
 * dark app does not open on a white flash — Claude stays orange, Web turns light; the logo is the kit's as is.
 */
export function openingHtml(o: { dark: boolean; lang: 'zh' | 'en'; title: string; note?: string; waiting?: string }): string {
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
    `const motion=matchMedia('(prefers-reduced-motion: reduce)'),END=${OPENING_END_MS / 1000};`,
    'const clamp=(x)=>Math.max(0,Math.min(1,x));',
    'const ease=(x)=>{x=clamp(x);return clamp(x*x*x*(x*(x*6-15)+10));};',
    'let started=0,raf=0,waitT=0;',
    'function render(t){const intro=ease(t/.24),reveal=ease((t-.38)/.46),line=ease((t-.32)/.46),credit=ease((t-.85)/.32),fade=ease((t-.8)/.2);',
    'claude.style.opacity=String(intro);web.style.clipPath=`inset(0 ${(1-reveal)*100}% 0 0)`;stroke.style.transform=`scaleX(${line})`;',
    'stroke.style.opacity=String(1-fade);sig.style.opacity=String(credit);sig.style.transform=`translateY(${(1-credit)*5}px)`;}',
    'function tick(now){raf=0;const t=motion.matches?END:Math.min(END,(now-started)/1000);render(t);if(t<END)raf=requestAnimationFrame(tick);}',
    'function play(){cancelAnimationFrame(raf);raf=0;started=performance.now();render(motion.matches?END:0);if(!motion.matches)raf=requestAnimationFrame(tick);}',
    "motion.addEventListener('change',()=>{if(motion.matches){cancelAnimationFrame(raf);raf=0;render(END);}});",
    "addEventListener('pagehide',()=>cancelAnimationFrame(raf));",
    "window.__setNote=(s)=>{clearTimeout(waitT);const n=q('.op-note');n.textContent=s||'';n.classList.toggle('on',!!s);};",
    `waitT=setTimeout(()=>{const n=q('.op-note');if(!n.textContent){n.textContent=${JSON.stringify(o.waiting ?? '')};n.classList.toggle('on',!!n.textContent);}},${OPENING_WAITING_MS});`,
    'play();',
  ].join('');
  const note = o.note ?? '';
  return `<!doctype html><html lang="${o.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>${css}</style></head>`
    + '<body><main class="op-stage" aria-label="Claude Web · by Super"><div class="op-mark">'
    + '<h1 class="op-title"><span class="op-claude">Claude</span><span class="op-web">Web</span><span class="op-stroke" aria-hidden="true"></span></h1>'
    + `<div class="op-sig"><span><span class="op-by">by</span> Super</span><span class="op-logo">${LOGO}</span></div>`
    + `</div><div class="op-note${note ? ' on' : ''}" role="status">${esc(note)}</div></main><script>${js}</script></body></html>`;
}

/** The script that changes the status line of an opening already on screen (no reload: the animation is not replayed). */
export const setOpeningNote = (note: string) => `window.__setNote&&window.__setNote(${JSON.stringify(note)})`;

/** How long to hold the app back so the opening is seen through: what is left of OPENING_MIN_MS since `shownAt`. */
export const openingHold = (shownAt: number, now = Date.now()) => Math.max(0, OPENING_MIN_MS - (now - shownAt));
