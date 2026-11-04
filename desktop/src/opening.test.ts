import { describe, expect, it } from 'vitest';
import { OPENING_END_MS, OPENING_MIN_MS, ease, frameAt, openingHold, openingHtml, setOpeningNote } from './opening';

describe('开场动画', () => {
  it('the kit easing: quintic smoothstep, clamped', () => {
    expect([ease(-1), ease(0), ease(0.5), ease(1), ease(2)]).toEqual([0, 0, 0.5, 1, 1]);
  });
  it('the kit timeline: Claude by 0.24 s, Web revealed and the stroke gone by 1 s, the credit in place by 1.17 s', () => {
    expect(frameAt(0)).toMatchObject({ claude: 0, webClip: 100, stroke: 0, credit: 0 });
    expect(frameAt(0.24).claude).toBe(1);
    expect(frameAt(0.84).webClip).toBeCloseTo(0, 9);
    expect(frameAt(1).strokeOpacity).toBeCloseTo(0, 9);
    expect(frameAt(1.2)).toMatchObject({ credit: 1, creditY: 0 });
    expect(frameAt(1.17).credit).toBeCloseTo(1, 6);
    expect(OPENING_END_MS).toBe(1450);
  });
  it('holds the app back only until the opening has played', () => {
    expect(openingHold(1000, 1000)).toBe(OPENING_MIN_MS);
    expect(openingHold(1000, 1000 + 900)).toBe(OPENING_MIN_MS - 900);
    expect(openingHold(1000, 1000 + 15_000)).toBe(0);
  });
  it('one self-contained page: the kit wordmark and logo, reduced motion honoured, no preview tools, the note escaped', () => {
    const h = openingHtml({ dark: false, lang: 'zh', title: 'Claude Web', note: '<b>慢</b>' });
    expect(h).toContain('<span class="op-claude">Claude</span><span class="op-web">Web</span>');
    expect(h).toContain('#faf9f6');
    expect(h).toContain('fill="#FF5A1F"');
    expect(h).toContain('prefers-reduced-motion: reduce');
    expect(h).not.toMatch(/replay|__opening|https?:\/\/(?!www\.w3\.org)/);
    expect(h).toContain('&lt;b&gt;慢&lt;/b&gt;');
    expect(openingHtml({ dark: true, lang: 'en', title: 'x' })).toContain('#12110f');
    expect(setOpeningNote('a"b')).toBe('window.__setNote&&window.__setNote("a\\"b")');
  });
});

describe('开场动画 · waiting line', () => {
  it('a long start gets a quiet line after the opening; the slow-start note replaces it; the script parses', () => {
    const h = openingHtml({ dark: false, lang: 'zh', title: 'x', waiting: '正在启动…' });
    const js = h.slice(h.indexOf('<script>') + 8, h.indexOf('</script>'));
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain('"正在启动…"');
    expect(js).toMatch(/__setNote=\(s\)=>\{clearTimeout\(waitT\)/);
  });
});
