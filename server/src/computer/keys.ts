/**
 * Key strings → Windows virtual keys. The syntax is xdotool's, which is what models write for the `key` tool:
 * names joined with "+" for a combination ("ctrl+shift+s", "alt+Tab", "Return"), several combinations separated by
 * spaces ("ctrl+a BackSpace"), a single character for its key.
 *
 * Pure: the helper presses what comes out, in order, and releases in reverse. What this does not know is refused
 * with a sentence the model can act on — a silently wrong key is worse than no key.
 *
 * Punctuation assumes a US layout (what VK_OEM_* means on other layouts differs); text belongs in the `type` tool,
 * which does not depend on the layout or on an input method.
 */

export interface KeyStroke {
  /** virtual-key code */
  vk: number;
  /** an extended key (arrows, Insert / Delete / Home / End / Page keys, right-hand modifiers, the Windows keys) */
  ext?: boolean;
}

/** One combination: pressed left to right, released right to left. */
export type Chord = KeyStroke[];

export type KeysResult = { ok: true; chords: Chord[] } | { ok: false; error: string };

const VK = { SHIFT: 0x10, CONTROL: 0x11, ALT: 0x12, LWIN: 0x5b, RWIN: 0x5c, DELETE: 0x2e, L: 0x4c };

const k = (vk: number, ext = false): KeyStroke => (ext ? { vk, ext: true } : { vk });

/** Modifier names (already lowercased, without "_"). */
const MODIFIERS: Record<string, KeyStroke> = {
  ctrl: k(VK.CONTROL), control: k(VK.CONTROL), ctl: k(VK.CONTROL),
  lctrl: k(0xa2), lcontrol: k(0xa2), controll: k(0xa2), ctrll: k(0xa2),
  rctrl: k(0xa3, true), rcontrol: k(0xa3, true), controlr: k(0xa3, true), ctrlr: k(0xa3, true),
  shift: k(VK.SHIFT), lshift: k(0xa0), shiftl: k(0xa0), rshift: k(0xa1), shiftr: k(0xa1),
  alt: k(VK.ALT), lalt: k(0xa4), altl: k(0xa4), ralt: k(0xa5, true), altr: k(0xa5, true), altgr: k(0xa5, true),
  win: k(VK.LWIN, true), windows: k(VK.LWIN, true), super: k(VK.LWIN, true), meta: k(VK.LWIN, true),
  lwin: k(VK.LWIN, true), superl: k(VK.LWIN, true), metal: k(VK.LWIN, true),
  rwin: k(VK.RWIN, true), superr: k(VK.RWIN, true), metar: k(VK.RWIN, true),
};

/** Named keys (lowercased, without "_"). */
const NAMED: Record<string, KeyStroke> = {
  return: k(0x0d), enter: k(0x0d), kpenter: k(0x0d, true),
  tab: k(0x09), escape: k(0x1b), esc: k(0x1b), space: k(0x20), spacebar: k(0x20),
  backspace: k(0x08), delete: k(VK.DELETE, true), del: k(VK.DELETE, true), insert: k(0x2d, true), ins: k(0x2d, true),
  home: k(0x24, true), end: k(0x23, true),
  pageup: k(0x21, true), pgup: k(0x21, true), prior: k(0x21, true),
  pagedown: k(0x22, true), pgdn: k(0x22, true), pgdown: k(0x22, true), next: k(0x22, true),
  left: k(0x25, true), up: k(0x26, true), right: k(0x27, true), down: k(0x28, true),
  arrowleft: k(0x25, true), arrowup: k(0x26, true), arrowright: k(0x27, true), arrowdown: k(0x28, true),
  capslock: k(0x14), numlock: k(0x90, true), scrolllock: k(0x91), pause: k(0x13), break: k(0x13),
  print: k(0x2c, true), printscreen: k(0x2c, true), prtsc: k(0x2c, true), prtscn: k(0x2c, true), sysrq: k(0x2c, true),
  menu: k(0x5d, true), apps: k(0x5d, true), contextmenu: k(0x5d, true),
  kpmultiply: k(0x6a), multiply: k(0x6a), kpadd: k(0x6b), add: k(0x6b),
  kpsubtract: k(0x6d), subtract: k(0x6d), kpdecimal: k(0x6e), decimal: k(0x6e), kpdivide: k(0x6f, true), divide: k(0x6f, true),
  volumemute: k(0xad, true), mute: k(0xad, true), xf86audiomute: k(0xad, true),
  volumedown: k(0xae, true), xf86audiolowervolume: k(0xae, true),
  volumeup: k(0xaf, true), xf86audioraisevolume: k(0xaf, true),
  medianext: k(0xb0, true), xf86audionext: k(0xb0, true), mediaprev: k(0xb1, true), xf86audioprev: k(0xb1, true),
  mediastop: k(0xb2, true), xf86audiostop: k(0xb2, true), mediaplaypause: k(0xb3, true), playpause: k(0xb3, true), xf86audioplay: k(0xb3, true),
  // punctuation by its X11 name
  semicolon: k(0xba), equal: k(0xbb), equals: k(0xbb), comma: k(0xbc), minus: k(0xbd), hyphen: k(0xbd),
  period: k(0xbe), dot: k(0xbe), slash: k(0xbf), grave: k(0xc0), backtick: k(0xc0),
  bracketleft: k(0xdb), backslash: k(0xdc), bracketright: k(0xdd), apostrophe: k(0xde), quote: k(0xde),
};

/** Punctuation typed without Shift (US layout). */
const PLAIN: Record<string, number> = {
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde, ' ': 0x20,
};

/** Punctuation that needs Shift (US layout): the character → the key under it. */
const SHIFTED: Record<string, number> = {
  '!': 0x31, '@': 0x32, '#': 0x33, $: 0x34, '%': 0x35, '^': 0x36, '&': 0x37, '*': 0x38, '(': 0x39, ')': 0x30,
  _: 0xbd, '+': 0xbb, '{': 0xdb, '}': 0xdd, '|': 0xdc, ':': 0xba, '"': 0xde, '<': 0xbc, '>': 0xbe, '?': 0xbf, '~': 0xc0,
};

/** The same characters by their X11 names. */
const SHIFTED_NAMES: Record<string, string> = {
  exclam: '!', at: '@', numbersign: '#', dollar: '$', percent: '%', asciicircum: '^', ampersand: '&', asterisk: '*',
  parenleft: '(', parenright: ')', underscore: '_', plus: '+', braceleft: '{', braceright: '}', bar: '|', colon: ':',
  quotedbl: '"', less: '<', greater: '>', question: '?', asciitilde: '~', tilde: '~',
};

const HELP = 'Use key names such as Return, Tab, Escape, BackSpace, Delete, Home, End, Page_Up, Page_Down, Left, Up, F5, space, or a single character, joined with "+" for a combination (ctrl+shift+s, alt+Tab, win+r). For text, use the type tool.';

type One = { ok: true; key: KeyStroke; shift?: boolean; modifier?: boolean } | { ok: false; error: string };

function one(token: string, alone: boolean): One {
  if (token.length === 1 || [...token].length === 1) {
    const c = token;
    if (/^[a-z]$/.test(c)) return { ok: true, key: k(c.toUpperCase().charCodeAt(0)) };
    // xdotool: an uppercase letter on its own is typed as one (Shift + the key); in a combination its case says nothing
    if (/^[A-Z]$/.test(c)) return { ok: true, key: k(c.charCodeAt(0)), shift: alone };
    if (/^[0-9]$/.test(c)) return { ok: true, key: k(c.charCodeAt(0)) };
    if (PLAIN[c] !== undefined) return { ok: true, key: k(PLAIN[c]) };
    if (SHIFTED[c] !== undefined) return { ok: true, key: k(SHIFTED[c]), shift: true };
    return { ok: false, error: `"${c}" is not a key on the keyboard. Use the type tool to enter text.` };
  }
  const name = token.toLowerCase().replace(/_/g, '');
  if (name === 'cmd' || name === 'command') {
    return { ok: false, error: `There is no "${token}" key on Windows. Use ctrl for shortcuts (ctrl+c, ctrl+v, ctrl+s) or win for the Windows key.` };
  }
  if (name === 'option' || name === 'opt') return { ok: false, error: `There is no "${token}" key on Windows. Use alt.` };
  if (name === 'fn') return { ok: false, error: 'The fn key cannot be sent: the keyboard handles it itself. Name the key it produces (F5, Home, volumeup, …).' };
  if (MODIFIERS[name]) return { ok: true, key: MODIFIERS[name], modifier: true };
  if (NAMED[name]) return { ok: true, key: NAMED[name] };
  if (SHIFTED_NAMES[name]) return { ok: true, key: k(SHIFTED[SHIFTED_NAMES[name]]), shift: true };
  const f = /^f(\d{1,2})$/.exec(name);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return { ok: true, key: k(0x6f + Number(f[1])) };
  const kp = /^(?:kp|numpad)(\d)$/.exec(name);
  if (kp) return { ok: true, key: k(0x60 + Number(kp[1])) };
  return { ok: false, error: `Unknown key "${token}". ${HELP}` };
}

/** "ctrl++" and "+" mean the plus key; anything else splits on "+". Null: a dangling "+". */
function splitChord(s: string): string[] | null {
  if (s === '+') return ['+'];
  let base = s;
  let plus = false;
  if (s.endsWith('++')) { base = s.slice(0, -2); plus = true; }
  const parts = base === '' ? [] : base.split('+');
  if (parts.some((p) => p === '')) return null;
  if (plus) parts.push('+');
  return parts;
}

const isCtrl = (vk: number) => vk === VK.CONTROL || vk === 0xa2 || vk === 0xa3;
const isAlt = (vk: number) => vk === VK.ALT || vk === 0xa4 || vk === 0xa5;
const isWin = (vk: number) => vk === VK.LWIN || vk === VK.RWIN;
const isShift = (vk: number) => vk === VK.SHIFT || vk === 0xa0 || vk === 0xa1;

function chord(text: string): { ok: true; chord: Chord } | { ok: false; error: string } {
  const parts = splitChord(text);
  if (!parts || !parts.length) return { ok: false, error: `"${text}" is not a key combination: a "+" has nothing next to it. For the plus key write plus (ctrl+plus). ${HELP}` };
  const mods: KeyStroke[] = [];
  const keys: KeyStroke[] = [];
  let shift = false;
  for (const p of parts) {
    const r = one(p, parts.length === 1);
    if (!r.ok) return r;
    if (r.modifier) mods.push(r.key);
    else keys.push(r.key);
    if (r.shift) shift = true;
  }
  if (shift && !mods.some((m) => isShift(m.vk))) mods.push(k(VK.SHIFT));
  const out: Chord = [];
  for (const s of [...mods, ...keys]) if (!out.some((o) => o.vk === s.vk)) out.push(s);
  if (out.some((s) => isCtrl(s.vk)) && out.some((s) => isAlt(s.vk)) && out.some((s) => s.vk === VK.DELETE)) {
    return { ok: false, error: 'Windows does not let programs send ctrl+alt+delete. Ask the user to press it.' };
  }
  if (out.some((s) => isWin(s.vk)) && out.some((s) => s.vk === VK.L) && out.length === 2) {
    return { ok: false, error: 'Windows does not let programs send win+l (lock the screen). Ask the user to press it.' };
  }
  return { ok: true, chord: out };
}

/** A `key` / `hold_key` string → the combinations to press, one after another. */
export function parseKeys(text: unknown): KeysResult {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: `"text" must name a key or a combination. ${HELP}` };
  if (text.trim() === '') return { ok: true, chords: [[k(0x20)]] }; // a literal space
  // "ctrl + s" is one combination, not three keys
  const tokens = text.trim().replace(/(\S)\s*\+\s*(?=\S)/g, '$1+').split(/\s+/);
  if (tokens.length > 50) return { ok: false, error: 'Too many keys in one call (at most 50 combinations). For text, use the type tool.' };
  const chords: Chord[] = [];
  for (const t of tokens) {
    const c = chord(t);
    if (!c.ok) return c;
    chords.push(c.chord);
  }
  return { ok: true, chords };
}

/** The `text` of a click or scroll: modifier keys to hold meanwhile ("shift", "ctrl+shift"). Empty / absent: none. */
export function parseModifiers(text: unknown): { ok: true; mods: KeyStroke[] } | { ok: false; error: string } {
  if (text === undefined || text === null || text === '') return { ok: true, mods: [] };
  if (typeof text !== 'string') return { ok: false, error: '"text" must be modifier keys such as "shift" or "ctrl+shift".' };
  const parts = text.trim().split('+').map((p) => p.trim());
  const mods: KeyStroke[] = [];
  for (const p of parts) {
    const r = p ? one(p, false) : ({ ok: false, error: `"${text}" is not a list of modifier keys.` } as One);
    if (!r.ok) return r;
    if (!r.modifier) return { ok: false, error: `"${p}" is not a modifier key. While clicking or scrolling only ctrl, shift, alt and win can be held ("shift", "ctrl+shift").` };
    if (!mods.some((m) => m.vk === r.key.vk)) mods.push(r.key);
  }
  return { ok: true, mods };
}

/**
 * A combination Windows itself answers, whatever application is in front: anything with the Windows key (Start,
 * win+r, win+d, win+Tab…), alt+Tab / alt+Escape (switch windows) and ctrl+Escape / ctrl+shift+Escape (Start, Task
 * Manager). These leave the granted application, so they are only pressed when the user was told (`systemKeyCombos`
 * in the access request). alt+F4 closes the window in front — the granted one — and is not among them.
 */
export function isSystemCombo(chord: readonly KeyStroke[]): boolean {
  if (chord.some((s) => isWin(s.vk))) return true;
  const has = (vk: number) => chord.some((s) => s.vk === vk);
  if (chord.some((s) => isAlt(s.vk)) && (has(0x09) || has(0x1b))) return true;
  return chord.some((s) => isCtrl(s.vk)) && has(0x1b);
}

/** Is this key one that repeats while held (anything but a modifier)? The helper repeats the last such key of a hold. */
export function isModifierKey(vk: number): boolean {
  return isCtrl(vk) || isAlt(vk) || isWin(vk) || isShift(vk);
}
