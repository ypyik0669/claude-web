import { describe, expect, it } from 'vitest';
import { NO_MODS, TERM_KEYS, applyMods, keyBytes, pasteBytes, pressKey, toggleMod, type Mods, type TermKeyId } from './term-keys';

const ESC = '\x1b';
const ctrl: Mods = { ctrl: true, alt: false };
const alt: Mods = { ctrl: false, alt: true };
const both: Mods = { ctrl: true, alt: true };

describe('TERM_KEYS: the row above the keyboard', () => {
  it('Esc, Tab, Ctrl, Alt, the four arrows, Ctrl+C, 粘贴 — in that order', () => {
    expect(TERM_KEYS.map((k) => k.id)).toEqual(['esc', 'tab', 'ctrl', 'alt', 'up', 'down', 'left', 'right', 'ctrl-c', 'paste']);
    expect(TERM_KEYS.map((k) => k.label)).toEqual(['Esc', 'Tab', 'Ctrl', 'Alt', '↑', '↓', '←', '→', 'Ctrl+C', '粘贴']);
  });

  it('only Ctrl and Alt stick; every key has a name to be read out', () => {
    expect(TERM_KEYS.filter((k) => k.sticky).map((k) => k.id)).toEqual(['ctrl', 'alt']);
    for (const k of TERM_KEYS) expect(k.name, k.id).toBeTruthy();
    expect(new Set(TERM_KEYS.map((k) => k.name)).size).toBe(TERM_KEYS.length);
  });
});

describe('keyBytes: what a key on the row sends', () => {
  it('Esc, Tab, Ctrl+C', () => {
    expect(keyBytes('esc', NO_MODS)).toBe(ESC);
    expect(keyBytes('tab', NO_MODS)).toBe('\t');
    expect(keyBytes('ctrl-c', NO_MODS)).toBe('\x03');
  });

  it('arrows: CSI in the normal mode, SS3 when the program asked for application cursor keys (vim, less)', () => {
    expect((['up', 'down', 'right', 'left'] as TermKeyId[]).map((k) => keyBytes(k, NO_MODS))).toEqual([`${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`]);
    expect((['up', 'down', 'right', 'left'] as TermKeyId[]).map((k) => keyBytes(k, NO_MODS, { appCursor: true }))).toEqual([`${ESC}OA`, `${ESC}OB`, `${ESC}OC`, `${ESC}OD`]);
  });

  it('an arrow with a modifier armed is xterm\'s modified form (Ctrl+← = a word back), in either cursor mode', () => {
    expect(keyBytes('left', ctrl)).toBe(`${ESC}[1;5D`);
    expect(keyBytes('right', alt)).toBe(`${ESC}[1;3C`);
    expect(keyBytes('up', both)).toBe(`${ESC}[1;7A`);
    expect(keyBytes('down', ctrl, { appCursor: true })).toBe(`${ESC}[1;5B`);
  });

  it('Alt+Esc and Alt+Tab carry the ESC prefix; Ctrl changes neither', () => {
    expect(keyBytes('esc', alt)).toBe(ESC + ESC);
    expect(keyBytes('tab', alt)).toBe(`${ESC}\t`);
    expect(keyBytes('esc', ctrl)).toBe(ESC);
    expect(keyBytes('tab', ctrl)).toBe('\t');
  });

  it('Ctrl+C is 0x03 whatever is armed', () => {
    expect(keyBytes('ctrl-c', both)).toBe('\x03');
  });

  it('the sticky keys and 粘贴 send nothing by themselves', () => {
    expect(keyBytes('ctrl', NO_MODS)).toBeNull();
    expect(keyBytes('alt', NO_MODS)).toBeNull();
    expect(keyBytes('paste', NO_MODS)).toBeNull();
  });
});

describe('toggleMod: a tap arms, another tap un-arms', () => {
  it('each on its own, and both together', () => {
    expect(toggleMod(NO_MODS, 'ctrl')).toEqual(ctrl);
    expect(toggleMod(ctrl, 'ctrl')).toEqual(NO_MODS);
    expect(toggleMod(ctrl, 'alt')).toEqual(both);
    expect(toggleMod(both, 'ctrl')).toEqual(alt);
  });

  it('does not change what it was given', () => {
    const m: Mods = { ctrl: false, alt: false };
    toggleMod(m, 'ctrl');
    expect(m).toEqual({ ctrl: false, alt: false });
  });
});

describe('pressKey: one tap on the row', () => {
  it('a sticky key only changes what is armed', () => {
    expect(pressKey('ctrl', NO_MODS)).toEqual({ send: null, mods: ctrl, paste: false });
    expect(pressKey('alt', ctrl)).toEqual({ send: null, mods: both, paste: false });
    expect(pressKey('ctrl', ctrl)).toEqual({ send: null, mods: NO_MODS, paste: false });
  });

  it('a key that sends uses what is armed and releases it', () => {
    expect(pressKey('left', ctrl)).toEqual({ send: `${ESC}[1;5D`, mods: NO_MODS, paste: false });
    expect(pressKey('tab', NO_MODS, { appCursor: true })).toEqual({ send: '\t', mods: NO_MODS, paste: false });
    expect(pressKey('up', NO_MODS, { appCursor: true })).toEqual({ send: `${ESC}OA`, mods: NO_MODS, paste: false });
  });

  it('粘贴 asks for the clipboard and releases what is armed (the pasted text is never Ctrl-ed)', () => {
    expect(pressKey('paste', both)).toEqual({ send: null, mods: NO_MODS, paste: true });
  });
});

describe('applyMods: the next typed chunk with Ctrl / Alt armed', () => {
  it('nothing armed: the chunk as it is, nothing used', () => {
    expect(applyMods('c', NO_MODS)).toEqual({ data: 'c', used: false });
  });

  it('Ctrl + a letter is its control character, in either case (a phone capitalises on its own)', () => {
    expect(applyMods('a', ctrl)).toEqual({ data: '\x01', used: true });
    expect(applyMods('c', ctrl).data).toBe('\x03');
    expect(applyMods('C', ctrl).data).toBe('\x03');
    expect(applyMods('z', ctrl).data).toBe('\x1a');
    for (let i = 0; i < 26; i++) expect(applyMods(String.fromCharCode(97 + i), ctrl).data).toBe(String.fromCharCode(i + 1));
  });

  it('Ctrl + [ \\ ] ^ _ are 0x1b–0x1f, Ctrl+? is DEL, Ctrl+@ and Ctrl+space are NUL', () => {
    expect(applyMods('[', ctrl).data).toBe('\x1b');
    expect(applyMods('\\', ctrl).data).toBe('\x1c');
    expect(applyMods(']', ctrl).data).toBe('\x1d');
    expect(applyMods('^', ctrl).data).toBe('\x1e');
    expect(applyMods('_', ctrl).data).toBe('\x1f');
    expect(applyMods('?', ctrl).data).toBe('\x7f');
    expect(applyMods('@', ctrl).data).toBe('\x00');
    expect(applyMods(' ', ctrl).data).toBe('\x00');
  });

  it('Ctrl + backspace is 0x08, as xterm sends it', () => {
    expect(applyMods('\x7f', ctrl).data).toBe('\x08');
  });

  it('Ctrl + something with no control character (a digit, Enter, 中文) goes through unchanged — and the key is still released', () => {
    expect(applyMods('1', ctrl)).toEqual({ data: '1', used: true });
    expect(applyMods('\r', ctrl)).toEqual({ data: '\r', used: true });
    expect(applyMods('中', ctrl)).toEqual({ data: '中', used: true });
  });

  it('Alt + key is ESC then the key', () => {
    expect(applyMods('b', alt)).toEqual({ data: `${ESC}b`, used: true });
    expect(applyMods('\x7f', alt).data).toBe(`${ESC}\x7f`);
    expect(applyMods('\r', alt).data).toBe(`${ESC}\r`);
    expect(applyMods(ESC, alt).data).toBe(ESC + ESC);
  });

  it('both: ESC then the control character', () => {
    expect(applyMods('c', both)).toEqual({ data: `${ESC}\x03`, used: true });
  });

  it('a chunk of several characters (a swiped word, an input method\'s commit): only its first is modified', () => {
    expect(applyMods('ls', ctrl)).toEqual({ data: '\x0cs', used: true });
    expect(applyMods('fg', alt)).toEqual({ data: `${ESC}fg`, used: true });
    expect(applyMods('😀x', alt)).toEqual({ data: `${ESC}😀x`, used: true });
  });

  it('a cursor key from a real keyboard takes the modifier the way the row\'s arrows do', () => {
    expect(applyMods(`${ESC}[D`, ctrl)).toEqual({ data: `${ESC}[1;5D`, used: true });
    expect(applyMods(`${ESC}OC`, alt)).toEqual({ data: `${ESC}[1;3C`, used: true });
    expect(applyMods(`${ESC}[H`, ctrl)).toEqual({ data: `${ESC}[1;5H`, used: true });
    expect(applyMods(`${ESC}[F`, both)).toEqual({ data: `${ESC}[1;7F`, used: true });
  });

  it('what the terminal itself answers (a cursor report, a focus report, a bracketed paste) is not a key: unchanged, and the modifier stays armed', () => {
    expect(applyMods(`${ESC}[12;40R`, ctrl)).toEqual({ data: `${ESC}[12;40R`, used: false });
    expect(applyMods(`${ESC}[I`, alt)).toEqual({ data: `${ESC}[I`, used: false });
    expect(applyMods(`${ESC}[200~ls${ESC}[201~`, ctrl)).toEqual({ data: `${ESC}[200~ls${ESC}[201~`, used: false });
    expect(applyMods(`${ESC}[?1;2c`, both)).toEqual({ data: `${ESC}[?1;2c`, used: false });
  });

  it('an empty chunk uses nothing', () => {
    expect(applyMods('', ctrl)).toEqual({ data: '', used: false });
  });
});

describe('pasteBytes: the clipboard\'s text on its way to the pty', () => {
  it('line ends become carriage returns, as when xterm pastes', () => {
    expect(pasteBytes('a\r\nb\nc')).toBe('a\rb\rc');
  });

  it('bracketed when the program asked for it', () => {
    expect(pasteBytes('ls -la\n', { bracketedPaste: true })).toBe(`${ESC}[200~ls -la\r${ESC}[201~`);
    expect(pasteBytes('ls', { bracketedPaste: false })).toBe('ls');
  });

  it('pasted text cannot close the bracket itself', () => {
    expect(pasteBytes(`safe${ESC}[201~rm -rf x\n`, { bracketedPaste: true })).toBe(`${ESC}[200~saferm -rf x\r${ESC}[201~`);
  });

  it('nothing to paste: nothing sent, bracket or not', () => {
    expect(pasteBytes('')).toBe('');
    expect(pasteBytes('', { bracketedPaste: true })).toBe('');
  });
});
