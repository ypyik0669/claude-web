import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseDraft, generateBot, GENERATE_PROMPT } from './generate.js';

describe('parseDraft', () => {
  it('reads the json block and fills defaults', () => {
    const b = parseDraft('好的：\n```json\n{"name":"小晨","charter":{"role":"出晨报","sources":["github"]},"routines":[{"name":"晨报","prompt":"汇总","cron":"0 8 * * *"}]}\n```', '/p');
    expect(b).toMatchObject({ name: '小晨', cwd: '/p', tier: 'balanced', outputs: [{ kind: 'inbox' }] });
    expect(b.routines[0]).toMatchObject({ name: '晨报', cron: '0 8 * * *', enabled: true, onFail: 'inbox', acceptance: { kind: 'none' } });
    expect(b.routines[0].id).toMatch(/^r_/);
  });
  it('a bad cron falls back to daily; no routines gives one daily routine', () => {
    const b = parseDraft('```json\n{"name":"x","charter":{"role":"r","sources":[]},"routines":[{"name":"a","prompt":"p","cron":"0 0 30 2 *"}]}\n```', '/p');
    expect(b.routines[0].cron).toBeUndefined(); expect(b.routines[0].everyMinutes).toBe(1440);
    expect(parseDraft('```json\n{"name":"x","charter":{"role":"r","sources":[]}}\n```', '/p').routines[0].everyMinutes).toBe(1440);
  });
  it('a missing name takes the first 12 characters of the sentence', () => {
    expect(parseDraft('```json\n{"charter":{"role":"r","sources":[]}}\n```', '/p', '每天早上八点帮我看一下仓库的新 issue').name).toBe('每天早上八点帮我看一下仓');
  });
  it('an interval under 15 minutes is raised to 15 and named in clamped', () => {
    const b = parseDraft('```json\n{"name":"x","charter":{"role":"r","sources":[]},"routines":[{"name":"快","prompt":"p","everyMinutes":5},{"name":"慢","prompt":"p","everyMinutes":60}]}\n```', '/p');
    expect(b.routines.map((r) => r.everyMinutes)).toEqual([15, 60]);
    expect(b.clamped).toEqual(['快']);
    expect(parseDraft('```json\n{"name":"x","charter":{"role":"r","sources":[]}}\n```', '/p').clamped).toBeUndefined();
  });
  it('no json block throws', () => { expect(() => parseDraft('没有', '/p')).toThrow(); });
  it('a draft with no (or a bad) tier gets the default tier; a good one is kept', () => {
    const j = (tier: string) => `\`\`\`json\n{"name":"x","charter":{"role":"r","sources":[]}${tier}}\n\`\`\``;
    expect(parseDraft(j(''), '/p').tier).toBe('balanced');
    expect(parseDraft(j(''), '/p', '', 'best').tier).toBe('best');
    expect(parseDraft(j(',"tier":"huge"'), '/p', '', 'cheap').tier).toBe('cheap');
    expect(parseDraft(j(',"tier":"best"'), '/p', '', 'cheap').tier).toBe('best');
  });
});

describe('generateBot', () => {
  it('opens a chat-only conversation, sends the prompt, parses the answer, closes', async () => {
    const r: any = new EventEmitter(); r.sessionId = 's'; r.state = 'idle'; r.closed = false;
    r.send = () => setTimeout(() => r.emit('message', { type: 'result', is_error: false, result: '```json\n{"name":"小晨","charter":{"role":"出晨报","sources":[]},"routines":[]}\n```' }), 0);
    r.close = async () => { r.closed = true; }; r.interrupt = async () => {};
    let params: any;
    const b = await generateBot({ open: (p) => { params = p; return r; }, defaultProvider: () => 'relay' }, '每天早上盯 issue', '/p');
    expect(params).toMatchObject({ features: { chatOnly: true }, permissionMode: 'dontAsk', providerId: 'relay' });
    expect(b.name).toBe('小晨'); expect(r.closed).toBe(true);
    expect(b.tier).toBe('balanced');
    expect((await generateBot({ open: () => r, defaultProvider: () => 'relay', defaultTier: () => 'cheap' }, 'x', '/p')).tier).toBe('cheap');
    expect(GENERATE_PROMPT('x')).toContain('```json');
  });
});
