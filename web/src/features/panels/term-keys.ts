// The row of keys above a phone's keyboard in the terminal (TerminalPanel.tsx draws it; UI refresh §8 「终端」):
// which keys there are, and what a tap — or the next typed character with Ctrl / Alt armed — sends to the pty.
// Pure. The byte sequences are the ones xterm.js sends for the same keys on a real keyboard.

export type TermKeyId = 'esc' | 'tab' | 'ctrl' | 'alt' | 'up' | 'down' | 'left' | 'right' | 'ctrl-c' | 'paste';

export interface TermKeyDef {
  id: TermKeyId;
  /** what is written on the key */
  label: string;
  /** what a screen reader says (the arrows are only glyphs) */
  name: string;
  /** a tap arms it for the next key instead of sending anything */
  sticky?: true;
}

export const TERM_KEYS: readonly TermKeyDef[] = [
  { id: 'esc', label: 'Esc', name: 'Esc' },
  { id: 'tab', label: 'Tab', name: 'Tab' },
  { id: 'ctrl', label: 'Ctrl', name: 'Ctrl（按一下，对下一个键生效）', sticky: true },
  { id: 'alt', label: 'Alt', name: 'Alt（按一下，对下一个键生效）', sticky: true },
  { id: 'up', label: '↑', name: '上' },
  { id: 'down', label: '↓', name: '下' },
  { id: 'left', label: '←', name: '左' },
  { id: 'right', label: '→', name: '右' },
  { id: 'ctrl-c', label: 'Ctrl+C', name: 'Ctrl+C（中断）' },
  { id: 'paste', label: '粘贴', name: '粘贴' },
];
export const TERM_KEYS_LABEL = '终端按键';

/** The browser has no clipboard to read from here (not https), it refused, or there was no text in it. */
export const PASTE_NO_API = '浏览器没有允许读取剪贴板：这个地址不是 https，浏览器不提供剪贴板';
export const PASTE_DENIED = '浏览器没有允许读取剪贴板';
export const PASTE_EMPTY = '剪贴板里没有文字';

/** Which sticky keys are armed. */
export interface Mods { ctrl: boolean; alt: boolean }
export const NO_MODS: Mods = Object.freeze({ ctrl: false, alt: false });

/** What the program in the terminal asked for (xterm's `term.modes`). */
export interface TermModes { appCursor?: boolean; bracketedPaste?: boolean }

const ESC = '\x1b';
const ARROW: Partial<Record<TermKeyId, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/** xterm's modifier parameter: 1 + (Alt = 2) + (Ctrl = 4); 0 when nothing is armed. */
function modParam(m: Mods): number {
  const bits = (m.alt ? 2 : 0) | (m.ctrl ? 4 : 0);
  return bits ? bits + 1 : 0;
}

/** A cursor key (an arrow, Home, End): modified it is always CSI 1;m X; plain it follows the cursor-key mode. */
function cursorKey(final: string, m: Mods, appCursor: boolean): string {
  const p = modParam(m);
  return p ? `${ESC}[1;${p}${final}` : `${ESC}${appCursor ? 'O' : '['}${final}`;
}

/** The bytes a key on the row sends; null for the keys that send nothing themselves (Ctrl, Alt, 粘贴). */
export function keyBytes(id: TermKeyId, mods: Mods, modes: TermModes = {}): string | null {
  const arrow = ARROW[id];
  if (arrow) return cursorKey(arrow, mods, !!modes.appCursor);
  switch (id) {
    case 'esc': return mods.alt ? ESC + ESC : ESC;
    case 'tab': return mods.alt ? `${ESC}\t` : '\t';
    case 'ctrl-c': return '\x03';
    default: return null;
  }
}

export function toggleMod(mods: Mods, which: 'ctrl' | 'alt'): Mods {
  return { ...mods, [which]: !mods[which] };
}

/** One tap on the row: what to send (if anything), what stays armed, and whether the clipboard is wanted. */
export function pressKey(id: TermKeyId, mods: Mods, modes: TermModes = {}): { send: string | null; mods: Mods; paste: boolean } {
  if (id === 'ctrl' || id === 'alt') return { send: null, mods: toggleMod(mods, id), paste: false };
  // every other key is 「the next key」: it uses what is armed (where that means something) and releases it
  return { send: keyBytes(id, mods, modes), mods: NO_MODS, paste: id === 'paste' };
}

/** Ctrl + this character, or null when there is no such control character. */
function control(ch: string): string | null {
  if (ch.length !== 1) return null;
  const c = ch.charCodeAt(0);
  if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60); // a–z
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40); // @ A–Z [ \ ] ^ _
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  if (ch === '\x7f') return '\x08'; // backspace
  return null;
}

/** an arrow / Home / End as a keyboard sends it unmodified */
const CURSOR_SEQ = /^\x1b[[O]([A-DHF])$/;

/**
 * The next chunk xterm hands over (`term.onData`) with the armed keys applied. `used` says whether the chunk was a
 * key press — a sequence the terminal emits on its own (a cursor or focus report, a bracketed paste) goes through
 * untouched and leaves the keys armed.
 */
export function applyMods(data: string, mods: Mods): { data: string; used: boolean } {
  if (!data || (!mods.ctrl && !mods.alt)) return { data, used: false };
  if (data.length > 1 && data[0] === ESC) {
    const m = CURSOR_SEQ.exec(data);
    return m ? { data: cursorKey(m[1], mods, false), used: true } : { data, used: false };
  }
  const first = String.fromCodePoint(data.codePointAt(0)!);
  const rest = data.slice(first.length);
  const key = (mods.ctrl ? control(first) : null) ?? first;
  return { data: `${mods.alt ? ESC : ''}${key}${rest}`, used: true };
}

const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** The clipboard's text as xterm would paste it: line ends as CR, bracketed when the program asked for that. */
export function pasteBytes(text: string, modes: TermModes = {}): string {
  if (!text) return '';
  const t = text.replace(/\r?\n/g, '\r');
  // text that contains the closing marker would end the paste early and run what follows it as typed input
  return modes.bracketedPaste ? `${PASTE_START}${t.split(PASTE_END).join('')}${PASTE_END}` : t;
}
