// The phone check (redesign 2026-11 stage 1; first written for the plan's mobile audit): page code that looks at one
// screen of the app at phone width and says what a finger would trip over. ui-smoke's `phone` phase runs it at
// 390 × 844, 360 × 780 and 430 × 932, light and dark. Nothing here drives the app — the caller opens the screen.
//
//   const { auditJs } = require('./lib/phone-audit.cjs');
//   const r = await webContents.executeJavaScript(auditJs('.app.mobile .sidebar'));
//
// What it measures, inside `scope` — every element it matches (the top layer of the screen: the drawer, the page, the
// sheet, a page's head and tab row — what is under a scrim does not count):
//  - overflowX: how far the page scrolls sideways (must be 0; a table / code / diff scrolls in its own box)
//  - small: controls whose tap target is under 44 × 44 — tested the way a finger lands: points 21px left / right /
//    above / below the centre must reach the control itself (padding, a ::before, a row it fills all count)
//  - covered: controls whose centre is under something else
//  - off: controls sticking out of the window sideways (not inside a box that scrolls sideways)
//  - zoomInputs: text boxes under 16px (iOS zooms the page into them)
//  - tiny: text under 12px (counted, a few samples)
// A control counts when it is on screen: displayed, not transparent, not inert / aria-hidden, not disabled, bigger
// than a pixel (a visually-hidden one is for a screen reader), and its centre is inside every box that clips it (a
// row scrolled out of its list is not on screen).
'use strict';

function auditJs(scope, opts = {}) {
  const S = JSON.stringify(scope);
  const R = Number(opts.reach ?? 21);
  return `(() => {
    const vw = innerWidth, vh = innerHeight;
    // every element the scope matches (a page's head and its tab row are two), each control once
    const roots = [...document.querySelectorAll(${S})].filter((r, i, all) => !all.some((o, j) => j !== i && o.contains(r)));
    const out = { scope: ${S}, found: roots.length > 0, overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw, small: [], covered: [], off: [], zoomInputs: [], tiny: 0, tinySamples: [], controls: 0 };
    if (!roots.length) return out;
    const all = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
    const shown = (e) => {
      for (let p = e; p && p.nodeType === 1; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
        if (p.hasAttribute('inert') || p.getAttribute('aria-hidden') === 'true') return false;
      }
      const r = e.getBoundingClientRect();
      // (a control clipped to a pixel is the visually-hidden pattern — there for a screen reader, not for a finger)
      return r.width > 1 && r.height > 1;
    };
    // the part of the window a point must be in to be seen: every ancestor that clips (overflow other than visible)
    const clipBox = (e) => {
      let l = 0, t = 0, r = vw, b = vh;
      for (let p = e.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const q = p.getBoundingClientRect();
        l = Math.max(l, q.left); t = Math.max(t, q.top); r = Math.min(r, q.right); b = Math.min(b, q.bottom);
      }
      return { l, t, r, b };
    };
    const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || e.getAttribute('placeholder') || e.getAttribute('data-id') || e.className || e.tagName).toString().replace(/\\s+/g, ' ').trim().slice(0, 40);
    const scrollsX = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
    const owns = (e, x, y) => { if (x < 0 || y < 0 || x >= vw || y >= vh) return false; const h = document.elementFromPoint(x, y); return !!h && (h === e || e.contains(h)); };
    const SEL = 'button, a[href], input:not([type=hidden]), textarea, select, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"]';
    const controls = all(SEL).filter((e) => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && shown(e));
    for (const e of controls) {
      const r = e.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const c = clipBox(e);
      if (cx < c.l || cx > c.r || cy < c.t || cy > c.b) continue; // scrolled out of its box: not on screen
      out.controls++;
      if ((r.right > vw + 1 || r.left < -1) && !scrollsX(e)) out.off.push(name(e) + ' [' + Math.round(r.left) + '→' + Math.round(r.right) + ']');
      if (!owns(e, cx, cy)) { const h = document.elementFromPoint(cx, cy); out.covered.push(name(e) + ' ← ' + (h ? name(h) : '?')); continue; }
      // a point past the box that clips it (a tab half scrolled out of its row, the window's edge) cannot be measured:
      // the control goes on there — the other side still has to reach
      const reach = (x, y) => x < c.l || x > c.r || y < c.t || y > c.b || owns(e, x, y);
      // the sides a finger would miss, with what it would land on there instead
      const miss = [[-${R}, 0, '←'], [${R}, 0, '→'], [0, -${R}, '↑'], [0, ${R}, '↓']].filter(([dx, dy]) => !reach(cx + dx, cy + dy)).map(([dx, dy, a]) => { const h = document.elementFromPoint(cx + dx, cy + dy); return a + ' ' + (h ? name(h).slice(0, 18) : '-'); });
      if (miss.length) out.small.push(name(e) + ' ' + Math.round(r.width) + '×' + Math.round(r.height) + ' (' + miss.join(', ') + ')');
    }
    out.zoomInputs = all('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=color]):not([type=file]), textarea, select').filter(shown).filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => name(e) + ' ' + getComputedStyle(e).fontSize);
    for (const e of all('*')) {
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || !shown(e)) continue;
      const fs = parseFloat(getComputedStyle(e).fontSize);
      if (fs < 12) { out.tiny++; if (out.tinySamples.length < 6) out.tinySamples.push(name(e) + ' ' + fs + 'px'); }
    }
    return out;
  })()`;
}

/** The problems of one result, as lines (empty: nothing to fix). `tapTargets: false` checks all but the 44 rule. */
function problems(r, { tapTargets = true } = {}) {
  const bad = [];
  if (!r || !r.found) return [`nothing matches ${r ? r.scope : '?'}`];
  if (r.overflowX > 0) bad.push(`the page scrolls sideways by ${r.overflowX}px`);
  for (const x of r.off) bad.push(`out of the window: ${x}`);
  for (const x of r.covered) bad.push(`covered: ${x}`);
  if (tapTargets) for (const x of r.small) bad.push(`tap target under 44: ${x}`);
  for (const x of r.zoomInputs) bad.push(`text box under 16px: ${x}`);
  return bad;
}

module.exports = { auditJs, problems };
