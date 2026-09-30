import { describe, expect, it } from 'vitest';
import { chatTile, initialLayout, layoutReducer, type Tile } from '@/model/layout';
import { EXTERNAL_LIVE_MS, EXTERNAL_MIN_GAP_MS, externalLive, nextReadAt, readsFromOutside, shownSessions } from './external';

describe('open conversations written from outside (a CLI in a terminal, Codex)', () => {
  it('only one not running here re-reads: running / idle ones get their own events', () => {
    for (const state of ['history', 'closed', 'error']) expect(readsFromOutside({ state })).toBe(true);
    for (const state of ['starting', 'idle', 'running', 'waiting']) expect(readsFromOutside({ state })).toBe(false);
  });

  it('its last turn counts as running for EXTERNAL_LIVE_MS after the write, then not', () => {
    const now = 1_000_000;
    expect(externalLive({ externalAt: now - 1000 }, now)).toBe(true);
    expect(externalLive({ externalAt: now - EXTERNAL_LIVE_MS - 1 }, now)).toBe(false);
    expect(externalLive({}, now)).toBe(false);
    expect(externalLive(undefined, now)).toBe(false);
  });

  it('re-reads are spaced: at least EXTERNAL_MIN_GAP_MS, more when loading is slow', () => {
    expect(nextReadAt(10_000, 50)).toBe(10_000 + EXTERNAL_MIN_GAP_MS);
    expect(nextReadAt(10_000, 1500)).toBe(10_000 + 6000); // a 60 MB transcript: a load a second → at most a quarter of the time
  });

  it('on screen = the front tab of each pane in the group shown (a tab behind another, another group: no)', () => {
    let s = initialLayout();
    const g = s.groups[0];
    const paneId = g.focusedPaneId;
    const front = chatTile('front') as Tile;
    const behind = chatTile('behind') as Tile;
    s = layoutReducer(s, { t: 'tile.open', paneId, tile: behind, mode: 'tab' } as any);
    s = layoutReducer(s, { t: 'tile.open', paneId, tile: front, mode: 'tab' } as any);
    expect([...shownSessions(s)]).toEqual(['front']);
  });
});
