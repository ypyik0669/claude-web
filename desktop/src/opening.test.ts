import { describe, expect, it } from 'vitest';
import {
  CAFE, CAFE_SCRIPT_URL, DRAWN_KINDS, IGNITE, LOGO_HOLD, LOGO_TARGET, LOGO_TARGET_MAC, OPENING_CREDIT, OPENING_END_MS, OPENING_MAX_SECONDS, OPENING_MIN_MS, PACK_CSP, SCENES,
  ease, fancyOpeningHtml, filmTimes, frameAt, isDrawnKind, logoTarget, openingCsp, openingHold, openingHtml, openingLength, packHead, setOpeningNote, type FancyOpeningOptions,
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
  // (the config starts with its first key: a web pack's head inside it has a `)({` of its own, in a JSON string)
  const i = js.lastIndexOf(')({"kind":');
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
  it('the logo lands on the sidebar\'s logo: after the traffic lights on a Mac; a preview passes the one on screen', () => {
    expect(logoTarget('win32')).toEqual(LOGO_TARGET);
    expect(logoTarget('linux')).toEqual(LOGO_TARGET);
    expect(logoTarget('darwin')).toEqual(LOGO_TARGET_MAC);
    expect(LOGO_TARGET_MAC.x).toBeGreaterThan(84);
    expect(configOf(video()).target).toEqual(LOGO_TARGET);
    expect(configOf(video({ target: logoTarget('darwin') })).target).toEqual(LOGO_TARGET_MAC);
    expect(configOf(video({ mode: 'preview', target: { x: 40.5, y: 30, size: 25 } })).target).toEqual({ x: 40.5, y: 30, size: 25 });
  });
});

const cspOf = (h: string) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(h)![1];
const drawn = (kind: 'ignite' | 'stars' | 'ascii', o: Partial<FancyOpeningOptions> = {}) => fancyOpeningHtml({ kind, lang: 'zh', title: 'Claude Web', full: true, sound: false, ground: '#12110f', dark: true, text: TEXT, ...o });

describe('开场动画 · 星图 / 字符雨 (轻量版的另外两幕)', () => {
  it('the three drawn scenes and their timelines (the proposal demo\'s): 点火 and 星图 alike, 字符雨 a little later', () => {
    expect(DRAWN_KINDS).toEqual(['ignite', 'stars', 'ascii']);
    expect(SCENES.stars).toEqual(SCENES.ignite);
    expect(SCENES.ascii).toEqual({ word: 2.1, out: 3.75, end: 4.4 });
    expect(IGNITE).toBe(SCENES.ignite);
    expect([isDrawnKind('stars'), isDrawnKind('ascii'), isDrawnKind('cafe'), isDrawnKind('video')]).toEqual([true, true, false, false]);
  });
  it('full about 4 s, 简短 about 2 s until the wordmark waits', () => {
    expect(openingLength({ kind: 'stars', full: true })).toBe(3700);
    expect(openingLength({ kind: 'stars', full: false })).toBe(1850);
    expect(openingLength({ kind: 'ascii', full: true })).toBe(3750);
    expect(openingLength({ kind: 'ascii', full: false })).toBeCloseTo(1875, 6);
  });
  it('one page each: no film, no sound button, the glow behind the logo, the wordmark 「by Super NB」; the script runs its own config', () => {
    for (const kind of ['stars', 'ascii'] as const) {
      const h = drawn(kind);
      expect(h).not.toContain('<video');
      expect(h).not.toContain('class="snd"');
      expect(h).toMatch(/<div class="glow">/);
      expect(h).toContain('<span>by</span>Super NB</div>');
      expect(h).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(configOf(h)).toMatchObject({ kind, mode: 'splash', dark: true, groundDark: true, cafe: null, web: null });
      expect(() => new Function(scriptOf(h))).not.toThrow();
      // nothing is loaded: no media, no scripts from anywhere
      expect(cspOf(h)).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src 'none'");
    }
  });
  it('on a light ground: the light palette (the page says so with `lt`)', () => {
    const h = drawn('ascii', { dark: false, ground: '#f7f6f2' });
    expect(h).toMatch(/<main class="st lt"/);
    expect(configOf(h)).toMatchObject({ dark: false, groundDark: false });
  });
  it('a card\'s preview (`thumb`): the scene alone, no drag strip; it loops and never flies (the player knows by the mode)', () => {
    const h = drawn('stars', { mode: 'thumb', full: false, ground: '#13110e' });
    expect(h).toMatch(/<main class="st thumb"/);
    expect(h).not.toContain('class="drag"');
    expect(h).toContain('.thumb .bar,.thumb .snd,.thumb .hint,.thumb .tap,.thumb .note{display:none!important}');
    expect(configOf(h)).toMatchObject({ mode: 'thumb', full: false });
    expect(scriptOf(h)).toMatch(/thumb\s*&&\s*phase\s*===\s*["']hold["']/);
  });
});

describe('开场动画 · 网吧开门', () => {
  const cafe = (o: Partial<FancyOpeningOptions> = {}) => fancyOpeningHtml({ kind: 'cafe', lang: 'zh', title: 'Claude Web', full: true, sound: false, ground: '#f7f6f2', dark: false, cafe: { src: CAFE_SCRIPT_URL, sign: 'Claude 网吧', room: '包间' }, text: TEXT, ...o });
  it('the 3D cafe on its canvas, the logo lighting up over it (dark like the film); 点火 waits hidden for a machine without WebGL', () => {
    const h = cafe();
    expect(h).toContain('<canvas class="cafe" aria-hidden="true"></canvas>');
    expect(h).toMatch(/<main class="st lit"/);
    expect(h).toContain('<div class="glow" hidden></div>');
    expect(configOf(h)).toMatchObject({ kind: 'cafe', dark: true, groundDark: false, cafe: { src: 'cw-opening://app/cafe-opening.js', sign: 'Claude 网吧', room: '包间' } });
    // no WebGL, no script, no first frame by CAFE.load: 点火 (on the ground's own palette)
    const js = scriptOf(h);
    expect(js).toContain('webgl2');
    expect(js).toMatch(/fallback\(\)/);
    expect(() => new Function(js)).not.toThrow();
  });
  it('its script comes from the shell\'s own scheme at a start, from the app in a preview — nothing else', () => {
    expect(cspOf(cafe())).toBe("default-src 'none'; script-src 'unsafe-inline' cw-opening:; style-src 'unsafe-inline'; img-src data:; media-src 'none'");
    const p = cafe({ mode: 'preview', cafe: { src: 'http://127.0.0.1:4321/opening/cafe-opening.js', sign: 'x', room: 'y' } });
    expect(cspOf(p)).toContain("script-src 'unsafe-inline' http://127.0.0.1:4321;");
  });
  it('about 4.5 s full, 2.3 s 简短 (the logo phase twice as fast too)', () => {
    expect(openingLength({ kind: 'cafe', full: true })).toBeCloseTo((CAFE.lit + LOGO_HOLD) * 1000, 6);
    expect(openingLength({ kind: 'cafe', full: false })).toBeCloseTo((CAFE.litShort + LOGO_HOLD / 2) * 1000, 6);
  });
});

describe('开场动画 · 网页包 (index.html in a sandboxed frame)', () => {
  const web = (o: Partial<FancyOpeningOptions> = {}) => fancyOpeningHtml({ kind: 'web', lang: 'zh', title: 'Claude Web', full: true, sound: false, ground: '#12110f', dark: true, web: { html: null, maxSeconds: 9 }, text: TEXT, ...o });
  it('a start asks the shell for the page (it is not in the data: URL); the frame is sandboxed, never clicked, cut at its limit', () => {
    const h = web();
    const cfg = configOf(h);
    expect(cfg).toMatchObject({ kind: 'web', maxSeconds: 9, web: { html: null } });
    expect(cfg.web.head).toBe(packHead({ full: true, dark: true, trial: false }));
    const js = scriptOf(h);
    expect(js).toContain('openingPack');
    expect(js).toMatch(/setAttribute\(["']sandbox["'],\s*["']allow-scripts["']\)/);
    expect(h).toContain('.pack{pointer-events:none');
    expect(js).toMatch(/e >= cfg\.maxSeconds/);
    expect(() => new Function(js)).not.toThrow();
    expect(openingLength({ kind: 'web', full: true, maxSeconds: 9 })).toBe((9 + LOGO_HOLD) * 1000);
    expect(openingLength({ kind: 'web', full: true, maxSeconds: 40 })).toBe((OPENING_MAX_SECONDS + LOGO_HOLD) * 1000);
  });
  it('the page\'s CSP lets a pack have data: / blob: images, media and fonts — still nothing from the network, no eval', () => {
    const c = cspOf(web());
    expect(c).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:");
    expect(c).not.toMatch(/https?:|connect-src|unsafe-eval/);
    expect(openingCsp('web', 'preview')).toBe(c);
  });
  it('the pack\'s own head: its CSP first (no fetch, no frames, no workers, no forms), no DNS prefetch, the boot script', () => {
    expect(PACK_CSP).toContain("connect-src 'none'");
    expect(PACK_CSP).toContain("frame-src 'none'");
    expect(PACK_CSP).toContain("worker-src 'none'");
    expect(PACK_CSP).toContain("form-action 'none'");
    expect(PACK_CSP).not.toMatch(/https?:|unsafe-eval/);
    const head = packHead({ full: false, dark: true, trial: true });
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<script>'));
    expect(head).toContain('x-dns-prefetch-control');
    const boot = head.slice(head.indexOf('<script>') + 8, head.lastIndexOf('</script>'));
    expect(() => new Function(boot)).not.toThrow();
    expect(boot).toContain('RTCPeerConnection');
    expect(boot).toContain('cwOpening');
    expect(boot).toMatch(/\{"full":false,"dark":true,"trial":true\}/);
  });
  it('a preview carries the page; a `</script>` in it cannot end the page\'s script', () => {
    const p = web({ mode: 'preview', web: { html: '<script>cwOpening.done()</script></script><b>x', maxSeconds: 12 }, trial: true });
    expect(scriptOf(p)).not.toContain('</script>');
    expect(configOf(p)).toMatchObject({ mode: 'preview', trial: true, web: { html: '<script>cwOpening.done()</script></script><b>x' } });
  });
});
