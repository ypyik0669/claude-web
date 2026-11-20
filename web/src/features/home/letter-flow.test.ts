import { describe, expect, it } from 'vitest';
import { makeNoise } from './ascii-noise';
import { MAX_MOTES, MIN_MOTES, PART_R, ambient, backdropOff, backdropOn, current, moteAlpha, moteCount, splash, step, typed } from './letter-flow';

const seeded = (s = 1) => () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
const noise = makeNoise(7);
const base = { dt: 1 / 30, t: 0, w: 800, h: 600, noise, pointer: null, flicker: 0 };

describe('字流: letters drifting on a current', () => {
  it('how many letters: by page size, within bounds', () => {
    expect(moteCount(100, 100)).toBe(MIN_MOTES);
    expect(moteCount(1440, 900)).toBeGreaterThan(MIN_MOTES);
    expect(moteCount(8000, 8000)).toBe(MAX_MOTES);
  });
  it('the current is smooth: nearby points flow almost the same way', () => {
    const a = current(noise, 300, 200, 5), b = current(noise, 302, 200, 5);
    expect(Math.hypot(a.vx - b.vx, a.vy - b.vy)).toBeLessThan(2);
    expect(Math.hypot(a.vx, a.vy)).toBeGreaterThan(5);
  });
  it('ambient letters move with the current and stay as many: one that leaves is born again inside', () => {
    const rand = seeded(3);
    let ms = Array.from({ length: 50 }, () => ambient(800, 600, rand));
    const x0 = ms.map((m) => [m.x, m.y]);
    for (let i = 0; i < 60; i++) ms = step(ms, { ...base, t: i / 30, rand });
    expect(ms).toHaveLength(50);
    expect(ms.filter((m, i) => Math.hypot(m.x - x0[i][0], m.y - x0[i][1]) > 3).length).toBeGreaterThan(25);
    const gone = { ...ambient(800, 600, rand), x: 900 };
    const [back] = step([gone], { ...base, rand });
    expect(back.x).toBeLessThanOrEqual(800);
    expect(back.age).toBe(0);
  });
  it('the pointer pushes letters away', () => {
    const rand = seeded(5);
    const run = (pointer: { x: number; y: number } | null) => {
      let ms = [{ ...ambient(800, 600, seeded(5)), x: 400, y: 300, vx: 0, vy: 0, age: 1, span: 99 }];
      for (let i = 0; i < 10; i++) ms = step(ms, { ...base, rand: seeded(7), pointer });
      return ms[0].x;
    };
    // the pointer on its left: the letter ends up well to the right of where the current alone takes it
    expect(run({ x: 400 - PART_R / 3, y: 300 }) - run(null)).toBeGreaterThan(12);
    void rand;
  });
  it('what you type floats up in the accent, fades into the field and is gone after a few seconds; spaces are not letters', () => {
    const rand = seeded(9);
    const g = typed('a b', { x: 100, y: 500 }, rand);
    expect(g.map((m) => m.ch)).toEqual(['a', 'b']);
    expect(g.every((m) => m.vy < 0 && m.accent === 1 && m.guest)).toBe(true);
    let ms = g;
    for (let i = 0; i < 30 * 3; i++) ms = step(ms, { ...base, t: i / 30, rand });
    expect(ms.length).toBeGreaterThan(0);
    expect(ms[0].accent).toBeLessThan(0.4);
    for (let i = 0; i < 30 * 5; i++) ms = step(ms, { ...base, t: i / 30, rand });
    expect(ms).toHaveLength(0);
    expect(typed('一二三四五六七八', { x: 0, y: 0 }, rand)).toHaveLength(6);
  });
  it('a click throws a ring of letters outwards', () => {
    const s = splash({ x: 50, y: 50 }, seeded(2));
    expect(s).toHaveLength(14);
    const angles = s.map((m) => Math.atan2(m.vy, m.vx));
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(5);
  });
  it('ambient letters fade in when born and out at the end of their span', () => {
    const m = { ...ambient(10, 10, seeded(1)), age: 0, span: 10 };
    expect(moteAlpha(m)).toBe(0);
    expect(moteAlpha({ ...m, age: 5 })).toBe(1);
    expect(moteAlpha({ ...m, age: 9.9 })).toBeLessThan(0.1);
  });
});

describe('背景动画 (A6)', () => {
  it('the new switch wins', () => {
    expect(backdropOn({ 'ui.backdropMotion': false })).toBe(false);
    expect(backdropOn({ 'ui.backdropMotion': true, 'ui.welcomeBackdrop': 'off' })).toBe(true);
  });
  it('unset: still by default (redesign 2026-11); only an explicit old pick of 字流 / 字场 moves', () => {
    expect(backdropOn({ 'ui.welcomeBackdrop': 'off' })).toBe(false);
    expect(backdropOn({ 'ui.welcomeBackdrop': false })).toBe(false);
    expect(backdropOn({ 'ui.welcomeBackdrop': 'field' })).toBe(true);
    expect(backdropOn({})).toBe(false);
  });
  it('switched off on purpose is not the same as left alone', () => {
    expect(backdropOff({})).toBe(false);
    expect(backdropOff({ 'ui.backdropMotion': false })).toBe(true);
    expect(backdropOff({ 'ui.welcomeBackdrop': 'off' })).toBe(true);
    expect(backdropOff({ 'ui.backdropMotion': true })).toBe(false);
  });
});
