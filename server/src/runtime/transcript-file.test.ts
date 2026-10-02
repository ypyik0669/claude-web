import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lastCostState, repairLeaf } from './transcript-file.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const file = (lines: object[], pad = 0) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tf-'));
  dirs.push(d);
  const f = path.join(d, 's.jsonl');
  // `pad`: a big entry at the top, so the interesting lines straddle the 1 MiB read chunks
  const head = pad ? [JSON.stringify({ type: 'attachment', uuid: 'pad', parentUuid: null, content: 'x'.repeat(pad) })] : [];
  fs.writeFileSync(f, [...head, ...lines.map((l) => JSON.stringify(l))].join('\n') + '\n');
  return f;
};
const lines = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// the shape of a real transcript (2026-10-01): one turn on the official binary (2.1.283), two on ccb (2.8.4)
const ENGINE_SWITCH = [
  { type: 'user', uuid: 'u1', parentUuid: null, version: '2.1.283', message: { role: 'user', content: 'Reply with exactly: one1' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', version: '2.1.283' },
  { type: 'attachment', uuid: 'at1', parentUuid: 'a1', version: '2.1.283' },
  { type: 'last-prompt', lastPrompt: 'Reply with exactly: one1', leafUuid: 'at1', sessionId: 's' },
  { type: 'cost-state', sessionId: 's', totalCostUSD: 0.13310775, modelUsage: { 'claude-sonnet-4-6': { inputTokens: 3, outputTokens: 5, costUSD: 0.13310775 } } },
  { type: 'user', uuid: 'u2', parentUuid: 'a1', version: '2.8.4', message: { role: 'user', content: 'Reply with exactly: two2' } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'u2', version: '2.8.4' },
  { type: 'last-prompt', lastPrompt: 'Reply with exactly: two2', sessionId: 's' },
  { type: 'user', uuid: 'u3', parentUuid: 'a2', version: '2.8.4', message: { role: 'user', content: 'Reply with exactly: three3' } },
  { type: 'assistant', uuid: 'a3', parentUuid: 'u3', version: '2.8.4' },
  { type: 'last-prompt', lastPrompt: 'Reply with exactly: three3', sessionId: 's' },
  { type: 'queue-operation', operation: 'enqueue' },
];

describe('repairLeaf: the official binary resumes where the conversation really is after turns on ccb', () => {
  it('points a new last-prompt at the newest entry when the last leaf is older (the turns on ccb were dropped)', () => {
    const f = file(ENGINE_SWITCH);
    expect(repairLeaf(f, 's')).toBe(true);
    expect(lines(f).at(-1)).toEqual({ type: 'last-prompt', lastPrompt: 'Reply with exactly: three3', leafUuid: 'a3', sessionId: 's' });
    expect(repairLeaf(f, 's')).toBe(false); // idempotent
  });

  it('leaves alone: a leaf that is current, a conversation never pointed anywhere, a subagent entry after the leaf', () => {
    const current = file(ENGINE_SWITCH.slice(0, 5));
    expect(repairLeaf(current, 's')).toBe(false);
    const ccbOnly = file(ENGINE_SWITCH.slice(5));
    expect(repairLeaf(ccbOnly, 's')).toBe(false);
    const side = file([...ENGINE_SWITCH.slice(0, 5), { type: 'assistant', uuid: 'sub1', parentUuid: 'x', isSidechain: true }]);
    expect(repairLeaf(side, 's')).toBe(false);
    expect(repairLeaf(null, 's')).toBe(false);
    // a /rewind in the terminal: the official binary pointed at an older entry after writing the newer ones — it stands
    const rewound = file([...ENGINE_SWITCH.slice(0, 3), { type: 'user', uuid: 'u9', parentUuid: 'at1' }, { type: 'last-prompt', lastPrompt: 'x', leafUuid: 'a1', sessionId: 's' }]);
    expect(repairLeaf(rewound, 's')).toBe(false);
  });

  it('works when the lines straddle the read chunks of a big file', () => {
    const f = file(ENGINE_SWITCH, (1 << 20) - 300);
    expect(repairLeaf(f, 's')).toBe(true);
    expect(lines(f).at(-1).leafUuid).toBe('a3');
  });
});

describe('repairLeaf after closing an idle official process that a terminal took over (ignoreLeavesFrom)', () => {
  // the web's official process answered up to w2 and sat idle; `claude --resume` in a terminal added t1 → t2; closing
  // the web process made it write its own idea of the leaf (w2) on exit, after the terminal's turns
  const WEB = [
    { type: 'user', uuid: 'w1', parentUuid: null, message: { role: 'user', content: 'web question' } },
    { type: 'assistant', uuid: 'w2', parentUuid: 'w1' },
    { type: 'last-prompt', lastPrompt: 'web question', leafUuid: 'w1', sessionId: 's' }, // written at submit
  ];
  const TERMINAL = [
    { type: 'user', uuid: 't1', parentUuid: 'w2', message: { role: 'user', content: 'terminal question' } },
    { type: 'last-prompt', lastPrompt: 'terminal question', leafUuid: 'w2', sessionId: 's' },
    { type: 'assistant', uuid: 't2', parentUuid: 't1' },
  ];
  const EXIT_FLUSH = [
    { type: 'last-prompt', lastPrompt: 'web question', leafUuid: 'w2', sessionId: 's' },
    { type: 'cost-state', sessionId: 's', totalCostUSD: 0.01 },
  ];
  const sized = (rows: object[], pad = 0) => {
    const f = file(rows, pad);
    return { f, size: fs.statSync(f).size };
  };

  it("the exiting process's stale leaf does not count: the terminal's newest entry becomes the leaf", () => {
    const { f, size } = sized([...WEB, ...TERMINAL]);
    fs.appendFileSync(f, EXIT_FLUSH.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(repairLeaf(f, 's')).toBe(false); // without the offset the flush looks like a /rewind and would stand
    expect(repairLeaf(f, 's', { ignoreLeavesFrom: size })).toBe(true);
    expect(lines(f).at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: 't2' });
    expect(repairLeaf(f, 's', { ignoreLeavesFrom: size })).toBe(false); // idempotent
  });

  it('a /rewind in the terminal before the flush is put back on top', () => {
    const rewind = { type: 'last-prompt', lastPrompt: 'terminal question', leafUuid: 'w1', sessionId: 's' };
    const { f, size } = sized([...WEB, ...TERMINAL, rewind]);
    fs.appendFileSync(f, EXIT_FLUSH.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(repairLeaf(f, 's', { ignoreLeavesFrom: size })).toBe(true);
    expect(lines(f).at(-1).leafUuid).toBe('w1');
  });

  it('no flush after the offset (the process was killed first, or ccb): same as without the option', () => {
    const { f, size } = sized([...WEB, ...TERMINAL]);
    expect(repairLeaf(f, 's', { ignoreLeavesFrom: size })).toBe(true); // t1's leaf (w2) is older than t2
    expect(lines(f).at(-1).leafUuid).toBe('t2');
  });

  it('byte offsets stay right across the read chunks of a big file', () => {
    const { f, size } = sized([...WEB, ...TERMINAL], (1 << 20) - 200);
    fs.appendFileSync(f, EXIT_FLUSH.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(repairLeaf(f, 's', { ignoreLeavesFrom: size })).toBe(true);
    expect(lines(f).at(-1).leafUuid).toBe('t2');
  });
});

describe('lastCostState: the totals the official binary continues from', () => {
  it('the last cost-state of this conversation; none → null', () => {
    const f = file([...ENGINE_SWITCH, { type: 'cost-state', sessionId: 'other', totalCostUSD: 9 }]);
    expect(lastCostState(f, 's')).toEqual({ cost: 0.13310775, models: { 'claude-sonnet-4-6': { inputTokens: 3, outputTokens: 5, costUSD: 0.13310775 } } });
    expect(lastCostState(file(ENGINE_SWITCH.slice(5)), 's')).toBeNull();
    expect(lastCostState(null, 's')).toBeNull();
  });
});

describe('lastHumanPrompt: the last thing a person typed', () => {
  it('skips tool results, meta, commands, compaction and subagents', async () => {
    const { lastHumanPrompt } = await import('./transcript-file.js');
    const f = file([
      { type: 'user', uuid: 'p1', parentUuid: null, message: { role: 'user', content: 'first question' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'p1' },
      { type: 'user', uuid: 'p2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'text', text: 'second question' }] } },
      { type: 'user', uuid: 't1', parentUuid: 'p2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
      { type: 'user', uuid: 'm1', parentUuid: 't1', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } },
      { type: 'user', uuid: 'c1', parentUuid: 'm1', message: { role: 'user', content: '<command-name>/effort</command-name>' } },
      { type: 'user', uuid: 's1', parentUuid: 'x', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
      { type: 'last-prompt', lastPrompt: 'second question', sessionId: 's' },
    ]);
    expect(lastHumanPrompt(f)).toBe('p2');
    expect(lastHumanPrompt(null)).toBeNull();
  });
});

describe('hasEntry', () => {
  it('finds a uuid near the end; not a mention of it in another entry', async () => {
    const { hasEntry } = await import('./transcript-file.js');
    const f = file([{ type: 'assistant', uuid: 'a9', parentUuid: null }, { type: 'user', uuid: 'u1', parentUuid: 'a9', message: { content: 'see a7' } }]);
    expect(hasEntry(f, 'a9')).toBe(true);
    expect(hasEntry(f, 'a7')).toBe(false);
    expect(hasEntry(null, 'a9')).toBe(false);
  });
});
