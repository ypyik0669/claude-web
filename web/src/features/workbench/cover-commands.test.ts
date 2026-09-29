import { beforeAll, describe, expect, it, vi } from 'vitest';
import { underCovers } from './cover-commands';
import type { Shortcut } from './shortcuts';

let SHORTCUTS: Shortcut[] = [];
beforeAll(async () => {
  vi.stubGlobal('window', {}); // desktop.ts reads window.desktop at import
  ({ SHORTCUTS } = await import('./shortcuts'));
});

const none = { settings: false, automation: false };

describe('keys while a page covers the workbench (review 7 I3, final review I2)', () => {
  it('nothing open: every command runs as it is', () => {
    for (const s of SHORTCUTS) expect(underCovers(s.id, none)).toEqual({ close: [], done: false });
  });
  it('关闭标签 closes the page on top instead of a tab nobody sees — the settings page before the automation page', () => {
    expect(underCovers('tile.close', { settings: true, automation: false })).toEqual({ close: ['settings'], done: true });
    expect(underCovers('tile.close', { settings: false, automation: true })).toEqual({ close: ['automation'], done: true });
    expect(underCovers('tile.close', { settings: true, automation: true })).toEqual({ close: ['settings'], done: true });
  });
  it('a key that acts on the tabs / panes / groups / conversation under the page first puts the page away (the result is seen)', () => {
    for (const id of ['new', 'tile.new', 'tile.next', 'tile.prev', 'pane.splitRight', 'pane.splitDown', 'pane.zoom', 'pane.next', 'pane.jump.2', 'group.new', 'group.close', 'group.next', 'group.jump.1', 'tab', 'interrupt', 'close', 'window.new']) {
      expect(underCovers(id, { settings: true, automation: false }), id).toEqual({ close: ['settings'], done: false });
      expect(underCovers(id, { settings: false, automation: true }), id).toEqual({ close: ['automation'], done: false });
      expect(underCovers(id, { settings: true, automation: true }), id).toEqual({ close: ['settings', 'automation'], done: false });
    }
  });
  it('the palette, the settings key, the sidebar, the right panel and its panels act as before (they show over or beside the page)', () => {
    for (const id of ['palette', 'settings', 'sidebar', 'shortcuts', 'dock.toggle', 'dock.minimize', 'panel.files', 'panel.terminal', 'panel.mission']) {
      expect(underCovers(id, { settings: true, automation: true }), id).toEqual({ close: [], done: false });
    }
  });
  it('every shortcut is decided (none left to act unseen by accident): each one is either kept or listed above', () => {
    // (find / send / slash / paste are not commands: the focused element handles them, and the covered area is inert)
    const kept = /^(palette|settings|sidebar|shortcuts|dock\.|panel\.|find$|send$|slash$|paste$)/;
    for (const s of SHORTCUTS) {
      const r = underCovers(s.id, { settings: true, automation: false });
      expect(kept.test(s.id) || r.close.length > 0, s.id).toBe(true);
    }
  });
});
