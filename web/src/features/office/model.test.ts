import { describe, expect, it } from 'vitest';
import type { BgAgent, BgSession, BgTask } from '@shared';
import { EXIT, PCS, hallDepth, officeModel, roomsFor, rowsFor, seatBots, seatRooms, type OfficeBot } from './model';

const agent = (key: string, state: BgAgent['state'], o: Partial<BgAgent> = {}): BgAgent => ({ key, color: 1, label: key, state, beats: [], ...o });
const task = (id: string, status: BgTask['status'], agents: BgAgent[], o: Partial<BgTask> = {}): BgTask => ({ id, kind: 'workflow', description: id, status, startedAt: 1, agents, ...o });
const session = (sid: string, tasks: BgTask[], updatedAt = 1): BgSession => ({ sessionId: sid, updatedAt, tasks, events: [{ at: updatedAt, taskId: tasks[0]?.id ?? '', who: 'x', text: `e-${sid}`, tone: 'start' }] });

describe('officeModel', () => {
  const sessions = {
    a: session('a', [task('t1', 'running', [agent('w1', 'running', { tokens: 1000, model: 'claude-sonnet-4-5' }), agent('w2', 'failed', { error: 'boom\nstack' }), agent('w3', 'done')])], 5),
    b: session('b', [task('sh', 'running', [], { kind: 'shell', description: 'npm test' })], 9),
    c: session('c', [task('t2', 'completed', [agent('x', 'done')])], 20),
    d: { sessionId: 'd', updatedAt: 30, tasks: [], events: [] },
  };
  const m = officeModel({ sessions, titleOf: (s) => `T-${s}`, lead: (s) => (s === 'a' ? { state: 'waiting', pending: [{ requestId: 'r1', toolName: 'Bash' }] } : undefined) });

  it('a zone per conversation with background work, running ones first (A区 = first)', () => {
    expect(m.zones.map((f) => f.sessionId)).toEqual(['b', 'a', 'c']);
    expect(m.zones.map((f) => f.number)).toEqual([1, 2, 3]);
    expect(m.zones.map((f) => f.letter)).toEqual(['A', 'B', 'C']);
    expect(m.zones[1].name).toBe('T-a');
  });

  it('statuses: running → working, failed → stuck, done → finished; the lead waits on a permission request', () => {
    const a = m.zones[1];
    const by = (id: string) => a.bots.find((b) => b.id === id)!;
    expect(by('a|lead').status).toBe('waiting');
    expect(by('a|t1|w1').status).toBe('working');
    expect(by('a|t1|w2').status).toBe('stuck');
    expect(by('a|t1|w2').line).toBe('boom');
    expect(by('a|t1|w3').status).toBe('finished');
    expect(m.zones[0].bots.find((b) => b.shell)?.status).toBe('working');
    expect(a).toMatchObject({ working: 1, waiting: 1, stuck: 1, done: 1, total: 3 });
  });

  it('counts, waiting cards (asks before stuck, with the request to answer), finished, activity newest first', () => {
    expect(m.counts).toEqual({ working: 2, waiting: 1, stuck: 1, resting: 4 });
    expect(m.waiting.map((w) => [w.kind, w.requestId])).toEqual([['ask', 'r1'], ['stuck', undefined]]);
    expect(m.finished.length).toBe(2);
    expect(m.activity.map((e) => e.text)).toEqual(['e-c', 'e-b', 'e-a']);
    expect(m.usd).toBeGreaterThan(0);
  });

  it('caps the zones and says how many more', () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, session(`s${i}`, [task('t', 'running', [agent('a', 'running')])], i)]));
    const x = officeModel({ sessions: many, titleOf: () => '', lead: () => undefined });
    expect(x.zones.length).toBe(8);
    expect(x.more).toBe(3);
  });
});

describe('seatBots', () => {
  const bot = (id: string, status: OfficeBot['status'], o: Partial<OfficeBot> = {}): OfficeBot => ({ id, sessionId: 's', name: id, color: 1, shape: 0, status, line: '', ...o });
  it('a PC for every customer not finished, kept across snapshots; finished ones check out (EXIT); no lead, no commands', () => {
    const one = seatBots([bot('l', 'working', { lead: true }), bot('a', 'working'), bot('b', 'resting'), bot('c', 'stuck'), bot('sh', 'working', { shell: true })], new Map());
    expect([...one.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(one.get('a')).toBe(0);
    expect(one.get('c')).toBe(1);
    expect(one.get('b')).toBe(2);
    const two = seatBots([bot('x', 'working'), bot('a', 'finished'), bot('c', 'stuck'), bot('b', 'working')], one);
    expect(two.get('c')).toBe(1);
    expect(two.get('b')).toBe(2);
    expect(two.get('a')).toBe(EXIT);
    expect(two.get('x')).toBe(0);
  });
  it('a full row: the ones at work first', () => {
    const many = [bot('r', 'resting'), ...Array.from({ length: PCS }, (_, i) => bot(`w${i}`, 'working'))];
    const s = seatBots(many, new Map());
    expect(s.has('r')).toBe(false);
    expect(new Set(s.values()).size).toBe(PCS);
  });
});

describe('seatRooms and the hall', () => {
  const sh = (id: string, status: OfficeBot['status']): OfficeBot => ({ id, sessionId: 's', name: id, color: 0, shape: 2, status, line: '', shell: true });
  it('stable rooms, running ones first when full', () => {
    const a = seatRooms([sh('a', 'resting'), sh('b', 'working')], new Map(), 1);
    expect([...a]).toEqual([['b', 0]]);
    const b = seatRooms([sh('a', 'resting'), sh('b', 'working'), sh('c', 'working')], new Map([['a', 1], ['b', 0]]), 3);
    expect(b.get('a')).toBe(1);
    expect(b.get('b')).toBe(0);
    expect(b.get('c')).toBe(2);
  });
  it('rows, depth and rooms grow with the zones', () => {
    expect(rowsFor(0)).toBe(3);
    expect(rowsFor(12)).toBe(8);
    expect(hallDepth(8)).toBeGreaterThan(hallDepth(3));
    expect(roomsFor(1)).toBeGreaterThanOrEqual(2);
    expect(roomsFor(8)).toBeGreaterThan(roomsFor(1));
  });
});
