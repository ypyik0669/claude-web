import { describe, expect, it } from 'vitest';
import { panelFadesOut, type DockSeen } from './dock-closing';

const card: DockSeen = { open: true, minimized: false, mounted: true, mobile: false };

describe('panelFadesOut: the right panel gets its fade before its column collapses (UI refresh §6)', () => {
  it('a panel on screen that is hidden (Ctrl+J, the header button, its own ×): yes', () => {
    expect(panelFadesOut(card, { ...card, open: false })).toBe(true);
  });
  it('opening, or nothing about open / closed changed: no', () => {
    expect(panelFadesOut({ ...card, open: false }, card)).toBe(false);
    expect(panelFadesOut(card, card)).toBe(false);
    expect(panelFadesOut({ ...card, open: false }, { ...card, open: false })).toBe(false);
  });
  it('hidden from its 36px icon rail: no (the rail is not a card, there is nothing to fade)', () => {
    expect(panelFadesOut({ ...card, minimized: true }, { ...card, minimized: true, open: false })).toBe(false);
  });
  it('its last tab closed (the panel is unmounted, not hidden): no', () => {
    expect(panelFadesOut(card, { ...card, open: false, mounted: false })).toBe(false);
    expect(panelFadesOut(card, { ...card, mounted: false })).toBe(false);
  });
  it('a panel with nothing in it was not on screen: no', () => {
    expect(panelFadesOut({ ...card, mounted: false }, { ...card, open: false })).toBe(false);
  });
  it('a phone: no (the bottom sheet has its own way out), also while the window crosses the width', () => {
    expect(panelFadesOut({ ...card, mobile: true }, { ...card, mobile: true, open: false })).toBe(false);
    expect(panelFadesOut(card, { ...card, mobile: true, open: false })).toBe(false);
  });
});
