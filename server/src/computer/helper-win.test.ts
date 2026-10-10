import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELPER_SCRIPT, HELPER_SCRIPT_NAME, HelperError, WinHelper, helperScriptFile, powershellExe } from './helper-win.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-computer-helper-'));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('the helper script', () => {
  it('is pure ASCII with LF line ends: Windows PowerShell reads a BOM-less file in the ANSI code page', () => {
    for (let i = 0; i < HELPER_SCRIPT.length; i++) {
      const c = HELPER_SCRIPT.charCodeAt(i);
      if (c !== 10 && (c < 32 || c > 126)) throw new Error(`character ${c} at ${i}: ${JSON.stringify(HELPER_SCRIPT.slice(Math.max(0, i - 30), i + 10))}`);
    }
    expect(HELPER_SCRIPT.endsWith('\n')).toBe(true);
  });

  it('holds no backtick and no backslash, and one here-string that nothing inside can end early', () => {
    expect(HELPER_SCRIPT).not.toContain('`');
    expect(HELPER_SCRIPT).not.toContain('\\');
    const lines = HELPER_SCRIPT.split('\n');
    const open = lines.filter((l) => l.endsWith("@'"));
    const close = lines.filter((l) => l.startsWith("'@"));
    expect(open).toEqual(["$src = @'"]);
    expect(close).toEqual(["'@"]);
    // the C# between them has no single quote at all (no char literals): nothing to confuse the here-string
    const body = lines.slice(lines.indexOf("$src = @'") + 1, lines.indexOf("'@"));
    expect(body.length).toBeGreaterThan(200);
    expect(body.some((l) => l.includes("'"))).toBe(false);
  });

  it('makes the process DPI aware before anything else, and checks before every kind of input', () => {
    const init = HELPER_SCRIPT.indexOf('[CW.Native]::Init()');
    const loop = HELPER_SCRIPT.indexOf('while ($true)');
    expect(init).toBeGreaterThan(0);
    expect(init).toBeLessThan(loop);
    expect(HELPER_SCRIPT).toContain('SetProcessDpiAwarenessContext(new IntPtr(-4))');
    expect(HELPER_SCRIPT).toContain('SetProcessDPIAware()');
    // every method that calls SendInput for the caller goes through Check first
    for (const method of ['TypeText', 'PressChords', 'Hold', 'Click', 'Drag', 'Scroll']) {
      const at = HELPER_SCRIPT.indexOf(`static Dictionary<string, object> ${method}(`);
      expect(at, method).toBeGreaterThan(0);
      const body = HELPER_SCRIPT.slice(at, HELPER_SCRIPT.indexOf('\n    }\n', at));
      const check = body.indexOf('Check(q,');
      expect(check, method).toBeGreaterThan(0);
      for (const send of ['MouseEvent(', 'Press(', 'Tap(', 'Send(', 'SetCursorPos(', 'Settle(']) {
        const s = body.indexOf(send);
        if (s >= 0) expect(s, `${method}: ${send} before the check`).toBeGreaterThan(check);
      }
    }
    // text goes as Unicode characters (KEYEVENTF_UNICODE = 4): no keyboard layout, no input method in the way
    expect(HELPER_SCRIPT).toContain('i.u.ki.wScan = (ushort)c; i.u.ki.dwFlags = (uint)(4 |');
  });

  it('is written once, content-addressed, and rewritten when its bytes are not ours', () => {
    const dir = path.join(tmp, 'a', 'b');
    const file = helperScriptFile(dir)!;
    expect(file).toBe(path.join(dir, HELPER_SCRIPT_NAME));
    expect(HELPER_SCRIPT_NAME).toMatch(/^helper-[0-9a-f]{8}\.ps1$/);
    expect(fs.readFileSync(file, 'utf8')).toBe(HELPER_SCRIPT);
    const mtime = fs.statSync(file).mtimeMs;
    expect(helperScriptFile(dir)).toBe(file);
    expect(fs.statSync(file).mtimeMs).toBe(mtime); // reused as it is
    // tampered with (same length, other bytes): put right again
    fs.writeFileSync(file, HELPER_SCRIPT.replace('Check(q, pts)', 'Check(q, PTS)'));
    expect(helperScriptFile(dir)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(HELPER_SCRIPT);
    // truncated
    fs.writeFileSync(file, 'exit');
    helperScriptFile(dir);
    expect(fs.readFileSync(file, 'utf8')).toBe(HELPER_SCRIPT);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('removes the scripts of earlier versions, and nothing else', () => {
    const dir = path.join(tmp, 'old');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'helper-0123abcd.ps1'), 'old');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    fs.mkdirSync(path.join(dir, 'shots'));
    helperScriptFile(dir);
    expect(fs.readdirSync(dir).sort()).toEqual([HELPER_SCRIPT_NAME, 'notes.txt', 'shots'].sort());
  });

  it('answers null where it cannot be written', () => {
    const blocker = path.join(tmp, 'a-file');
    fs.writeFileSync(blocker, 'x');
    expect(helperScriptFile(path.join(blocker, 'under-a-file'))).toBeNull();
  });

  it('PowerShell is looked for under the Windows directory, not on PATH', () => {
    expect(powershellExe({ SystemRoot: path.join(tmp, 'no-windows-here') })).toBe('powershell.exe');
    if (process.platform === 'win32') expect(powershellExe().toLowerCase()).toContain('system32');
  });

  it('a closed helper starts nothing', async () => {
    const h = new WinHelper({ log: () => {} });
    h.close();
    await expect(h.call('cursor')).rejects.toBeInstanceOf(HelperError);
  });
});

// The real thing: only on a Windows machine with a desktop, and only when asked (CI has no promise of one).
// Read-only: it looks (pointer, windows, one screenshot) and sends no input.
const live = process.platform === 'win32' && process.env.CW_COMPUTER_LIVE === '1';
describe.skipIf(!live)('the helper on this machine (CW_COMPUTER_LIVE=1)', () => {
  it('starts, reports real pixels, looks at the desktop, and refuses input it was given no expectation for', async () => {
    const saved = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = path.join(tmp, 'data');
    const lines: string[] = [];
    const h = new WinHelper({ selfTitle: 'Claude Web', log: (l) => lines.push(l) });
    try {
      const hello = await h.start();
      expect(['per-monitor-v2', 'thread-per-monitor-v2']).toContain(hello.dpi);
      expect(hello.screen.width).toBeGreaterThan(600);
      expect(lines.join('\n')).toMatch(/helper ready in \d+ ms/);
      const cur = await h.call('cursor');
      expect(cur).toMatchObject({ ok: true, x: expect.any(Number), y: expect.any(Number) });
      const probe = await h.call('probe', { points: [null, [1, 1]] });
      expect(probe.ok).toBe(true);
      expect(probe.under).toHaveLength(2);
      const apps = await h.call('apps');
      expect(apps.ok).toBe(true);
      expect(Array.isArray(apps.apps)).toBe(true);
      const shot = await h.call('screenshot', { maxEdge: 1568, quality: 75 }, 30_000);
      expect(shot.ok).toBe(true);
      expect(Math.max(shot.w, shot.h)).toBeLessThanOrEqual(1568);
      expect(shot.rect).toEqual({ x: 0, y: 0, width: hello.screen.width, height: hello.screen.height });
      expect(String(shot.data).startsWith('/9j/')).toBe(true); // a JPEG
      // no expectation, or the wrong window: nothing is sent
      expect(await h.call('type', { text: 'x' })).toMatchObject({ ok: false, unchecked: true, sent: 0 });
      expect(await h.call('click', { x: 1, y: 1, button: 'left', count: 1, expect: { fg: 1, under: [{ hwnd: 1, pid: 1 }] } })).toMatchObject({ ok: false, changed: true, sent: 0 });
      expect(await h.call('keys', { chords: [[{ vk: 0x41 }]], expect: { fg: 1 } })).toMatchObject({ ok: false, changed: true, sent: 0 });
      expect((await h.call('cursor')).x).toBe(cur.x); // the refused click did not move the pointer
      expect(await h.call('no-such-op')).toMatchObject({ ok: false });
    } finally {
      h.close();
      if (saved === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = saved;
    }
  }, 90_000);
});
