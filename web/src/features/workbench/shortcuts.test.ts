import { beforeAll, describe, expect, it, vi } from 'vitest';

let matchBrowserKey: (e: KeyboardEvent) => string | null;
beforeAll(async () => {
  vi.stubGlobal('window', {}); // desktop.ts reads window.desktop at import
  ({ matchBrowserKey } = await import('./shortcuts'));
});

const ev = (o: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, code: '', ...o }) as unknown as KeyboardEvent;

describe('matchBrowserKey', () => {
  it('Ctrl+Shift+digit: e.key is the shifted symbol, the physical digit decides', () => {
    expect(matchBrowserKey(ev({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe('panel.tasks');
    expect(matchBrowserKey(ev({ key: '@', code: 'Digit2', ctrlKey: true, shiftKey: true }))).toBe('panel.files');
  });

  it('macOS Option chords produce other characters (or dead keys)', () => {
    expect(matchBrowserKey(ev({ key: 'Dead', code: 'KeyN', altKey: true }))).toBe('new');
    expect(matchBrowserKey(ev({ key: '¡', code: 'Digit1', altKey: true }))).toBe('pane.jump.0');
    expect(matchBrowserKey(ev({ key: '“', code: 'BracketLeft', altKey: true }))).toBe('pane.prev');
    expect(matchBrowserKey(ev({ key: '≥', code: 'Period', altKey: true }))).toBe('tile.next');
    expect(matchBrowserKey(ev({ key: '„', code: 'KeyW', altKey: true, shiftKey: true }))).toBe('group.close');
  });

  it('Cmd works where Ctrl does', () => {
    expect(matchBrowserKey(ev({ key: 'k', code: 'KeyK', metaKey: true }))).toBe('palette');
  });

  it('a plain produced letter wins over the physical key (non-QWERTY layouts)', () => {
    // AZERTY: the key labelled "N" sits where QWERTY has N, but "A" sits on KeyQ
    expect(matchBrowserKey(ev({ key: 'n', code: 'KeyN', altKey: true }))).toBe('new');
    expect(matchBrowserKey(ev({ key: 't', code: 'KeyY', altKey: true }))).toBe('group.new');
    expect(matchBrowserKey(ev({ key: '?', code: 'Slash', shiftKey: true }))).toBe('shortcuts');
  });
});
