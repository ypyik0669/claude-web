import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WindowApp } from './apps.js';
import { NEED_SCREENSHOT } from './coords.js';
import { INPUT_TOOLS, NO_GRANT_TEXT } from './grants.js';
import { HelperError, type HelperLike } from './helper-win.js';
import { ComputerService, UNSUPPORTED_TEXT, type ToolAnswer } from './service.js';
import { TOOL_NAMES } from './tools.js';

const SELF_EXE = 'C:\\Program Files\\Claude Web\\Claude Web.exe';

interface Win extends WindowApp { rect: [number, number, number, number] }
const win = (hwnd: number, name: string, description: string, title: string, rect: Win['rect'], exe = `C:\\Apps\\${name}.exe`): Win => ({ hwnd, pid: hwnd + 1000, name, exe, description, product: description, title, rect });

/** Ops that put input into the machine — what must never be reached when the gate says no. */
const INPUT_OPS = new Set(['click', 'drag', 'scroll', 'down', 'up', 'type', 'keys', 'hold', 'clipset']);

/**
 * A desktop that exists only here: windows front to back on a 1920x1080 screen (seen as 1568x882), a pointer, a
 * clipboard. It checks `expect` the way the real helper does, and records every request.
 */
class FakeDesktop implements HelperLike {
  wins: Win[] = [];
  fg: number | null = null;
  cursor = { x: 5, y: 5 };
  clipboard: string | null = 'copied earlier';
  ops: Array<{ op: string; args: Record<string, any> }> = [];
  closed = false;
  /** run after a probe was answered: the instant between the look and the act */
  afterProbe: (() => void) | null = null;
  /** op → a canned answer, or an error to throw */
  canned: Record<string, Record<string, any> | Error | ((args: Record<string, any>) => Record<string, any>)> = {};
  startApps: Array<{ name: string; appId: string }> = [];
  /** what a launch makes appear */
  onLaunch: ((args: Record<string, any>) => void) | null = null;
  held = false;

  private info(w: Win | undefined | null): WindowApp | null {
    if (!w) return null;
    const { rect: _rect, ...app } = w;
    return app;
  }
  at(x: number, y: number): Win | undefined {
    return this.wins.find((w) => x >= w.rect[0] && y >= w.rect[1] && x < w.rect[0] + w.rect[2] && y < w.rect[1] + w.rect[3]);
  }
  private front(): Win | undefined { return this.wins.find((w) => w.hwnd === this.fg); }
  private selfish(w: Win | undefined): boolean {
    return !!w && (w.title.toLowerCase().includes('claude web') || w.exe.toLowerCase() === SELF_EXE.toLowerCase());
  }
  private check(args: Record<string, any>, pts: Array<[number, number]>): Record<string, any> | null {
    const e = args.expect;
    if (!e || e.fg == null) return { ok: false, unchecked: true, sent: 0, error: 'no expectation given' };
    if (this.fg !== e.fg) return { ok: false, changed: true, sent: 0, error: 'the window in front changed' };
    if (this.selfish(this.front())) return { ok: false, self: true, sent: 0, error: 'Claude Web itself is in the way' };
    for (let i = 0; i < pts.length; i++) {
      const w = this.at(pts[i][0], pts[i][1]);
      if (!w) return { ok: false, changed: true, sent: 0, error: 'the window in front changed' };
      if (this.selfish(w)) return { ok: false, self: true, sent: 0, error: 'Claude Web itself is in the way' };
      if (w.hwnd !== e.under?.[i]?.hwnd && w.pid !== e.under?.[i]?.pid) return { ok: false, changed: true, sent: 0, error: 'the window in front changed' };
    }
    return null;
  }

  async call(op: string, args: Record<string, any> = {}): Promise<Record<string, any>> {
    this.ops.push({ op, args });
    const canned = this.canned[op];
    if (canned instanceof Error) throw canned;
    if (typeof canned === 'function') return canned(args);
    if (canned) return canned;
    const here: [number, number] = [this.cursor.x, this.cursor.y];
    switch (op) {
      case 'probe': {
        const under = (args.points as Array<[number, number] | null>).map((p) => this.info(p ? this.at(p[0], p[1]) : this.at(...here)));
        const r = { ok: true, fg: this.info(this.front()), cursor: { ...this.cursor }, under };
        const then = this.afterProbe;
        this.afterProbe = null;
        then?.();
        return r;
      }
      case 'apps': return { ok: true, apps: this.wins.map((w) => this.info(w)), fg: this.info(this.front()) };
      case 'screenshot': return { ok: true, data: 'U0hPVA==', w: 1568, h: 882, rect: { x: 0, y: 0, width: 1920, height: 1080 }, fg: this.info(this.front()) };
      case 'zoom': return { ok: true, data: 'Wk9PTQ==', w: args.width, h: args.height, rect: { x: args.x, y: args.y, width: args.width, height: args.height } };
      case 'cursor': return { ok: true, ...this.cursor };
      case 'move': {
        if ('expect' in args) { const c = this.check(args, [[args.x, args.y]]); if (c) return c; }
        this.cursor = { x: args.x, y: args.y };
        return { ok: true, ...this.cursor };
      }
      case 'click':
      case 'scroll': {
        const c = this.check(args, [[args.x, args.y]]);
        if (c) return c;
        this.cursor = { x: args.x, y: args.y };
        if (op === 'click') this.fg = this.at(args.x, args.y)!.hwnd; // a click brings its window forward
        return { ok: true };
      }
      case 'drag': {
        const from: [number, number] = args.fx == null ? here : [args.fx, args.fy];
        const c = this.check(args, [from, [args.x, args.y]]);
        if (c) return c;
        this.cursor = { x: args.x, y: args.y };
        return { ok: true };
      }
      case 'down': { const c = this.check(args, [here]); if (c) return c; this.held = true; return { ok: true }; }
      case 'up': { if (!args.force) { const c = this.check(args, [here]); if (c) return c; } this.held = false; return { ok: true }; }
      case 'type': { const c = this.check(args, []); if (c) return c; return { ok: true, sent: args.text.length }; }
      case 'keys': { const c = this.check(args, []); if (c) return c; return { ok: true, sent: args.chords.length }; }
      case 'hold': { const c = this.check(args, []); if (c) return c; return { ok: true, heldMs: args.ms }; }
      case 'clipget': return { ok: true, text: this.clipboard };
      case 'clipset': { const c = this.check(args, []); if (c) return c; this.clipboard = args.text; return { ok: true }; }
      case 'activate': {
        const w = this.wins.find((x) => x.hwnd === args.hwnd);
        if (!w) return { ok: false, error: 'that window no longer exists' };
        this.fg = w.hwnd;
        return { ok: true, front: true, fg: this.info(w) };
      }
      case 'startapps': return { ok: true, apps: this.startApps };
      case 'launch': this.onLaunch?.(args); return { ok: true };
      default: return { ok: false, error: `unknown op ${op}` };
    }
  }
  close() { this.closed = true; }

  sent(): string[] { return this.ops.filter((o) => INPUT_OPS.has(o.op)).map((o) => o.op); }
  last(op: string): Record<string, any> | undefined { return [...this.ops].reverse().find((o) => o.op === op)?.args; }
  count(op: string): number { return this.ops.filter((o) => o.op === op).length; }
}

// front to back; the screen is 1920x1080
const NOTEPAD = () => win(11, 'notepad', 'Notepad', 'Untitled - Notepad', [0, 0, 960, 1080]);
const CHROME = () => win(22, 'chrome', 'Google Chrome', 'Example Domain - Google Chrome', [960, 0, 960, 540]);
const CLAUDE = () => win(33, 'Claude Web', 'Claude Web', 'Claude Web', [960, 540, 960, 540], SELF_EXE);
const DESKTOP = () => win(44, 'explorer', 'Windows Explorer', 'Program Manager', [0, 0, 1920, 1080]);

let desk: FakeDesktop;
let svc: ComputerService;
let slept: number[];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-computer-'));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

beforeEach(() => {
  desk = new FakeDesktop();
  desk.wins = [NOTEPAD(), CHROME(), CLAUDE(), DESKTOP()];
  desk.fg = 11;
  slept = [];
  svc = new ComputerService({ helper: desk, selfExe: SELF_EXE, shotsDir: path.join(tmp, 'shots'), sleep: async (ms) => { slept.push(ms); } });
});

const text = (r: ToolAnswer): string => r.content.filter((c) => c.type === 'text').map((c) => (c as any).text).join('\n');
const images = (r: ToolAnswer) => r.content.filter((c) => c.type === 'image');
/** screenshot px → the fake's 1920x1080 */
const real = (x: number, y: number): [number, number] => [Math.round((x + 0.5) * (1920 / 1568) - 0.5), Math.round((y + 0.5) * (1080 / 882) - 0.5)];

async function grant(...apps: string[]) {
  const r = await svc.call('request_access', { apps, reason: 'unit test' });
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r));
}
async function ready(...apps: string[]) {
  await grant(...apps);
  const shot = await svc.call('screenshot');
  expect(shot.isError).toBeFalsy();
  desk.ops = [];
}

describe('where there is no helper', () => {
  it('every tool answers that computer use is Windows-only', async () => {
    const none = new ComputerService({ helper: null });
    for (const t of TOOL_NAMES) {
      const r = await none.call(t, { apps: ['Notepad'], reason: 'r', coordinate: [1, 1], text: 'a', duration: 0, actions: [{ action: 'wait', duration: 0 }] });
      expect(r, t).toEqual({ content: [{ type: 'text', text: '操控电脑目前只支持 Windows。' }], isError: true });
    }
    expect(UNSUPPORTED_TEXT).toBe('操控电脑目前只支持 Windows。');
  });
});

describe('before the first grant', () => {
  it('nothing but request_access, list_granted_applications and wait runs — and the helper is not even asked', async () => {
    const args = { coordinate: [10, 10], text: 'a', duration: 0.01, region: [0, 0, 10, 10], scroll_direction: 'down', scroll_amount: 1, app: 'Notepad', actions: [{ action: 'screenshot' }] };
    for (const t of TOOL_NAMES) {
      if (t === 'request_access' || t === 'list_granted_applications' || t === 'wait') continue;
      const r = await svc.call(t, args);
      expect(r.isError, t).toBe(true);
      expect(text(r), t).toBe(NO_GRANT_TEXT);
    }
    expect(desk.ops).toEqual([]); // no screenshot, no look at what is in front, no clipboard
    const listed = await svc.call('list_granted_applications');
    expect(JSON.parse(text(listed))).toMatchObject({ granted: [], platform: 'win32', display: 'primary', screenshotTaken: false });
    expect((await svc.call('wait', { duration: 0.5 })).isError).toBeFalsy();
    expect(slept).toEqual([500]); // the one real wait; nothing in a refused call ran
    expect(desk.ops).toEqual([]);
  });
});

describe('request_access', () => {
  it('grants what was approved and says what each name matched', async () => {
    const out = await grant('记事本', 'Edge', 'Some Unknown App');
    expect(out.granted).toEqual([
      { app: '记事本', matched: 'running', processes: ['notepad'] },
      expect.objectContaining({ app: 'Edge', matched: 'known' }),
      expect.objectContaining({ app: 'Some Unknown App', matched: 'none' }),
    ]);
    expect(out.denied).toEqual([]);
    expect(out.allGranted).toEqual(['记事本', 'Edge', 'Some Unknown App']);
    expect(out.screenshotFiltering).toBe('none');
    expect(desk.ops.map((o) => o.op)).toEqual(['apps']); // looked at what is running; captured nothing
    // again later: earlier grants stay
    const more = await grant('Chrome');
    expect(more.allGranted).toEqual(['记事本', 'Edge', 'Some Unknown App', 'Chrome']);
    expect(JSON.parse(text(await svc.call('list_granted_applications'))).granted).toEqual(more.allGranted);
  });

  it('never grants Claude Web: by name, or a name that resolves to its executable', async () => {
    const r = await svc.call('request_access', { apps: ['Claude Web', 'claude-web', 'Notepad'], reason: 'r' });
    const out = JSON.parse(text(r));
    expect(out.denied.map((d: any) => d.app)).toEqual(['Claude Web', 'claude-web']);
    expect(out.allGranted).toEqual(['Notepad']);
    // the dev build runs as electron.exe: the name is innocent, the program is not
    desk.wins = [win(55, 'electron', 'Electron', 'Claude Web', [0, 0, 500, 500], SELF_EXE)];
    desk.fg = 55;
    const dev = await svc.call('request_access', { apps: ['Electron'], reason: 'r' });
    expect(dev.isError).toBe(true);
    expect(JSON.parse(text(dev)).denied[0].reason).toContain('Claude Web itself');
    expect(svc.grants.names()).toEqual(['Notepad']);
  });

  it('nothing granted is an error result; malformed requests say what is wrong', async () => {
    const all = await svc.call('request_access', { apps: ['Claude Web'], reason: 'r' });
    expect(all.isError).toBe(true);
    expect(svc.grants.any()).toBe(false);
    for (const bad of [{}, { apps: [], reason: 'r' }, { apps: 'Notepad', reason: 'r' }, { apps: [1], reason: 'r' }, { apps: ['Notepad'] }, { apps: ['Notepad'], reason: '  ' }, { apps: Array(21).fill('Notepad'), reason: 'r' }]) {
      const r = await svc.call('request_access', bad as any);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(svc.grants.any()).toBe(false);
  });

  it('records the extra flags it was asked with', async () => {
    const r = await svc.call('request_access', { apps: ['Notepad'], reason: 'r', clipboardRead: true, systemKeyCombos: true });
    expect(JSON.parse(text(r)).flags).toEqual({ clipboardRead: true, clipboardWrite: false, systemKeyCombos: true });
  });

  describe('with someone to ask (Claude Web puts the request to the user itself)', () => {
    type Ask = Parameters<NonNullable<ConstructorParameters<typeof ComputerService>[0]['approve']>>[0];
    const asking = (answer: (a: Ask) => { granted: true } | { granted: false; message: string }) => {
      const asked: Ask[] = [];
      const s = new ComputerService({ helper: desk, selfExe: SELF_EXE, sleep: async () => {}, approve: async (a) => { asked.push(a); return answer(a); } });
      return { s, asked };
    };

    it('nothing is granted until the user says yes: only the names that could be granted are put to them, with the reason and the flags', async () => {
      const { s, asked } = asking(() => ({ granted: true }));
      const r = await s.call('request_access', { apps: ['Notepad', 'Claude Web', ' Chrome '], reason: '  write the note  ', clipboardWrite: true });
      expect(asked).toEqual([{ apps: ['Notepad', 'Chrome'], reason: 'write the note', clipboardRead: false, clipboardWrite: true, systemKeyCombos: false }]);
      const out = JSON.parse(text(r));
      expect(r.isError).toBeFalsy();
      expect(out.granted.map((g: any) => g.app)).toEqual(['Notepad', 'Chrome']);
      expect(out.denied.map((d: any) => d.app)).toEqual(['Claude Web']);
      expect(out.flags).toEqual({ clipboardRead: false, clipboardWrite: true, systemKeyCombos: false });
      expect(s.grants.names()).toEqual(['Notepad', 'Chrome']);
    });

    it('a no grants nothing — not the names, not the flags — and what the user said is what the model reads; earlier grants stay', async () => {
      let say: { granted: true } | { granted: false; message: string } = { granted: true };
      const { s, asked } = asking(() => say);
      await s.call('request_access', { apps: ['Notepad'], reason: 'r' });
      say = { granted: false, message: 'The user declined: 别碰浏览器. Nothing was granted.' };
      const r = await s.call('request_access', { apps: ['Chrome'], reason: 'look something up', clipboardRead: true, systemKeyCombos: true });
      expect(r.isError).toBe(true);
      const out = JSON.parse(text(r));
      expect(out.granted).toEqual([]);
      expect(out.denied).toEqual([{ app: 'Chrome', reason: 'The user declined: 别碰浏览器. Nothing was granted.' }]);
      expect(out.allGranted).toEqual(['Notepad']);
      expect(s.grants.names()).toEqual(['Notepad']);
      expect(s.grants.flags).toEqual({ clipboardRead: false, clipboardWrite: false, systemKeyCombos: false });
      expect(asked).toHaveLength(2);
      // and input to what was refused is still refused
      desk.fg = 22;
      await s.call('screenshot');
      const click = await s.call('left_click', { coordinate: [1200, 200] });
      expect(click.isError).toBe(true);
      expect(text(click)).toContain('not a granted application');
    });

    it('the user is not asked about a request that could not be granted anyway, or a malformed one', async () => {
      const { s, asked } = asking(() => ({ granted: true }));
      expect((await s.call('request_access', { apps: ['Claude Web'], reason: 'r' })).isError).toBe(true);
      expect((await s.call('request_access', { apps: ['Notepad'] } as any)).isError).toBe(true);
      expect((await s.call('request_access', { apps: [], reason: 'r' })).isError).toBe(true);
      expect(asked).toEqual([]);
      expect(s.grants.any()).toBe(false);
    });
  });

  it('when the helper cannot start, nothing is granted and the reason is passed on', async () => {
    desk.canned.apps = new HelperError('启动不了 PowerShell：spawn ENOENT');
    const r = await svc.call('request_access', { apps: ['Notepad'], reason: 'r' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('操控电脑的辅助进程出了问题：启动不了 PowerShell：spawn ENOENT');
    expect(svc.grants.any()).toBe(false);
  });
});

describe('coordinates need a screenshot', () => {
  it('take a screenshot first — and nothing is sent', async () => {
    await grant('Notepad');
    desk.ops = [];
    for (const [t, a] of [
      ['left_click', { coordinate: [10, 10] }], ['right_click', { coordinate: [10, 10] }], ['middle_click', { coordinate: [10, 10] }],
      ['double_click', { coordinate: [10, 10] }], ['triple_click', { coordinate: [10, 10] }], ['mouse_move', { coordinate: [10, 10] }],
      ['left_click_drag', { coordinate: [10, 10] }], ['left_click_drag', { coordinate: [10, 10], start_coordinate: [1, 1] }],
      ['scroll', { coordinate: [10, 10], scroll_direction: 'down', scroll_amount: 3 }], ['zoom', { region: [0, 0, 10, 10] }],
    ] as const) {
      const r = await svc.call(t, a as any);
      expect(r.isError, t).toBe(true);
      expect(text(r), t).toBe(NEED_SCREENSHOT);
    }
    expect(desk.ops).toEqual([]);
    expect(NEED_SCREENSHOT.toLowerCase()).toContain('take a screenshot first');
  });

  it('a position outside the screenshot is refused before anything is asked of the helper', async () => {
    await ready('Notepad');
    const r = await svc.call('left_click', { coordinate: [1900, 1000] }); // real pixels, not screenshot pixels
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('outside the screenshot');
    expect(desk.ops).toEqual([]);
  });
});

describe('screenshot', () => {
  it('is an image and a line of text: the size, and who is in front', async () => {
    await grant('Notepad');
    const r = await svc.call('screenshot');
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toEqual({ type: 'image', data: 'U0hPVA==', mimeType: 'image/jpeg' });
    expect(text(r)).toContain('1568x882 px');
    expect(text(r)).toContain('1920x1080');
    expect(text(r)).toContain('In front: "Notepad" — granted.');
    expect(desk.last('screenshot')).toEqual({ maxEdge: 1568, quality: 75 });
    desk.fg = 22;
    expect(text(await svc.call('screenshot'))).toContain('In front: "Google Chrome" (process chrome) — not granted');
    desk.fg = 33;
    expect(text(await svc.call('screenshot'))).toContain('In front: Claude Web itself');
    desk.fg = null;
    expect(text(await svc.call('screenshot'))).toContain('No window is in front.');
    expect(desk.sent()).toEqual([]);
  });

  it('save_to_disk writes the picture and says where', async () => {
    await grant('Notepad');
    const r = await svc.call('screenshot', { save_to_disk: true });
    const m = /Saved to (.+\.jpg)/.exec(text(r));
    expect(m).toBeTruthy();
    expect(fs.readFileSync(m![1]).toString()).toBe('SHOT');
    expect(path.dirname(m![1])).toBe(path.join(tmp, 'shots'));
  });

  it('a capture that fails is an error the model can read', async () => {
    await grant('Notepad');
    desk.canned.screenshot = { ok: false, error: 'The handle is invalid' };
    const r = await svc.call('screenshot');
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('The handle is invalid');
    expect(images(r)).toHaveLength(0);
  });
});

describe('zoom and cursor_position', () => {
  it('zoom captures the real rectangle behind a region of the screenshot', async () => {
    await ready('Notepad');
    const r = await svc.call('zoom', { region: [0, 0, 784, 441] });
    expect(r.isError).toBeFalsy();
    expect(desk.last('zoom')).toMatchObject({ x: 0, y: 0, width: 960, height: 540 });
    expect(images(r)).toHaveLength(1);
    expect(text(r)).toContain('full screenshot');
    expect((await svc.call('zoom', { region: [10, 10, 5, 5] })).isError).toBe(true);
  });

  it('the pointer is reported in screenshot coordinates once there is a screenshot', async () => {
    await grant('Notepad');
    desk.cursor = { x: 960, y: 540 };
    expect(text(await svc.call('cursor_position'))).toContain('(960, 540) in real screen pixels');
    await svc.call('screenshot');
    expect(text(await svc.call('cursor_position'))).toContain('(784, 441) in the most recent screenshot');
    desk.cursor = { x: -500, y: 300 };
    expect(text(await svc.call('cursor_position'))).toContain('outside the primary display');
  });
});

describe('clicks', () => {
  it('go to the real pixel behind the screenshot position, with what was looked at', async () => {
    await ready('Notepad');
    const r = await svc.call('left_click', { coordinate: [100, 200] });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toBe('Clicked at (100, 200).');
    const [x, y] = real(100, 200);
    expect(desk.ops.map((o) => o.op)).toEqual(['probe', 'click']);
    expect(desk.ops[0].args).toEqual({ points: [[x, y]] });
    expect(desk.last('click')).toEqual({ x, y, button: 'left', count: 1, mods: [], expect: { fg: 11, under: [{ hwnd: 11, pid: 1011 }] } });
  });

  it('each kind of click, and modifiers', async () => {
    await ready('Notepad');
    for (const [t, button, count] of [['right_click', 'right', 1], ['middle_click', 'middle', 1], ['double_click', 'left', 2], ['triple_click', 'left', 3]] as const) {
      expect((await svc.call(t, { coordinate: [50, 50] })).isError, t).toBeFalsy();
      expect(desk.last('click')).toMatchObject({ button, count });
    }
    await svc.call('left_click', { coordinate: [50, 50], text: 'ctrl+shift' });
    expect(desk.last('click')!.mods).toEqual([{ vk: 0x11 }, { vk: 0x10 }]);
    const n = desk.count('click');
    const bad = await svc.call('left_click', { coordinate: [50, 50], text: 'ctrl+a' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('not a modifier');
    expect(desk.count('click')).toBe(n);
  });

  it('are refused when the app in front is not granted: nothing is sent, and the refusal names the app', async () => {
    await ready('Notepad');
    desk.fg = 22; // Chrome in front
    for (const t of ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']) {
      const r = await svc.call(t, { coordinate: [100, 200] }); // aimed at Notepad's own window
      expect(r.isError, t).toBe(true);
      expect(text(r)).toContain('"Google Chrome" (process chrome) is in front');
      expect(text(r)).toContain('request_access');
      expect(text(r)).toContain('open_application');
    }
    expect(desk.sent()).toEqual([]);
  });

  it('are refused when the window under the position is not granted, though a granted app is in front', async () => {
    await ready('Notepad');
    const r = await svc.call('left_click', { coordinate: [1200, 100] }); // over Chrome
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('(1200, 100) is over "Google Chrome" (process chrome)');
    expect(desk.sent()).toEqual([]);
    // granted too: now it goes, and Chrome comes forward
    await grant('Chrome');
    expect((await svc.call('left_click', { coordinate: [1200, 100] })).isError).toBeFalsy();
    expect(desk.fg).toBe(22);
  });

  it('never reach Claude Web: not in front, not under the pointer, whatever is granted', async () => {
    await ready('Notepad', 'Chrome', 'Claude', 'File Explorer');
    // its approval button, while a granted app is in front
    const under = await svc.call('left_click', { coordinate: [1300, 700] });
    expect(under.isError).toBe(true);
    expect(text(under)).toContain("Claude Web's own window");
    // and with Claude Web in front, even a click aimed elsewhere
    desk.fg = 33;
    const front = await svc.call('left_click', { coordinate: [100, 200] });
    expect(front.isError).toBe(true);
    expect(text(front)).toContain('Claude Web itself is in front');
    for (const [t, a] of [['type', { text: 'y' }], ['key', { text: 'Return' }], ['hold_key', { text: 'space', duration: 0.1 }], ['write_clipboard', { text: 'x' }], ['left_mouse_down', {}]] as const) {
      const r = await svc.call(t, a as any);
      expect(r.isError, t).toBe(true);
    }
    expect(desk.sent()).toEqual([]);
  });

  it('the web version: a granted browser showing Claude Web is not a target, the same browser on another page is', async () => {
    const web = new ComputerService({ helper: desk, sleep: async () => {} }); // no CW_COMPUTER_SELF_EXE
    desk.wins = [win(66, 'chrome', 'Google Chrome', 'Claude Web - Google Chrome', [0, 0, 1920, 1080])];
    desk.fg = 66;
    await web.call('request_access', { apps: ['Chrome'], reason: 'r' });
    await web.call('screenshot');
    const r = await web.call('left_click', { coordinate: [100, 100] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Claude Web itself');
    expect((await web.call('type', { text: 'yes' })).isError).toBe(true);
    expect(desk.sent()).toEqual([]);
    desk.wins[0].title = 'Example Domain - Google Chrome';
    expect((await web.call('left_click', { coordinate: [100, 100] })).isError).toBeFalsy();
  });
});

describe('the instant between the look and the act', () => {
  it('another window comes to the front after the gate said yes: the helper sends nothing, the gate looks again and refuses', async () => {
    await ready('Notepad');
    desk.afterProbe = () => { desk.fg = 22; };
    const r = await svc.call('type', { text: 'secret' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"Google Chrome" (process chrome) is in front');
    expect(desk.ops.map((o) => o.op)).toEqual(['probe', 'type', 'probe']); // asked, told "changed", looked again
    expect(desk.clipboard).toBe('copied earlier');
  });

  it('the new window is granted as well: the second try goes through', async () => {
    await ready('Notepad', 'Chrome');
    desk.afterProbe = () => { desk.fg = 22; };
    const r = await svc.call('key', { text: 'ctrl+a' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(desk.ops.map((o) => o.op)).toEqual(['probe', 'keys', 'probe', 'keys']);
    expect(desk.last('keys')!.expect.fg).toBe(22);
  });

  it('a window that keeps changing: give up after three looks', async () => {
    await ready('Notepad', 'Chrome');
    let flip = 0;
    const flipper = () => { desk.fg = flip++ % 2 ? 11 : 22; desk.afterProbe = flipper; };
    desk.afterProbe = flipper;
    const r = await svc.call('type', { text: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('kept changing');
    expect(desk.count('probe')).toBe(3);
  });

  it('the helper itself reports Claude Web in the way: refused, not retried', async () => {
    await ready('Notepad');
    desk.canned.click = { ok: false, self: true, sent: 0 };
    const r = await svc.call('left_click', { coordinate: [100, 200] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Claude Web itself is in the way');
    expect(desk.count('click')).toBe(1);
  });
});

describe('typing and keys', () => {
  it('type sends the text as it is, Chinese included', async () => {
    await ready('Notepad');
    const r = await svc.call('type', { text: '你好, wörld\n第二行' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(desk.last('type')).toMatchObject({ text: '你好, wörld\n第二行', expect: { fg: 11, under: [] } });
    expect(text(r)).toBe('Typed 13 characters.');
    expect((await svc.call('type', { text: '' })).isError).toBe(true);
    expect((await svc.call('type', { text: 5 as any })).isError).toBe(true);
    expect((await svc.call('type', { text: 'x'.repeat(20_001) })).isError).toBe(true);
    expect(desk.count('type')).toBe(1);
  });

  it('typing that was cut short says how far it got', async () => {
    await ready('Notepad');
    desk.canned.type = { ok: false, changed: true, sent: 7 };
    const r = await svc.call('type', { text: 'hello world, hello' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('7 of 18 characters');
    expect(desk.count('type')).toBe(1); // not typed again from the start
  });

  it('key parses the combination and repeats it', async () => {
    await ready('Notepad');
    expect((await svc.call('key', { text: 'ctrl+s' })).isError).toBeFalsy();
    expect(desk.last('keys')!.chords).toEqual([[{ vk: 0x11 }, { vk: 0x53 }]]);
    const r = await svc.call('key', { text: 'Down', repeat: 3 });
    expect(text(r)).toBe('Pressed Down 3 times.');
    expect(desk.last('keys')!.chords).toHaveLength(3);
    await svc.call('key', { text: 'ctrl+a BackSpace' });
    expect(desk.last('keys')!.chords).toEqual([[{ vk: 0x11 }, { vk: 0x41 }], [{ vk: 0x08 }]]);
  });

  it('a key the server does not know is refused before anything is looked at', async () => {
    await ready('Notepad');
    for (const a of [{ text: 'cmd+c' }, { text: 'ctrl+alt+Delete' }, { text: 'banana' }, { text: '' }, {}, { text: 'a', repeat: 0 }, { text: 'a', repeat: 101 }, { text: 'a', repeat: 1.5 }]) {
      const r = await svc.call('key', a as any);
      expect(r.isError, JSON.stringify(a)).toBe(true);
    }
    expect(text(await svc.call('key', { text: 'cmd+c' }))).toContain('ctrl');
    expect(desk.ops).toEqual([]);
  });

  it('a press that puts another window in front: the rest goes through the gate again', async () => {
    await ready('Notepad', 'Chrome');
    svc.grants.flags.systemKeyCombos = true;
    // alt+Tab lands on Chrome, which is granted: the Return still goes
    let first = true;
    desk.canned.keys = (args) => {
      if (first) { first = false; desk.fg = 22; return { ok: false, changed: true, sent: 1 }; }
      return { ok: true, sent: args.chords.length };
    };
    const r = await svc.call('key', { text: 'alt+Tab Return' });
    expect(r.isError, text(r)).toBeFalsy();
    const calls = desk.ops.filter((o) => o.op === 'keys');
    expect(calls.map((c) => c.args.chords.length)).toEqual([2, 1]);
    expect(calls[1].args.expect.fg).toBe(22);
  });

  it('…and stops there when that window is not granted', async () => {
    await ready('Notepad');
    svc.grants.flags.systemKeyCombos = true;
    desk.canned.keys = () => { desk.fg = 22; return { ok: false, changed: true, sent: 1 }; };
    const r = await svc.call('key', { text: 'alt+Tab Return Return' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"Google Chrome" (process chrome) is in front');
    expect(text(r)).toContain('1 of 3 key presses');
    expect(desk.count('keys')).toBe(1);
  });

  it('hold_key holds one combination; a key that is not a modifier repeats', async () => {
    await ready('Notepad');
    expect((await svc.call('hold_key', { text: 'shift+Down', duration: 1.5 })).isError).toBeFalsy();
    expect(desk.last('hold')).toMatchObject({ chord: [{ vk: 0x10 }, { vk: 0x28, ext: true }], ms: 1500, rep: { vk: 0x28, ext: true } });
    await svc.call('hold_key', { text: 'shift', duration: 0.2 });
    expect(desk.last('hold')!.rep).toBeUndefined();
    for (const a of [{ text: 'a b', duration: 1 }, { text: 'a', duration: -1 }, { text: 'a', duration: 101 }, { text: 'a' }, { text: 'cmd', duration: 1 }]) {
      expect((await svc.call('hold_key', a as any)).isError, JSON.stringify(a)).toBe(true);
    }
    desk.canned.hold = { ok: true, heldMs: 400, cut: true };
    const cut = await svc.call('hold_key', { text: 'space', duration: 5 });
    expect(cut.isError).toBe(true);
    expect(text(cut)).toContain('released early');
  });

  it('are refused when the app in front is not granted', async () => {
    await ready('Notepad');
    desk.fg = 22;
    for (const [t, a] of [['type', { text: 'hello' }], ['key', { text: 'ctrl+v' }], ['hold_key', { text: 'space', duration: 0.1 }]] as const) {
      const r = await svc.call(t, a as any);
      expect(r.isError, t).toBe(true);
      expect(text(r)).toContain('is in front and is not a granted application');
    }
    expect(desk.sent()).toEqual([]);
  });
});

describe('scroll, drag and the held button', () => {
  it('scroll: up and right are positive wheel turns', async () => {
    await ready('Notepad');
    const [x, y] = real(300, 300);
    for (const [dir, dx, dy] of [['up', 0, 4], ['down', 0, -4], ['left', -4, 0], ['right', 4, 0]] as const) {
      expect((await svc.call('scroll', { coordinate: [300, 300], scroll_direction: dir, scroll_amount: 4 })).isError, dir).toBeFalsy();
      expect(desk.last('scroll')).toMatchObject({ x, y, dx, dy, mods: [] });
    }
    await svc.call('scroll', { coordinate: [300, 300], scroll_direction: 'up', scroll_amount: 2, text: 'ctrl' });
    expect(desk.last('scroll')!.mods).toEqual([{ vk: 0x11 }]);
    for (const a of [{ scroll_direction: 'sideways', scroll_amount: 1 }, { scroll_direction: 'up', scroll_amount: -1 }, { scroll_direction: 'up', scroll_amount: 101 }, { scroll_direction: 'up', scroll_amount: 1.5 }, { scroll_direction: 'up' }]) {
      expect((await svc.call('scroll', { coordinate: [300, 300], ...a } as any)).isError, JSON.stringify(a)).toBe(true);
    }
    // over a window that is not granted
    const r = await svc.call('scroll', { coordinate: [1200, 100], scroll_direction: 'down', scroll_amount: 3 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('is over "Google Chrome"');
  });

  it('drag: both ends must be on granted windows', async () => {
    await ready('Notepad');
    const ok = await svc.call('left_click_drag', { start_coordinate: [100, 100], coordinate: [400, 400] });
    expect(ok.isError, text(ok)).toBeFalsy();
    const [fx, fy] = real(100, 100);
    const [x, y] = real(400, 400);
    expect(desk.last('drag')).toEqual({ fx, fy, x, y, expect: { fg: 11, under: [{ hwnd: 11, pid: 1011 }, { hwnd: 11, pid: 1011 }] } });
    const out = await svc.call('left_click_drag', { start_coordinate: [100, 100], coordinate: [1200, 100] });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('(1200, 100) is over "Google Chrome"');
    const from = await svc.call('left_click_drag', { start_coordinate: [1200, 100], coordinate: [100, 100] });
    expect(from.isError).toBe(true);
    expect(desk.count('drag')).toBe(1);
  });

  it('drag without a start begins where the pointer is — and that place is checked too', async () => {
    await ready('Notepad');
    desk.cursor = { x: 200, y: 200 };
    expect((await svc.call('left_click_drag', { coordinate: [400, 400] })).isError).toBeFalsy();
    expect(desk.ops.find((o) => o.op === 'probe')!.args.points[0]).toBeNull();
    expect(desk.last('drag')!.fx).toBeUndefined();
    desk.cursor = { x: 1500, y: 100 }; // on Chrome
    const r = await svc.call('left_click_drag', { coordinate: [400, 400] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("the pointer's position is over");
  });

  it('left_mouse_down / up: held once, moving while held is a drag and is gated like one', async () => {
    await ready('Notepad');
    desk.cursor = { x: 200, y: 200 };
    expect((await svc.call('left_mouse_down')).isError).toBeFalsy();
    expect(desk.held).toBe(true);
    const twice = await svc.call('left_mouse_down');
    expect(twice.isError).toBe(true);
    expect(text(twice)).toContain('already held');
    // over Notepad: fine
    const move = await svc.call('mouse_move', { coordinate: [300, 300] });
    expect(move.isError, text(move)).toBeFalsy();
    expect(desk.last('move')!.expect).toBeTruthy();
    // dragging onto a window that is not granted: refused, the pointer stays
    const before = { ...desk.cursor };
    const off = await svc.call('mouse_move', { coordinate: [1200, 100] });
    expect(off.isError).toBe(true);
    expect(desk.cursor).toEqual(before);
    expect((await svc.call('left_mouse_up')).isError).toBeFalsy();
    expect(desk.held).toBe(false);
    // not held: a plain move needs no app in front
    desk.fg = 22;
    const free = await svc.call('mouse_move', { coordinate: [1200, 100] });
    expect(free.isError, text(free)).toBeFalsy();
    expect(desk.last('move')!.expect).toBeUndefined();
  });

  it('a held button is never left held: released even when the gate says no, and the result says so', async () => {
    await ready('Notepad');
    desk.cursor = { x: 200, y: 200 };
    await svc.call('left_mouse_down');
    desk.fg = 22; // the user switched windows meanwhile
    const r = await svc.call('left_mouse_up');
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('released all the same');
    expect(desk.held).toBe(false);
    expect(desk.last('up')).toEqual({ force: true });
    // nothing held any more: a further up is an ordinary refusal that sends nothing
    const n = desk.count('up');
    expect((await svc.call('left_mouse_up')).isError).toBe(true);
    expect(desk.count('up')).toBe(n);
  });
});

describe('what the access request did not say is not done', () => {
  // the card the user answers lists the clipboard and system-wide key combinations only when the request asked for
  // them: a yes to a card without them is not a yes to them
  it('the clipboard: neither read nor written until a request that said so was approved', async () => {
    await ready('Notepad');
    const read = await svc.call('read_clipboard');
    expect(read.isError).toBe(true);
    expect(text(read)).toContain('clipboardRead: true');
    expect(text(read)).not.toContain('copied earlier');
    const write = await svc.call('write_clipboard', { text: 'new' });
    expect(write.isError).toBe(true);
    expect(text(write)).toContain('clipboardWrite: true');
    expect(desk.ops).toEqual([]); // nothing was asked of the desktop: not the clipboard, not what is in front
    expect(desk.clipboard).toBe('copied earlier');
    // one does not bring the other
    const r = await svc.call('request_access', { apps: ['Notepad'], reason: 'copy the title', clipboardRead: true });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(await svc.call('read_clipboard'))).toContain('copied earlier');
    expect((await svc.call('write_clipboard', { text: 'new' })).isError).toBe(true);
    expect(desk.clipboard).toBe('copied earlier');
  });

  it('system-wide key combinations: refused until a request that said so was approved — the Windows key, alt+Tab, alt+Escape, ctrl+Escape', async () => {
    await ready('Notepad');
    for (const combo of ['win', 'win+r', 'super+d', 'alt+Tab', 'alt+shift+Tab', 'alt+Escape', 'ctrl+Escape', 'ctrl+shift+Escape', 'ctrl+s alt+Tab']) {
      const r = await svc.call('key', { text: combo });
      expect(r.isError, combo).toBe(true);
      expect(text(r), combo).toContain('systemKeyCombos: true');
    }
    expect((await svc.call('hold_key', { text: 'win', duration: 0.1 })).isError).toBe(true);
    expect(text(await svc.call('left_click', { coordinate: [100, 100], text: 'win' }))).toContain('systemKeyCombos: true');
    expect(text(await svc.call('scroll', { coordinate: [100, 100], scroll_direction: 'down', scroll_amount: 1, text: 'win+shift' }))).toContain('systemKeyCombos: true');
    const batch = await svc.call('computer_batch', { actions: [{ action: 'key', text: 'ctrl+a' }, { action: 'key', text: 'alt+Tab' }, { action: 'type', text: 'x' }] });
    expect(batch.isError).toBe(true);
    expect(text(batch)).toContain('2. key: FAILED');
    expect(desk.count('type')).toBe(0);
    expect(desk.sent()).toEqual(['keys']); // the ctrl+a of the batch, and nothing else
    // what an application does with its own shortcuts is its own: these were never system-wide
    desk.ops = [];
    for (const combo of ['ctrl+s', 'alt+F4', 'ctrl+shift+s', 'Escape', 'Tab', 'shift+Tab', 'ctrl+Tab', 'alt+f']) expect((await svc.call('key', { text: combo })).isError, combo).toBeFalsy();
    // …and once the user was told
    const r = await svc.call('request_access', { apps: ['Notepad'], reason: 'switch windows', systemKeyCombos: true });
    expect(r.isError, text(r)).toBeFalsy();
    expect((await svc.call('key', { text: 'alt+Tab' })).isError).toBeFalsy();
    expect((await svc.call('key', { text: 'win+r' })).isError).toBeFalsy();
  });

  it('a request the user refused turns nothing on', async () => {
    const s = new ComputerService({ helper: desk, selfExe: SELF_EXE, shotsDir: path.join(tmp, 'shots'), sleep: async () => {}, approve: async () => ({ granted: false, message: 'no' }) });
    s.grants.add('Notepad'); // (granted earlier)
    expect((await s.call('request_access', { apps: ['Notepad'], reason: 'r', clipboardRead: true, clipboardWrite: true, systemKeyCombos: true })).isError).toBe(true);
    expect((await s.call('read_clipboard')).isError).toBe(true);
    expect((await s.call('key', { text: 'win' })).isError).toBe(true);
  });
});

describe('the clipboard', () => {
  it('once approved: reading needs nothing in front; writing needs a granted app in front', async () => {
    await ready('Notepad');
    svc.grants.flags.clipboardRead = true;
    svc.grants.flags.clipboardWrite = true;
    desk.fg = 22;
    const read = await svc.call('read_clipboard');
    expect(read.isError).toBeFalsy();
    expect(text(read)).toContain('copied earlier');
    expect(text(read)).toContain('untrusted');
    const write = await svc.call('write_clipboard', { text: 'new' });
    expect(write.isError).toBe(true);
    expect(desk.clipboard).toBe('copied earlier');
    desk.fg = 11;
    expect((await svc.call('write_clipboard', { text: '新的' })).isError).toBeFalsy();
    expect(desk.clipboard).toBe('新的');
    desk.clipboard = null;
    expect(text(await svc.call('read_clipboard'))).toBe('The clipboard holds no text.');
    expect((await svc.call('write_clipboard', {} as any)).isError).toBe(true);
  });
});

describe('open_application', () => {
  it('brings a granted, running application forward — by any of its names', async () => {
    await grant('Notepad', 'Chrome');
    desk.fg = 22;
    const r = await svc.call('open_application', { app: '记事本' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(desk.last('activate')).toEqual({ hwnd: 11 });
    expect(text(r)).toContain('"Notepad" is in front');
    expect(desk.count('launch')).toBe(0);
  });

  it('refuses an application that was not granted, and Claude Web always', async () => {
    await grant('Notepad');
    const no = await svc.call('open_application', { app: 'Chrome' });
    expect(no.isError).toBe(true);
    expect(text(no)).toContain('"Chrome" is not a granted application');
    const me = await svc.call('open_application', { app: 'Claude Web' });
    expect(me.isError).toBe(true);
    expect((await svc.call('open_application', {} as any)).isError).toBe(true);
    expect(desk.count('activate')).toBe(0);
    expect(desk.count('launch')).toBe(0);
  });

  it('starts a known application that is not running, with our command — then brings its window forward', async () => {
    await grant('计算器');
    desk.onLaunch = () => { desk.wins.unshift(win(77, 'CalculatorApp', 'Calculator', 'Calculator', [100, 100, 400, 600])); };
    const r = await svc.call('open_application', { app: '计算器' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(desk.last('launch')).toEqual({ file: 'calc.exe' });
    expect(desk.last('activate')).toEqual({ hwnd: 77 });
    expect(text(r)).toContain('Started Calculator.');
  });

  it('starts anything else only through its Start-menu entry: the name the model gave is never a command', async () => {
    const evil = 'C:\\Windows\\System32\\cmd.exe /c calc';
    await grant('Obsidian', evil, 'https://example.com/x.exe');
    desk.startApps = [{ name: 'Obsidian', appId: 'md.obsidian' }, { name: 'Command Prompt', appId: 'cmd' }];
    desk.onLaunch = () => { desk.wins.unshift(win(88, 'Obsidian', 'Obsidian', 'Vault - Obsidian', [0, 0, 800, 600])); };
    const r = await svc.call('open_application', { app: 'Obsidian' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(desk.last('launch')).toEqual({ appId: 'md.obsidian' });
    const n = desk.count('launch');
    for (const app of [evil, 'https://example.com/x.exe']) {
      const bad = await svc.call('open_application', { app });
      expect(bad.isError, app).toBe(true);
      expect(text(bad)).toContain('no installed application of that name');
    }
    expect(desk.count('launch')).toBe(n);
    for (const o of desk.ops.filter((x) => x.op === 'launch')) expect(JSON.stringify(o.args)).not.toContain('cmd.exe');
  });

  it('says so when the window never appears, or does not come forward', async () => {
    await grant('Edge', 'Notepad');
    const none = await svc.call('open_application', { app: 'Edge' });
    expect(none.isError).toBe(true);
    expect(text(none)).toContain('no window of "Edge" has appeared yet');
    expect(slept.length).toBe(32); // waited about eight seconds for it
    desk.fg = 22;
    desk.canned.activate = { ok: true, front: false, fg: { hwnd: 22, pid: 1022, name: 'chrome', exe: '', description: 'Google Chrome', product: '', title: 't' } };
    const stuck = await svc.call('open_application', { app: 'Notepad' });
    expect(stuck.isError).toBe(true);
    expect(text(stuck)).toContain('is still in front');
  });

  it('skips a window of the granted program that is showing Claude Web', async () => {
    const web = new ComputerService({ helper: desk, sleep: async () => {} });
    desk.wins = [win(66, 'chrome', 'Google Chrome', 'Claude Web - Google Chrome', [0, 0, 900, 900]), win(67, 'chrome', 'Google Chrome', 'Docs - Google Chrome', [900, 0, 900, 900])];
    desk.fg = 66;
    await web.call('request_access', { apps: ['Chrome'], reason: 'r' });
    expect((await web.call('open_application', { app: 'Chrome' })).isError).toBeFalsy();
    expect(desk.last('activate')).toEqual({ hwnd: 67 });
  });
});

describe('computer_batch', () => {
  it('runs the actions in order through the same gate and adds a screenshot at the end', async () => {
    await ready('Notepad');
    const r = await svc.call('computer_batch', { actions: [
      { action: 'left_click', coordinate: [100, 200] },
      { action: 'type', text: '批处理' },
      { action: 'key', text: 'Return' },
      { action: 'wait', duration: 0.25 },
    ] });
    expect(r.isError, text(r)).toBeFalsy();
    expect(desk.ops.filter((o) => o.op !== 'probe').map((o) => o.op)).toEqual(['click', 'type', 'keys', 'screenshot']);
    expect(slept).toEqual([250]);
    const t = text(r);
    expect(t).toContain('1. left_click: Clicked at (100, 200).');
    expect(t).toContain('2. type: Typed 3 characters.');
    expect(t).toContain('3. key: Pressed Return.');
    expect(t).toContain('4. wait: Waited 0.25 s.');
    expect(t).toContain('Afterwards: Screenshot of the primary display');
    expect(images(r)).toHaveLength(1);
    expect(r.content[r.content.length - 1].type).toBe('image');
  });

  it('stops at the first failure, reports each step, and still shows the screen', async () => {
    await ready('Notepad');
    const r = await svc.call('computer_batch', { actions: [
      { action: 'left_click', coordinate: [100, 200] },
      { action: 'left_click', coordinate: [1200, 100] }, // over Chrome: not granted
      { action: 'type', text: 'never' },
      { action: 'key', text: 'Return' },
    ] });
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toContain('1. left_click: Clicked at (100, 200).');
    expect(t).toContain('2. left_click: FAILED — (1200, 100) is over "Google Chrome"');
    expect(t).toContain('the 2 actions after it were not run');
    expect(t).not.toContain('3. type');
    expect(desk.sent()).toEqual(['click']);
    expect(images(r)).toHaveLength(1);
  });

  it('a screenshot as the last action is the one screenshot; one in the middle is kept in place', async () => {
    await ready('Notepad');
    const last = await svc.call('computer_batch', { actions: [{ action: 'key', text: 'Escape' }, { action: 'screenshot' }] });
    expect(images(last)).toHaveLength(1);
    expect(desk.count('screenshot')).toBe(1);
    const mid = await svc.call('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'key', text: 'Escape' }] });
    expect(images(mid)).toHaveLength(2);
    expect(mid.content.map((c) => c.type)).toEqual(['text', 'image', 'text', 'image']);
  });

  it('checks every action before running any, and has a default for the wheel', async () => {
    await ready('Notepad');
    for (const actions of [[], 'x', [{ action: 'left_click', coordinate: [1, 1] }, { action: 'request_access', apps: ['Chrome'], reason: 'sneaky' }], [{ action: 'computer_batch', actions: [] }], [{ action: 'open_application', app: 'Notepad' }], [{}], [null], Array(51).fill({ action: 'wait', duration: 0 })]) {
      const r = await svc.call('computer_batch', { actions } as any);
      expect(r.isError, JSON.stringify(actions).slice(0, 80)).toBe(true);
    }
    expect(desk.ops).toEqual([]);
    expect(svc.grants.names()).toEqual(['Notepad']);
    await svc.call('computer_batch', { actions: [{ action: 'scroll', coordinate: [100, 100], scroll_direction: 'down' }] });
    expect(desk.last('scroll')).toMatchObject({ dy: -3 });
  });

  it('before any grant it runs nothing and shows nothing', async () => {
    const r = await svc.call('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'type', text: 'x' }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(NO_GRANT_TEXT);
    expect(images(r)).toHaveLength(0);
    expect(desk.ops).toEqual([]);
  });

  it('the gate applies to each action: a batch cannot type into the window its own key press switched to', async () => {
    await ready('Notepad');
    svc.grants.flags.systemKeyCombos = true;
    let pressed = false;
    desk.canned.keys = (args) => { pressed = true; desk.fg = 22; return { ok: true, sent: args.chords.length }; }; // alt+Tab → Chrome
    const r = await svc.call('computer_batch', { actions: [{ action: 'key', text: 'alt+Tab' }, { action: 'type', text: 'into chrome' }] });
    expect(pressed).toBe(true);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('2. type: FAILED — "Google Chrome" (process chrome) is in front');
    expect(desk.count('type')).toBe(0);
  });
});

describe('every tool that sends input', () => {
  it('is in the refusal tests above: with an ungranted app in front, none of them reaches the helper', async () => {
    await ready('Notepad');
    svc.grants.flags.clipboardWrite = true; // (so that it is the gate that refuses write_clipboard, like the rest)
    desk.fg = 22;
    desk.cursor = { x: 1200, y: 100 };
    const args: Record<string, Record<string, unknown>> = {
      left_click: { coordinate: [100, 100] }, right_click: { coordinate: [100, 100] }, middle_click: { coordinate: [100, 100] },
      double_click: { coordinate: [100, 100] }, triple_click: { coordinate: [100, 100] }, left_click_drag: { coordinate: [100, 100], start_coordinate: [50, 50] },
      left_mouse_down: {}, left_mouse_up: {}, scroll: { coordinate: [100, 100], scroll_direction: 'down', scroll_amount: 1 },
      type: { text: 'x' }, key: { text: 'Return' }, hold_key: { text: 'a', duration: 0.1 }, write_clipboard: { text: 'x' },
    };
    expect(Object.keys(args).sort()).toEqual([...INPUT_TOOLS].sort());
    for (const t of INPUT_TOOLS) {
      const r = await svc.call(t, args[t]);
      expect(r.isError, t).toBe(true);
      expect(text(r), t).toContain('not a granted application');
    }
    expect(desk.sent()).toEqual([]);
  });
});

describe('one call at a time', () => {
  it('two calls made together do not interleave their look and their act', async () => {
    await ready('Notepad');
    const [a, b] = await Promise.all([svc.call('left_click', { coordinate: [100, 100] }), svc.call('type', { text: 'x' })]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(desk.ops.map((o) => o.op)).toEqual(['probe', 'click', 'probe', 'type']);
  });

  it('a helper that dies mid-call is an error result, and the next call still runs', async () => {
    await ready('Notepad');
    desk.canned.probe = new HelperError('辅助进程退出了（1）');
    const r = await svc.call('left_click', { coordinate: [100, 100] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('操控电脑的辅助进程出了问题：辅助进程退出了（1）');
    delete desk.canned.probe;
    expect((await svc.call('left_click', { coordinate: [100, 100] })).isError).toBeFalsy();
  });

  it('close closes the helper', () => {
    svc.close();
    expect(desk.closed).toBe(true);
  });
});
