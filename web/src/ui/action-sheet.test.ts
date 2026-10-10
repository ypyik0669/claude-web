import { describe, expect, it } from 'vitest';
import { SHEET_CLOSE_PX, SHEET_FLICK, SHEET_FLICK_MIN_PX, SHEET_GIVE_PX, dragVelocity, sheetOffset, sheetRelease, sheetScrim } from './action-sheet';

describe('sheetRelease — the finger lets go of the handle', () => {
  it('springs back from a short, slow pull', () => {
    expect(sheetRelease(0, 0)).toBe('back');
    expect(sheetRelease(30, 0.1)).toBe('back');
    expect(sheetRelease(SHEET_CLOSE_PX - 1, 0)).toBe('back');
  });
  it('closes once it is past 70px, however slowly', () => {
    expect(SHEET_CLOSE_PX).toBe(70);
    expect(sheetRelease(SHEET_CLOSE_PX, 0)).toBe('close');
    expect(sheetRelease(240, 0.05)).toBe('close');
  });
  it('closes on a flick down from anywhere', () => {
    expect(sheetRelease(20, SHEET_FLICK)).toBe('close');
    expect(sheetRelease(SHEET_FLICK_MIN_PX, 1.4)).toBe('close');
  });
  it('a twitch is not a flick: fast, but the finger hardly moved', () => {
    expect(sheetRelease(SHEET_FLICK_MIN_PX - 1, 2)).toBe('back');
    expect(sheetRelease(0, 3)).toBe('back');
  });
  it('thrown back up, it stays — also from past 70px', () => {
    expect(sheetRelease(120, -SHEET_FLICK)).toBe('back');
    expect(sheetRelease(90, -1.2)).toBe('back');
    // drifting up slowly past the line is not a throw
    expect(sheetRelease(90, -0.1)).toBe('close');
  });
  it('pulled up (it is already as high as it goes) it only springs back', () => {
    expect(sheetRelease(-40, -1)).toBe('back');
    expect(sheetRelease(-40, 1)).toBe('back');
  });
});

describe('sheetOffset — where the sheet is drawn under the finger', () => {
  it('follows the finger down, one to one', () => {
    expect(sheetOffset(0)).toBe(0);
    expect(sheetOffset(1)).toBe(1);
    expect(sheetOffset(183.5)).toBe(183.5);
  });
  it('gives a little when pulled up, never more than a few px', () => {
    expect(sheetOffset(-4)).toBe(-2);
    expect(sheetOffset(-25)).toBe(-5);
    expect(sheetOffset(-100)).toBe(-SHEET_GIVE_PX);
    expect(sheetOffset(-5000)).toBe(-SHEET_GIVE_PX);
  });
});

describe('sheetScrim — the backdrop thins out as the sheet goes down', () => {
  it('is whole at rest and above it, gone when the sheet is', () => {
    expect(sheetScrim(0, 400)).toBe(1);
    expect(sheetScrim(-8, 400)).toBe(1);
    expect(sheetScrim(400, 400)).toBe(0);
    expect(sheetScrim(900, 400)).toBe(0);
  });
  it('in between it follows the sheet', () => {
    expect(sheetScrim(100, 400)).toBe(0.75);
    expect(sheetScrim(200, 400)).toBe(0.5);
  });
  it('a sheet with no height yet leaves it alone', () => {
    expect(sheetScrim(50, 0)).toBe(1);
  });
});

describe('dragVelocity — px / ms at the moment of release', () => {
  it('needs two samples', () => {
    expect(dragVelocity([], 100)).toBe(0);
    expect(dragVelocity([{ y: 10, t: 90 }], 100)).toBe(0);
  });
  it('is the travel over the last 100ms', () => {
    const samples = [{ y: 0, t: 0 }, { y: 10, t: 16 }, { y: 30, t: 32 }, { y: 60, t: 48 }, { y: 100, t: 64 }];
    expect(dragVelocity(samples, 64)).toBeCloseTo(100 / 64, 5);
  });
  it('forgets what is older than the window: a slow drag that ends in a flick is a flick', () => {
    const samples = [{ y: 0, t: 0 }, { y: 5, t: 300 }, { y: 6, t: 600 }, { y: 30, t: 630 }, { y: 70, t: 660 }];
    expect(dragVelocity(samples, 660)).toBeCloseTo((70 - 6) / 60, 5);
  });
  it('a finger that rested before lifting has no speed', () => {
    const samples = [{ y: 0, t: 0 }, { y: 80, t: 40 }, { y: 160, t: 80 }];
    expect(dragVelocity(samples, 400)).toBe(0);
  });
  it('up is negative', () => {
    expect(dragVelocity([{ y: 100, t: 0 }, { y: 40, t: 50 }], 50)).toBeCloseTo(-1.2, 5);
  });
  it('samples with the same timestamp do not divide by zero', () => {
    expect(dragVelocity([{ y: 0, t: 50 }, { y: 40, t: 50 }], 50)).toBe(0);
  });
});
