import { describe, expect, it } from 'vitest';
import {
  IGNITE, LOGO_HOLD, OPENING_CREDIT, OPENING_END_MS, OPENING_MAX_SECONDS, OPENING_MIN_MS, ease, fancyOpeningHtml, filmTimes, frameAt,
  openingHold, openingHtml, openingLength, setOpeningNote, type FancyOpeningOptions,
} from './opening';

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
  it('the credit is 「by Super NB」 (界面改版方案 第 7 版), on the page and in its accessible name', () => {
    expect(OPENING_CREDIT).toBe('Super NB');
    const h = openingHtml({ dark: false, lang: 'zh', title: 'x' });
    expect(h).toContain('<span class="op-by">by</span> Super NB');
    expect(h).toContain('aria-label="Claude Web · by Super NB"');
    expect(h).not.toMatch(/by<\/span> Super</);
  });
  it('`still` (开场 set to 不放): the last frame at once, no frames asked for', () => {
    const js = scriptOf(openingHtml({ dark: false, lang: 'zh', title: 'x', still: true }));
    expect(js).toContain('still=true');
    expect(js).toMatch(/render\(still\|\|motion\.matches\?END:0\)/);
    expect(scriptOf(openingHtml({ dark: false, lang: 'zh', title: 'x' }))).toContain('still=false');
  });
});

describe('开场动画 · waiting line', () => {
  it('a long start gets a quiet line after the opening; the slow-start note replaces it; the script parses', () => {
    const h = openingHtml({ dark: false, lang: 'zh', title: 'x', waiting: '正在启动…' });
    const js = scriptOf(h);
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain('"正在启动…"');
    expect(js).toMatch(/__setNote=\(s\)=>\{clearTimeout\(waitT\)/);
  });
});

function scriptOf(h: string) {
  return h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));
}

const TEXT = { skip: '点一下跳过', waiting: '正在启动…', soundOn: '开声音', soundOff: '关声音', tap: '点一下播放' };
const video = (o: Partial<FancyOpeningOptions> = {}) => fancyOpeningHtml({
  kind: 'video', lang: 'zh', title: 'Claude Web', full: true, sound: false, ground: '#12110f', dark: true,
  video: { intro: 'cw-opening://pack/claude-web-chan/intro.mp4', logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 }, text: TEXT, ...o,
});
/** the page's script parsed and its config taken back out */
function configOf(h: string) {
  const js = scriptOf(h);
  const i = js.lastIndexOf(')({');
  expect(i > 0 && js.endsWith('});'), 'the script ends with (player)(config);').toBe(true);
  return JSON.parse(js.slice(i + 2, -2));
}

describe('开场动画 · 人设版 / 点火', () => {
  it('film times: at most 12 s of film, the logo inside it, 简短 starting before the logo', () => {
    expect(filmTimes({ logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 })).toEqual({ logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 });
    expect(filmTimes({})).toEqual({ logoAt: null, shortFrom: 0, maxSeconds: OPENING_MAX_SECONDS });
    expect(filmTimes({ logoAt: 30, maxSeconds: 99 })).toMatchObject({ logoAt: 12, maxSeconds: 12 });
    expect(filmTimes({ logoAt: 5, shortFrom: 9 }).shortFrom).toBe(4);
    expect(filmTimes({ logoAt: -1, shortFrom: 'x', maxSeconds: 0 })).toEqual({ logoAt: null, shortFrom: 0, maxSeconds: 12 });
  });
  it('how long until the wordmark waits (the shell watchdog): the film from its start, then the logo phase', () => {
    expect(openingLength({ kind: 'video', full: true, logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 })).toBeCloseTo((9.71 + LOGO_HOLD) * 1000, 6);
    expect(openingLength({ kind: 'video', full: false, logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12 })).toBeCloseTo((9.71 - 6.6 + LOGO_HOLD) * 1000, 6);
    expect(openingLength({ kind: 'ignite', full: true })).toBe(IGNITE.out * 1000);
    expect(openingLength({ kind: 'ignite', full: false })).toBe((IGNITE.out / 2) * 1000);
  });
  it('one page with everything in it: the film, the logo, the wordmark 「by Super NB」, the sound button, the skip hint', () => {
    const h = video();
    expect(h).toContain('<video class="film"');
    expect(h).toContain('<span class="c">Claude</span><span class="w">Web</span>');
    expect(h).toContain('<span>by</span>Super NB</div>');
    expect(h).toContain('class="snd" aria-pressed="false" aria-label="开声音"');
    expect(h).toContain('<div class="hint">点一下跳过</div>');
    expect(h).toContain('fill="#FF5A1F"');
    // the window can still be moved by its top strip; nothing is fetched from the network
    expect(h).toContain('-webkit-app-region:drag');
    expect(h).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(configOf(h)).toMatchObject({ kind: 'video', mode: 'splash', full: true, sound: false, logoAt: 9.71, shortFrom: 6.6, maxSeconds: 12, intro: 'cw-opening://pack/claude-web-chan/intro.mp4' });
  });
  it('the script is the player and nothing from outside it: it parses and runs its own config', () => {
    const js = scriptOf(video());
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain('openingWait');
    expect(js).toContain('openingDone');
    expect(js).toContain('openingSound');
    // (the quotes are whatever the build made of the source)
    expect(js).toMatch(/matchMedia\(["']\(prefers-reduced-motion: reduce\)["']\)/);
  });
  it('a `</script>` in a text cannot end the script early', () => {
    const h = video({ text: { ...TEXT, waiting: '</script><b>x' } });
    expect(scriptOf(h)).not.toContain('</script>');
    expect(configOf(h).text.waiting).toBe('</script><b>x');
  });
  it('the film is always dark; the page ends on the app\'s ground; a preview ends on transparent, no drag strip', () => {
    expect(configOf(video({ dark: false, ground: '#f7f6f2' })).dark).toBe(true);
    expect(video({ ground: '#f7f6f2' })).toContain('background:#f7f6f2');
    const p = video({ mode: 'preview', ground: 'transparent', colorScheme: 'light' });
    expect(p).toContain('background:transparent');
    expect(p).toContain(':root{color-scheme:light}');
    expect(p).not.toContain('class="drag"');
    expect(configOf(p).mode).toBe('preview');
  });
  it('点火: no film and no sound button; its palette follows the ground; 简短 is the same scene twice as fast', () => {
    const h = fancyOpeningHtml({ kind: 'ignite', lang: 'en', title: 'Claude Web', full: false, sound: true, ground: '#f7f6f2', dark: false, text: TEXT });
    expect(h).not.toContain('<video');
    expect(h).not.toContain('class="snd"');
    expect(h).toContain('class="glow"');
    expect(h).toContain('lang="en"');
    expect(configOf(h)).toMatchObject({ kind: 'ignite', dark: false, full: false });
    expect(() => new Function(scriptOf(h))).not.toThrow();
  });
  it('motion reduced in the app: the config says so (the page shows its last frame only)', () => {
    expect(configOf(video({ reduced: true })).reduced).toBe(true);
    expect(configOf(video()).reduced).toBe(false);
  });
});
