import { describe, expect, it } from 'vitest';
import { composerCovered, sheetUp, type CoverState } from './covered';

const base: CoverState = { settingsOpen: false, automationOpen: false, mobile: false, sheetAt: 0, dockOpen: false, dockTabs: 0, inspect: false };

describe('what hides a conversation\'s composer (review I1: a docked card under it is not on screen)', () => {
  it('nothing over it: in view', () => {
    expect(composerCovered(base)).toBe(false);
  });
  it('the settings page and the automation page cover it', () => {
    expect(composerCovered({ ...base, settingsOpen: true })).toBe(true);
    expect(composerCovered({ ...base, automationOpen: true })).toBe(true);
  });
  it('so do the shortcut sheet, the command palette and an in-app dialog (re-review M-4: F1 gives the focus back to the box)', () => {
    expect(composerCovered({ ...base, shortcutsOpen: true })).toBe(true);
    expect(composerCovered({ ...base, paletteOpen: true })).toBe(true);
    expect(composerCovered({ ...base, dialogOpen: true })).toBe(true);
  });
  it('a phone\'s bottom drawer covers it only while it is up with something in it', () => {
    const up = { ...base, mobile: true, sheetAt: 5, dockOpen: true, dockTabs: 1 };
    expect(sheetUp(up)).toBe(true);
    expect(composerCovered(up)).toBe(true);
    expect(composerCovered({ ...up, sheetAt: 0 })).toBe(false); // put away
    expect(composerCovered({ ...up, dockOpen: false })).toBe(false);
    expect(composerCovered({ ...up, dockTabs: 0 })).toBe(false); // nothing to show…
    expect(composerCovered({ ...up, dockTabs: 0, inspect: true })).toBe(true); // …but 详情
  });
  it('a desktop\'s right panel sits beside the conversation: not a cover', () => {
    expect(composerCovered({ ...base, sheetAt: 5, dockOpen: true, dockTabs: 2 })).toBe(false);
  });
});
