import { describe, expect, it } from 'vitest';
import { isModifierKey, isSystemCombo, parseKeys, parseModifiers, type Chord } from './keys.js';

const CTRL = { vk: 0x11 };
const SHIFT = { vk: 0x10 };
const ALT = { vk: 0x12 };
const WIN = { vk: 0x5b, ext: true };

function chords(text: string): Chord[] {
  const r = parseKeys(text);
  if (!r.ok) throw new Error(`${JSON.stringify(text)}: ${r.error}`);
  return r.chords;
}
const one = (text: string): Chord => {
  const c = chords(text);
  expect(c, text).toHaveLength(1);
  return c[0];
};
const error = (text: unknown): string => {
  const r = parseKeys(text);
  expect(r.ok, JSON.stringify(text)).toBe(false);
  return r.ok ? '' : r.error;
};

describe('key strings', () => {
  it('the examples from the tool descriptions', () => {
    expect(one('ctrl+s')).toEqual([CTRL, { vk: 0x53 }]);
    expect(one('Return')).toEqual([{ vk: 0x0d }]);
    expect(one('alt+Tab')).toEqual([ALT, { vk: 0x09 }]);
    expect(one('super')).toEqual([WIN]);
    expect(one('F5')).toEqual([{ vk: 0x74 }]);
    expect(one('shift+ctrl+Left')).toEqual([SHIFT, CTRL, { vk: 0x25, ext: true }]);
    expect(one('a')).toEqual([{ vk: 0x41 }]);
    expect(one('7')).toEqual([{ vk: 0x37 }]);
    expect(one('win+r')).toEqual([WIN, { vk: 0x52 }]);
    expect(one('alt+F4')).toEqual([ALT, { vk: 0x73 }]);
    expect(one('ctrl+shift+Tab')).toEqual([CTRL, SHIFT, { vk: 0x09 }]);
  });

  it('names in any case, with or without underscores, and their usual synonyms', () => {
    for (const s of ['Return', 'return', 'ENTER', 'Enter']) expect(one(s)).toEqual([{ vk: 0x0d }]);
    for (const s of ['Escape', 'esc', 'ESC']) expect(one(s)).toEqual([{ vk: 0x1b }]);
    for (const s of ['Page_Down', 'pagedown', 'PageDown', 'Next', 'pgdn']) expect(one(s)).toEqual([{ vk: 0x22, ext: true }]);
    for (const s of ['Page_Up', 'Prior', 'pgup']) expect(one(s)).toEqual([{ vk: 0x21, ext: true }]);
    for (const s of ['BackSpace', 'backspace', 'Back_Space']) expect(one(s)).toEqual([{ vk: 0x08 }]);
    for (const s of ['Delete', 'del']) expect(one(s)).toEqual([{ vk: 0x2e, ext: true }]);
    for (const s of ['space', 'Space', ' ']) expect(one(s)).toEqual([{ vk: 0x20 }]);
    for (const s of ['Up', 'ArrowUp']) expect(one(s)).toEqual([{ vk: 0x26, ext: true }]);
    for (const s of ['control+a', 'Control_L+a', 'CTRL+A', 'ctrl+A']) expect(one(s)[1]).toEqual({ vk: 0x41 });
    expect(one('Control_L+a')[0]).toEqual({ vk: 0xa2 });
    expect(one('Control_R+a')[0]).toEqual({ vk: 0xa3, ext: true });
    for (const s of ['win', 'windows', 'super', 'meta', 'Super_L']) expect(one(s)).toEqual([WIN]);
    expect(one('F1')).toEqual([{ vk: 0x70 }]);
    expect(one('f12')).toEqual([{ vk: 0x7b }]);
    expect(one('F24')).toEqual([{ vk: 0x87 }]);
    expect(one('KP_5')).toEqual([{ vk: 0x65 }]);
    expect(one('Home')).toEqual([{ vk: 0x24, ext: true }]);
    expect(one('End')).toEqual([{ vk: 0x23, ext: true }]);
    expect(one('Insert')).toEqual([{ vk: 0x2d, ext: true }]);
    expect(one('Menu')).toEqual([{ vk: 0x5d, ext: true }]);
  });

  it('single characters: letters, digits, punctuation; what needs Shift gets it', () => {
    expect(one('/')).toEqual([{ vk: 0xbf }]);
    expect(one('?')).toEqual([SHIFT, { vk: 0xbf }]);
    expect(one('ctrl+/')).toEqual([CTRL, { vk: 0xbf }]);
    expect(one('-')).toEqual([{ vk: 0xbd }]);
    expect(one('_')).toEqual([SHIFT, { vk: 0xbd }]);
    expect(one('ctrl+-')).toEqual([CTRL, { vk: 0xbd }]);
    expect(one('ctrl+=')).toEqual([CTRL, { vk: 0xbb }]);
    expect(one('!')).toEqual([SHIFT, { vk: 0x31 }]);
    expect(one('ctrl+minus')).toEqual([CTRL, { vk: 0xbd }]);
    expect(one('ctrl+shift+/')).toEqual([CTRL, SHIFT, { vk: 0xbf }]);
    expect(one('\\')).toEqual([{ vk: 0xdc }]);
    expect(one('grave')).toEqual([{ vk: 0xc0 }]);
    expect(one('question')).toEqual([SHIFT, { vk: 0xbf }]);
  });

  it('an uppercase letter alone is typed as one; inside a combination its case says nothing', () => {
    expect(one('A')).toEqual([SHIFT, { vk: 0x41 }]);
    expect(one('ctrl+S')).toEqual([CTRL, { vk: 0x53 }]); // save, not save-as
    expect(one('shift+A')).toEqual([SHIFT, { vk: 0x41 }]);
  });

  it('the plus key', () => {
    expect(one('+')).toEqual([SHIFT, { vk: 0xbb }]);
    expect(one('plus')).toEqual([SHIFT, { vk: 0xbb }]);
    expect(one('ctrl++')).toEqual([CTRL, SHIFT, { vk: 0xbb }]);
    expect(one('ctrl+plus')).toEqual([CTRL, SHIFT, { vk: 0xbb }]);
    expect(one('ctrl+shift++')).toEqual([CTRL, SHIFT, { vk: 0xbb }]);
    expect(one('KP_Add')).toEqual([{ vk: 0x6b }]);
  });

  it('several combinations, pressed one after another', () => {
    expect(chords('ctrl+a BackSpace')).toEqual([[CTRL, { vk: 0x41 }], [{ vk: 0x08 }]]);
    expect(chords('Down Down Return')).toEqual([[{ vk: 0x28, ext: true }], [{ vk: 0x28, ext: true }], [{ vk: 0x0d }]]);
    expect(chords('  Tab   Tab ')).toHaveLength(2);
  });

  it('spaces around a plus join one combination', () => {
    expect(chords('ctrl + s')).toEqual([[CTRL, { vk: 0x53 }]]);
    expect(chords('ctrl +shift+ t')).toEqual([[CTRL, SHIFT, { vk: 0x54 }]]);
  });

  it('modifiers come first and are pressed once', () => {
    expect(one('s+ctrl')).toEqual([CTRL, { vk: 0x53 }]);
    expect(one('ctrl+ctrl+s')).toEqual([CTRL, { vk: 0x53 }]);
    expect(one('shift+?')).toEqual([SHIFT, { vk: 0xbf }]);
    expect(one('shift')).toEqual([SHIFT]);
  });

  it('refuses what it does not know, and says what to write instead', () => {
    expect(error('cmd+c')).toContain('ctrl');
    expect(error('command+space')).toContain('Windows');
    expect(error('option+Left')).toContain('alt');
    expect(error('fn+F5')).toContain('fn');
    expect(error('hyper+x')).toContain('Unknown key "hyper"');
    expect(error('ctrl+foo')).toContain('Unknown key "foo"');
    expect(error('F25')).toContain('Unknown key');
    expect(error('F0')).toContain('Unknown key');
    expect(error('中')).toContain('type tool');
    expect(error('é')).toContain('type tool');
    expect(error('😀')).toContain('type tool');
    expect(error('hello world')).toContain('Unknown key "hello"'); // text is for the type tool
    expect(error('ctrl+')).toContain('"+"');
    expect(error('+a')).toContain('"+"');
    expect(error('')).toContain('must name a key');
    expect(error(undefined)).toContain('must name a key');
    expect(error(5)).toContain('must name a key');
  });

  it('refuses the two combinations Windows keeps to itself', () => {
    expect(error('ctrl+alt+Delete')).toContain('ctrl+alt+delete');
    expect(error('Control_L+Alt_R+del')).toContain('ctrl+alt+delete');
    expect(error('win+l')).toContain('win+l');
    expect(error('super+L')).toContain('win+l');
    // close relatives are ordinary keys
    expect(one('ctrl+Delete')).toEqual([CTRL, { vk: 0x2e, ext: true }]);
    expect(one('ctrl+l')).toEqual([CTRL, { vk: 0x4c }]);
    expect(one('win+shift+l')).toHaveLength(3);
  });

  it('refuses an absurdly long sequence', () => {
    expect(error(Array(51).fill('a').join(' '))).toContain('Too many');
    expect(chords(Array(50).fill('a').join(' '))).toHaveLength(50);
  });
});

describe('modifiers for a click', () => {
  it('none, one, several', () => {
    expect(parseModifiers(undefined)).toEqual({ ok: true, mods: [] });
    expect(parseModifiers('')).toEqual({ ok: true, mods: [] });
    expect(parseModifiers('shift')).toEqual({ ok: true, mods: [SHIFT] });
    expect(parseModifiers('ctrl+shift')).toEqual({ ok: true, mods: [CTRL, SHIFT] });
    expect(parseModifiers(' Ctrl + Alt ')).toEqual({ ok: true, mods: [CTRL, ALT] });
    expect(parseModifiers('shift+shift')).toEqual({ ok: true, mods: [SHIFT] });
  });

  it('only modifiers', () => {
    for (const bad of ['a', 'ctrl+a', 'Return', 'cmd', 'ctrl+', 5]) expect(parseModifiers(bad).ok, String(bad)).toBe(false);
    const r = parseModifiers('cmd');
    if (!r.ok) expect(r.error).toContain('ctrl');
  });
});

describe('isSystemCombo: what Windows itself answers, whatever is in front', () => {
  const chords = (s: string) => { const r = parseKeys(s); if (!r.ok) throw new Error(r.error); return r.chords; };
  it('anything with the Windows key; alt+Tab and alt+Escape; ctrl+Escape', () => {
    for (const s of ['win', 'rwin', 'win+r', 'super+d', 'meta+shift+s', 'win+Tab', 'alt+Tab', 'alt+shift+Tab', 'ralt+Tab', 'ctrl+alt+Tab', 'alt+Escape', 'ctrl+Escape', 'ctrl+shift+Escape', 'rctrl+esc']) {
      expect(chords(s).every(isSystemCombo), s).toBe(true);
    }
  });
  it('an application\'s own shortcuts are not', () => {
    for (const s of ['a', 'Return', 'Tab', 'Escape', 'shift+Tab', 'ctrl+Tab', 'ctrl+shift+Tab', 'alt+F4', 'alt+f', 'alt+Left', 'ctrl+s', 'ctrl+shift+s', 'ctrl+alt+s', 'shift+Escape', 'F5', 'alt', 'ctrl', 'shift']) {
      expect(chords(s).some(isSystemCombo), s).toBe(false);
    }
  });
  it('held modifiers of a click count the same way', () => {
    const mods = (s: string) => { const r = parseModifiers(s); if (!r.ok) throw new Error(r.error); return r.mods; };
    expect(isSystemCombo(mods('win'))).toBe(true);
    expect(isSystemCombo(mods('ctrl+win'))).toBe(true);
    expect(isSystemCombo(mods('ctrl+shift+alt'))).toBe(false);
    expect(isSystemCombo([])).toBe(false);
  });
});

describe('isModifierKey', () => {
  it('tells modifiers from keys that repeat', () => {
    for (const vk of [0x10, 0x11, 0x12, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]) expect(isModifierKey(vk)).toBe(true);
    for (const vk of [0x20, 0x41, 0x28, 0x0d]) expect(isModifierKey(vk)).toBe(false);
  });
});
