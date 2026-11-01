import { describe, expect, it } from 'vitest';
import { buildMap, onPage, sceneSize } from './engine';
import { EPOCH, snapshotAt } from './demo';
import { anchorFor, cameraView, CHAPTERS, chapterById, easeView, HERO_COPY_PX, HERO_LOOK, HERO_LOOK_PHONE, heroLookFor } from './chapters';

const map = buildMap(snapshotAt(31_000), EPOCH + 31_000);
const sz = sceneSize(map);

describe('chapters', () => {
  it('are the seven of copy.ts, in order', () => {
    expect(CHAPTERS.map((c) => c.id)).toEqual(['agents', 'turns', 'permission', 'review', 'checkout', 'elsewhere']);
    expect(chapterById('review')?.focus).toBe('tests');
    expect(chapterById('nope')).toBeUndefined();
  });
  it('look at points inside the room', () => {
    for (const c of [...CHAPTERS.map((x) => x.look), HERO_LOOK, HERO_LOOK_PHONE]) {
      expect(c.u).toBeGreaterThanOrEqual(0);
      expect(c.u).toBeLessThanOrEqual(map.cols);
      expect(c.v).toBeGreaterThanOrEqual(0);
      expect(c.v).toBeLessThanOrEqual(map.rows);
      expect(c.zoom).toBeGreaterThan(0.5);
      expect(c.zoom).toBeLessThan(4);
    }
  });
  it('the camera puts the point at the anchor and covers the stage', () => {
    const a = anchorFor(1440);
    for (const c of CHAPTERS) {
      const v = cameraView(c.look, sz, 1440, 900, a);
      const p = onPage(v, sz, c.look.u, c.look.v, c.look.h ?? 0);
      expect(Math.abs(p.x - a.x * 1440)).toBeLessThan(0.5);
      expect(Math.abs(p.y - a.y * 900)).toBeLessThan(0.5);
      expect(sz.w * v.scale).toBeGreaterThanOrEqual(1440);
    }
  });
  it('the first screen keeps the door sign and the counter right of the copy, the last seat on screen', () => {
    for (const [cw, ch] of [[1280, 720], [1366, 768], [1440, 900], [1920, 1080]]) {
      const v = cameraView(heroLookFor(cw), sz, cw, ch, anchorFor(cw));
      const sign = onPage(v, sz, map.door.u + 2, map.door.v + 1, 0).x; // labels(): the door's pill, ~100 px wide
      const admin = onPage(v, sz, map.admin.u + 0.5, map.admin.v + 0.5, 30).x; // its bubble, ~200 px wide
      const lint = onPage(v, sz, 17, 3.3, 22).x; // the last seat's tag
      expect(sign - 60, `${cw}: door sign`).toBeGreaterThanOrEqual(HERO_COPY_PX);
      expect(admin - 110, `${cw}: admin`).toBeGreaterThanOrEqual(HERO_COPY_PX);
      expect(lint + 30, `${cw}: last seat`).toBeLessThanOrEqual(cw);
    }
    expect(heroLookFor(390)).toBe(HERO_LOOK_PHONE);
    expect(heroLookFor(1440)).toBe(HERO_LOOK);
  });
  it('phones look at the middle, desktops right of the copy', () => {
    expect(anchorFor(390).x).toBe(0.5);
    expect(anchorFor(1440).x).toBeGreaterThan(0.6);
  });
  it('eases from one view to the next', () => {
    const a = { scale: 1, x: 0, y: 0 }, b = { scale: 3, x: 100, y: -50 };
    expect(easeView(a, b, 0)).toEqual(a);
    expect(easeView(a, b, 1)).toEqual(b);
    expect(easeView(a, b, 0.5).x).toBeGreaterThan(50);
    expect(easeView(a, b, 2)).toEqual(b);
  });
});
