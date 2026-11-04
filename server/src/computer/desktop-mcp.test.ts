import { describe, expect, it } from 'vitest';
import { DESKTOP_TOOLS, DesktopService, compactTree, envelopeText, type Envelope } from './desktop-mcp.js';

const tree = { role: 'window', name: 'Note', children: [{ role: 'group', children: [{ ref_id: '@s1:e1', role: 'button', name: 'Save', states: ['enabled'] }, { ref_id: '@s1:e2', role: 'textfield', name: 'Body', value: 'hi' }] }] };

describe('desktop output', () => {
  it('one line per element with a ref or a name, nested by depth', () => {
    expect(compactTree(tree)).toEqual(['window "Note"', '  @s1:e1 button "Save" {enabled}', '  @s1:e2 textfield "Body" = "hi"']);
    expect(envelopeText({ ok: true, data: { app: 'notepad.exe', snapshot_id: 's1', ref_count: 2, tree } }).split('\n')[0]).toBe('app notepad.exe · snapshot s1 · 2 refs');
    expect(envelopeText({ ok: false, error: { code: 'STALE_REF', message: 'gone', suggestion: 'snapshot again', disposition: { retry: 'safe' } } })).toBe('STALE_REF: gone\nHint: snapshot again\nRetry: safe');
  });
});

describe('desktop tool list', () => {
  it('the picture and the core loop are not deferred on our engine; the rest is', () => {
    const loaded = DESKTOP_TOOLS.filter((t) => t._meta?.['anthropic/alwaysLoad']).map((t) => t.name).sort();
    expect(loaded).toEqual(['act', 'request_access', 'screenshot', 'snapshot']);
  });
});

describe('DesktopService gate', () => {
  const make = (answer = true) => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<Envelope> => {
      calls.push(args);
      if (args[0] === 'snapshot') return { ok: true, data: { app: 'notepad.exe', snapshot_id: 's1', tree } };
      return { ok: true, data: { done: true } };
    };
    const svc = new DesktopService(run, async () => (answer ? { granted: true } : { granted: false, message: 'The user declined.' }));
    return { svc, calls };
  };

  it('touches nothing before the user grants the app', async () => {
    const { svc, calls } = make();
    expect((await svc.call('snapshot', { app: 'notepad.exe' })).isError).toBe(true);
    expect((await svc.call('press', { app: 'notepad.exe', keys: 'ctrl+s' })).isError).toBe(true);
    expect((await svc.call('mouse', { action: 'click', x: 1, y: 2 })).isError).toBe(true);
    expect((await svc.call('clipboard', { action: 'get' })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('a declined request grants nothing', async () => {
    const { svc } = make(false);
    const r = await svc.call('request_access', { apps: ['notepad.exe'], reason: 'r' });
    expect(r).toEqual({ content: [{ type: 'text', text: 'The user declined.' }], isError: true });
    expect((await svc.call('snapshot', { app: 'notepad.exe' })).isError).toBe(true);
  });

  it('after a yes: snapshot, then act on its refs; a ref from elsewhere is refused', async () => {
    const { svc, calls } = make();
    await svc.call('request_access', { apps: ['Notepad'], reason: 'r' });
    const snap = await svc.call('snapshot', { app: 'notepad.exe' });
    expect(snap.isError).toBeUndefined();
    expect(calls[0]).toEqual(['snapshot', '--app', 'notepad.exe', '-i', '--compact']);
    // e2 already holds the user's text ("hi"): replacing it needs overwrite (2026-11-04: a test wiped an open Notepad tab)
    const refused = await svc.call('act', { action: 'set_value', ref: '@s1:e2', value: 'new' });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toMatch(/already has text/);
    expect((await svc.call('act', { action: 'clear', ref: '@s1:e2' })).isError).toBe(true);
    expect(calls).toHaveLength(1);
    await svc.call('act', { action: 'set_value', ref: '@s1:e2', value: 'new', overwrite: true });
    expect(calls[1]).toEqual(['set-value', '@s1:e2', 'new']);
    await svc.call('act', { action: 'double_click', ref: '@s1:e1' });
    expect(calls[2]).toEqual(['double-click', '@s1:e1', '--headed']);
    expect((await svc.call('act', { action: 'click', ref: '@zz:e1' })).isError).toBe(true);
    expect((await svc.call('act', { action: 'click', ref: 'e1' })).isError).toBe(true);
    await svc.call('mouse', { action: 'click', x: 10, y: -5 });
    expect(calls.at(-1)).toEqual(['mouse-click', '--xy=10,-5', '--button', 'left', '--count', '1', '--headed']);
    expect((await svc.call('clipboard', { action: 'get' })).isError).toBe(true);
  });

  it('launch of an app that is already running says it is the user\'s own window', async () => {
    const run = async (args: string[]): Promise<Envelope> => (args[0] === 'list-apps' ? { ok: true, data: { apps: [{ name: 'Notepad.exe' }] } } : { ok: true, data: { app: 'notepad.exe', pid: 1 } });
    const svc = new DesktopService(run, async () => ({ granted: true }));
    await svc.call('request_access', { apps: ['notepad'], reason: 'r' });
    expect(JSON.stringify(await svc.call('launch', { app: 'notepad' }))).toMatch(/already running .*Open a new document/);
    await svc.call('request_access', { apps: ['calc'], reason: 'r' });
    expect(JSON.stringify(await svc.call('launch', { app: 'calc' }))).not.toMatch(/already running/);
  });
});
