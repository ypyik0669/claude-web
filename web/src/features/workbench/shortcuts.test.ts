import { beforeAll, describe, expect, it, vi } from 'vitest';

let matchBrowserKey: (e: KeyboardEvent) => string | null;
beforeAll(async () => {
  vi.stubGlobal('window', {}); // desktop.ts reads window.desktop at import
  ({ matchBrowserKey } = await import('./shortcuts'));
});

const ev = (o: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, code: '', ...o }) as unknown as KeyboardEvent;

describe('matchBrowserKey', () => {
  it('Ctrl+Shift+digit: e.key is the shifted symbol, the physical digit decides — the panel\'s five in the header\'s order', () => {
    expect(matchBrowserKey(ev({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe('panel.tasks');
    expect(matchBrowserKey(ev({ key: '@', code: 'Digit2', ctrlKey: true, shiftKey: true }))).toBe('panel.terminal');
    expect(matchBrowserKey(ev({ key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true }))).toBe('panel.files');
    expect(matchBrowserKey(ev({ key: '$', code: 'Digit4', ctrlKey: true, shiftKey: true }))).toBe('panel.browser');
    expect(matchBrowserKey(ev({ key: '%', code: 'Digit5', ctrlKey: true, shiftKey: true }))).toBe('panel.explorer');
    // a plain Ctrl+digit is the browser's own tab switching (the desktop app's menu has Ctrl 1–5)
    expect(matchBrowserKey(ev({ key: '1', code: 'Digit1', ctrlKey: true }))).toBeNull();
  });

  it('Ctrl+I: the info column — not in the code editor or the terminal', () => {
    const inside = (sel: string) => ({ closest: (q: string) => (q.split(', ').includes(sel) ? {} : null), tagName: 'DIV' });
    expect(matchBrowserKey(ev({ key: 'i', code: 'KeyI', ctrlKey: true }))).toBe('info.toggle');
    expect(matchBrowserKey(ev({ key: 'i', code: 'KeyI', ctrlKey: true, target: inside('.monaco-editor') as any }))).toBeNull();
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

  it('the official app’s keys: Ctrl+O view mode, Ctrl+; side chat (by the physical key on other layouts too)', () => {
    expect(matchBrowserKey(ev({ key: 'o', code: 'KeyO', ctrlKey: true }))).toBe('view.cycle');
    expect(matchBrowserKey(ev({ key: ';', code: 'Semicolon', ctrlKey: true }))).toBe('side');
    expect(matchBrowserKey(ev({ key: 'ö', code: 'Semicolon', ctrlKey: true }))).toBe('side');
    expect(matchBrowserKey(ev({ key: ';', code: 'Semicolon', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('the menus of the input box: Alt+M model (Ctrl+Shift+I is the developer tools), Ctrl+Shift+E thinking strength', () => {
    expect(matchBrowserKey(ev({ key: 'm', code: 'KeyM', altKey: true }))).toBe('menu.model');
    expect(matchBrowserKey(ev({ key: 'µ', code: 'KeyM', altKey: true }))).toBe('menu.model'); // macOS Option+M
    expect(matchBrowserKey(ev({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }))).toBe('menu.effort');
    expect(matchBrowserKey(ev({ key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('Ctrl+/ shows the shortcuts anywhere but the code editor and the terminal (there it toggles a comment)', () => {
    const inside = (sel: string) => ({ closest: (q: string) => (q.split(', ').includes(sel) ? {} : null), tagName: 'TEXTAREA' });
    expect(matchBrowserKey(ev({ key: '/', code: 'Slash', ctrlKey: true }))).toBe('shortcuts');
    expect(matchBrowserKey(ev({ key: '/', code: 'Slash', ctrlKey: true, target: { closest: () => null, tagName: 'TEXTAREA' } as any }))).toBe('shortcuts');
    expect(matchBrowserKey(ev({ key: '/', code: 'Slash', ctrlKey: true, target: inside('.monaco-editor') as any }))).toBeNull();
    expect(matchBrowserKey(ev({ key: '/', code: 'Slash', ctrlKey: true, target: inside('.xterm') as any }))).toBeNull();
  });

  it('Ctrl+\\ closes the focused split (by the physical key too)', () => {
    expect(matchBrowserKey(ev({ key: '\\', code: 'Backslash', ctrlKey: true }))).toBe('pane.close');
    expect(matchBrowserKey(ev({ key: '#', code: 'Backslash', ctrlKey: true }))).toBe('pane.close');
  });
});
