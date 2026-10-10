import { describe, expect, it } from 'vitest';
import type { WindowApp } from './apps.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grants, INPUT_TOOLS, NO_GRANT_TEXT, SELF_TITLE, TOOL_NEEDS, gate, isSelf, namesSelf, type Seen } from './grants.js';
import { TOOL_NAMES } from './tools.js';

let nextHwnd = 100;
const win = (name: string, description = name, title = `${description} window`, exe = `C:\\Apps\\${name}.exe`): WindowApp => ({ hwnd: nextHwnd++, pid: nextHwnd, name, exe, description, product: description, title });

const notepad = win('notepad', 'Notepad', 'Untitled - Notepad');
const chrome = win('chrome', 'Google Chrome', 'Example Domain - Google Chrome');
const explorer = win('explorer', 'Windows Explorer', 'Program Manager');
const SELF_EXE = 'C:\\Program Files\\Claude Web\\Claude Web.exe';
const desktopApp = win('Claude Web', 'Claude Web', 'Claude Web', SELF_EXE);
const webTab = win('chrome', 'Google Chrome', 'Claude Web - Google Chrome');
const self = { exe: SELF_EXE };

function granted(...names: string[]): Grants {
  const g = new Grants();
  for (const n of names) expect(g.add(n)).toBe(true);
  return g;
}

describe('the granted set', () => {
  it('keeps one grant per spelling, and never Claude Web itself', () => {
    const g = new Grants();
    expect(g.any()).toBe(false);
    expect(g.add('Notepad')).toBe(true);
    expect(g.add('notepad.exe')).toBe(true); // the same name again
    expect(g.add(' Google Chrome ')).toBe(true);
    expect(g.names()).toEqual(['Notepad', 'Google Chrome']);
    for (const s of ['Claude Web', 'claude-web', 'Claude Web.exe', 'CLAUDE_WEB', 'the claude web app', '', '   ', '--']) expect(g.add(s), s).toBe(false);
    expect(g.names()).toEqual(['Notepad', 'Google Chrome']);
    expect(g.any()).toBe(true);
  });

  it('finds the grant that covers a window, and the grant a name refers to', () => {
    const g = granted('记事本', 'Chrome');
    expect(g.covering(notepad)?.name).toBe('记事本');
    expect(g.covering(chrome)?.name).toBe('Chrome');
    expect(g.covering(explorer)).toBeUndefined();
    expect(g.covering(null)).toBeUndefined();
    // open_application by another name of the same app
    expect(g.named('Notepad')?.name).toBe('记事本');
    expect(g.named('notepad.exe')?.name).toBe('记事本');
    expect(g.named('Google Chrome')?.name).toBe('Chrome');
    expect(g.named('Edge')).toBeUndefined();
    expect(g.named('')).toBeUndefined();
  });

  it('a name that is not Claude Web is not taken for it', () => {
    expect(namesSelf('Claude')).toBe(false); // the Claude desktop app is another program
    expect(namesSelf('Web')).toBe(false);
    expect(namesSelf('Claude Web')).toBe(true);
    expect(namesSelf('claude-web')).toBe(true);
  });
});

describe('recognising Claude Web', () => {
  it('by its executable, whatever the title, and by its title, whatever the program', () => {
    expect(isSelf(desktopApp, self)).toBe(true);
    expect(isSelf({ ...desktopApp, title: 'something else' }, self)).toBe(true);
    expect(isSelf({ ...desktopApp, exe: 'c:/program files/claude web/CLAUDE WEB.EXE', title: '' }, self)).toBe(true);
    expect(isSelf(webTab, {})).toBe(true); // the web version: a browser tab
    expect(isSelf({ ...chrome, title: 'claude web' }, {})).toBe(true);
    expect(isSelf(chrome, self)).toBe(false);
    expect(isSelf(notepad, {})).toBe(false);
    expect(isSelf(null, self)).toBe(false);
  });

  // the web version is a tab of the user's browser: the only thing that tells its window from any other browser
  // window is the page's title. Were the page to change its title, an agent granted the browser could press its own
  // approval button — so the title is held to here, and nothing in the page may set another
  it('the page of the web app is titled the way the gate recognises it, and no code retitles it', () => {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web');
    const title = /<title>([^<]*)<\/title>/.exec(fs.readFileSync(path.join(web, 'index.html'), 'utf8'))?.[1] ?? '';
    expect(title).toContain(SELF_TITLE);
    const retitled: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'shell' && e.name !== '__fixtures__') walk(f); continue; }
        if (!/\.(ts|tsx|js)$/.test(e.name) || /\.test\./.test(e.name)) continue;
        if (/document\.title\s*=[^=]/.test(fs.readFileSync(f, 'utf8'))) retitled.push(path.relative(web, f));
      }
    };
    walk(path.join(web, 'src'));
    expect(retitled).toEqual([]);
  });
});

describe('the gate', () => {
  const at = (app: WindowApp | null, where = '(10, 20)') => ({ at: where, app });

  it('tools that manage access or wait need nothing', () => {
    const none = new Grants();
    for (const t of ['request_access', 'list_granted_applications', 'wait']) expect(gate(TOOL_NEEDS[t], none, null, self)).toEqual({ ok: true });
  });

  it('before the first grant everything else is refused: nothing is captured, nothing is sent', () => {
    const none = new Grants();
    for (const t of TOOL_NAMES) {
      if (TOOL_NEEDS[t] === 'none') continue;
      const v = gate(TOOL_NEEDS[t], none, { fg: notepad, under: [at(notepad)] }, self);
      expect(v.ok, t).toBe(false);
      if (!v.ok) { expect(v.reason).toBe('no-grant'); expect(v.text).toBe(NO_GRANT_TEXT); expect(v.text).toContain('request_access'); }
    }
  });

  it('looking needs only some grant, whatever is in front', () => {
    const g = granted('Notepad');
    for (const t of ['screenshot', 'zoom', 'cursor_position', 'mouse_move', 'read_clipboard', 'open_application']) {
      expect(gate(TOOL_NEEDS[t], g, { fg: chrome }, self), t).toEqual({ ok: true });
      expect(gate(TOOL_NEEDS[t], g, null, self), t).toEqual({ ok: true });
    }
  });

  it('input goes through when the app in front is granted', () => {
    const g = granted('Notepad');
    expect(gate('input', g, { fg: notepad }, self)).toEqual({ ok: true });
    expect(gate('input', g, { fg: notepad, under: [at(notepad)] }, self)).toEqual({ ok: true });
  });

  it('input is refused when the app in front is not granted, and the refusal names it', () => {
    const g = granted('Notepad');
    const v = gate('input', g, { fg: chrome }, self);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('not-granted');
      expect(v.text).toContain('"Google Chrome" (process chrome)');
      expect(v.text).toContain('request_access');
      expect(v.text).toContain('open_application');
      expect(v.text).toContain('nothing was sent');
      expect(v.text).toContain('Granted: Notepad.');
      // the title is a web page's to choose: it is not repeated to the model
      expect(v.text).not.toContain('Example Domain');
    }
  });

  it('input is refused when no window is in front', () => {
    const v = gate('input', granted('Notepad'), { fg: null }, self);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('no-foreground');
    const w = gate('input', granted('Notepad'), null, self);
    expect(w.ok).toBe(false);
  });

  it('a click lands on what is under the pointer: that window must be granted too', () => {
    const g = granted('Notepad');
    const seen: Seen = { fg: notepad, under: [at(chrome, '(300, 400)')] };
    const v = gate('input', g, seen, self);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('not-granted');
      expect(v.text).toContain('(300, 400) is over "Google Chrome" (process chrome)');
    }
    // every point of a drag
    expect(gate('input', g, { fg: notepad, under: [at(notepad), at(explorer)] }, self).ok).toBe(false);
    expect(gate('input', granted('Notepad', 'File Explorer'), { fg: notepad, under: [at(notepad), at(explorer)] }, self).ok).toBe(true);
    // nothing there at all
    const nothing = gate('input', g, { fg: notepad, under: [at(null)] }, self);
    expect(nothing.ok).toBe(false);
  });

  it('never Claude Web itself: in front, or under the pointer, whatever was granted', () => {
    // a grant that happens to cover the program it runs in
    const g = granted('Notepad', 'Chrome', 'Claude');
    const front = gate('input', g, { fg: desktopApp }, self);
    expect(front.ok).toBe(false);
    if (!front.ok) { expect(front.reason).toBe('self'); expect(front.text).toContain('Nothing was sent'); }
    // the web version, in a granted browser
    const tab = gate('input', g, { fg: webTab }, {});
    expect(tab.ok).toBe(false);
    if (!tab.ok) expect(tab.reason).toBe('self');
    // a granted app in front, the pointer on Claude Web's approval button
    const under = gate('input', g, { fg: notepad, under: [at(desktopApp, '(900, 700)')] }, self);
    expect(under.ok).toBe(false);
    if (!under.ok) { expect(under.reason).toBe('self'); expect(under.text).toContain('(900, 700)'); }
    const underTab = gate('input', g, { fg: notepad, under: [at(webTab)] }, {});
    expect(underTab.ok).toBe(false);
    // the same browser on another page is fine
    expect(gate('input', g, { fg: chrome, under: [at(chrome)] }, {}).ok).toBe(true);
  });
});

describe('the table of needs', () => {
  it('covers every tool the server lists, and nothing else', () => {
    expect(Object.keys(TOOL_NEEDS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('everything that sends input needs the app in front', () => {
    expect([...INPUT_TOOLS].sort()).toEqual([
      'double_click', 'hold_key', 'key', 'left_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'middle_click',
      'right_click', 'scroll', 'triple_click', 'type', 'write_clipboard',
    ]);
  });
});
