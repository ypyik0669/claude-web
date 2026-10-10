import { describe, expect, it } from 'vitest';
import { fmtStepDuration, mergedLabel, mergedTarget, shortVerb, stepBusy, stepDurationMs, stepState, watchStep, watchedStep } from './step-view';

describe('stepState', () => {
  const t = (status: 'streaming' | 'pending' | 'running' | 'done' | 'error') => ({ id: 'a', status });
  it('one state per step, the same ones as before the refresh', () => {
    expect(stepState(t('done'))).toBe('done');
    expect(stepState(t('error'))).toBe('failed');
    expect(stepState(t('running'))).toBe('active');
    expect(stepState(t('streaming'))).toBe('active');
    expect(stepState(t('pending'))).toBe('pending');
  });
  it('waiting on the user wins over running / queued, never over finished or failed', () => {
    const w = new Set(['a']);
    expect(stepState(t('pending'), w)).toBe('waiting');
    expect(stepState(t('running'), w)).toBe('waiting');
    expect(stepState(t('done'), w)).toBe('done');
    expect(stepState(t('error'), w)).toBe('failed');
    expect(stepState(t('pending'), new Set(['b']))).toBe('pending');
  });
  it('busy = anything not over yet', () => {
    expect((['done', 'failed', 'active', 'pending', 'waiting'] as const).filter(stepBusy)).toEqual(['active', 'pending', 'waiting']);
  });
});

describe('shortVerb', () => {
  it('drops the colon and the object the chip already shows', () => {
    expect(shortVerb('读取文件:')).toBe('读取');
    expect(shortVerb('编辑文件:')).toBe('编辑');
    expect(shortVerb('写入文件:')).toBe('写入');
    expect(shortVerb('运行命令:')).toBe('运行');
    expect(shortVerb('列出文件:')).toBe('列出');
    expect(shortVerb('搜索文本:')).toBe('搜索');
  });
  it('leaves the others as they are, without a trailing colon', () => {
    expect(shortVerb('搜索网页:')).toBe('搜索网页');
    expect(shortVerb('编辑 Notebook:')).toBe('编辑 Notebook');
    expect(shortVerb('更新计划')).toBe('更新计划');
    expect(shortVerb('Fetch')).toBe('Fetch');
    expect(shortVerb('提问：')).toBe('提问');
    expect(shortVerb('')).toBe('');
  });
});

describe('fmtStepDuration', () => {
  it('one decimal under ten seconds, never 0.0', () => {
    expect(fmtStepDuration(0)).toBe('0.1 秒');
    expect(fmtStepDuration(40)).toBe('0.1 秒');
    expect(fmtStepDuration(400)).toBe('0.4 秒');
    expect(fmtStepDuration(1_240)).toBe('1.2 秒');
    expect(fmtStepDuration(9_940)).toBe('9.9 秒');
  });
  it('whole seconds, then minutes, like the turn summary', () => {
    expect(fmtStepDuration(9_960)).toBe('10 秒');
    expect(fmtStepDuration(38_000)).toBe('38 秒');
    expect(fmtStepDuration(102_000)).toBe('1 分 42 秒');
  });
});

describe('mergedLabel', () => {
  it('verb ×N · first target 等', () => {
    expect(mergedLabel('读取', 3, 'a.ts')).toBe('读取 ×3 · a.ts 等');
    expect(mergedLabel('运行', 2, 'npm test')).toBe('运行 ×2 · npm test 等');
    expect(mergedTarget('a.ts')).toBe('a.ts 等');
  });
  it('no target → only the count', () => {
    expect(mergedLabel('更新计划', 2, '')).toBe('更新计划 ×2');
    expect(mergedTarget('')).toBe('');
  });
});

describe('watchStep (the clock of a step this page saw run)', () => {
  it('from the call to the first time it is seen finished; later calls give the same number', () => {
    const t = { startedAt: 1_000 };
    expect(watchStep(t, 'active', 1_050)).toBeUndefined();
    expect(watchStep(t, 'pending', 1_400)).toBeUndefined();
    expect(watchStep(t, 'active', 2_000)).toBeUndefined();
    expect(watchStep(t, 'done', 3_500)).toBe(2_500);
    expect(watchStep(t, 'done', 9_000)).toBe(2_500);
    expect(watchedStep(t)).toBe(true);
  });
  it('a step first seen finished (history) has no clock', () => {
    const t = { startedAt: 1_000 };
    expect(watchStep(t, 'done', 5_000)).toBeUndefined();
    expect(watchStep(t, 'done', 6_000)).toBeUndefined();
    expect(watchedStep(t)).toBe(false);
  });
  it('the time it waited on the user does not count', () => {
    const t = { startedAt: 1_000 };
    watchStep(t, 'pending', 1_010);
    watchStep(t, 'waiting', 1_200);
    watchStep(t, 'waiting', 60_000);
    expect(watchStep(t, 'active', 61_000)).toBeUndefined(); // answered: the clock starts over
    expect(watchStep(t, 'done', 62_300)).toBe(1_300);
  });
  it('no start time → from when it was first seen; a start in the future is not believed', () => {
    const a = {};
    watchStep(a, 'active', 2_000);
    expect(watchStep(a, 'done', 2_700)).toBe(700);
    const b = { startedAt: 9_000 };
    watchStep(b, 'active', 2_000);
    expect(watchStep(b, 'done', 2_700)).toBe(700);
  });
  it('a failed step ends its clock too', () => {
    const t = { startedAt: 0 };
    watchStep(t, 'active', 10);
    expect(watchStep(t, 'failed', 510)).toBe(510);
  });
  it('a step first seen already under way (a running conversation that was loaded) gets no time: it was not watched from its start', () => {
    const t = { startedAt: 5_000 }; // the time it was loaded, not the time it began
    expect(watchStep(t, 'active', 5_010, false)).toBeUndefined();
    expect(watchStep(t, 'done', 8_000, true)).toBeUndefined();
    expect(watchStep(t, 'done', 9_000)).toBeUndefined();
    // …but it was seen unfinished: its finishing happened in view
    expect(watchedStep(t)).toBe(true);
  });
  it('allowed and finished between two looks: no time is made up for it', () => {
    const t = { startedAt: 1_000 };
    watchStep(t, 'waiting', 1_100);
    expect(watchStep(t, 'done', 30_000)).toBeUndefined();
    expect(watchStep(t, 'done', 31_000)).toBeUndefined();
  });
});

describe('stepDurationMs', () => {
  const res = (ts?: string) => ({ content: 'ok', isError: false, ts });
  it('a transcript: from the call to its result', () => {
    const start = Date.parse('2026-10-10T10:00:02.000Z');
    expect(stepDurationMs({ result: res('2026-10-10T10:00:02.400Z') }, { start })).toBe(400);
    expect(stepDurationMs({ result: res('2026-10-10T10:00:40.000Z') }, { start })).toBe(38_000);
  });
  it('times that make no sense are not used (a result before its call, or a day later)', () => {
    const start = Date.parse('2026-10-10T10:00:02.000Z');
    expect(stepDurationMs({ result: res('2026-10-10T10:00:01.000Z') }, { start })).toBeUndefined();
    expect(stepDurationMs({ result: res('2026-10-12T10:00:02.000Z') }, { start })).toBeUndefined();
    expect(stepDurationMs({ result: res('nonsense') }, { start })).toBeUndefined();
  });
  it('live: this page’s clock, or the agent’s last progress report when that is longer', () => {
    expect(stepDurationMs({ result: res() }, { watched: 1_300 })).toBe(1_300);
    expect(stepDurationMs({ result: res(), progress: { elapsed: 12 } }, { watched: 1_300 })).toBe(12_000);
    expect(stepDurationMs({ result: res(), progress: { elapsed: 3 } }, {})).toBe(3_000);
    expect(stepDurationMs({ result: res() }, { watched: 0 })).toBe(0);
  });
  it('what this page measured wins over a transcript’s times (one clock, and no waiting on the user in it)', () => {
    const start = Date.parse('2026-10-10T10:00:02.000Z');
    expect(stepDurationMs({ result: res('2026-10-10T10:00:40.000Z') }, { start, watched: 1_300 })).toBe(1_300);
    expect(stepDurationMs({ result: res('2026-10-10T10:00:40.000Z'), progress: { elapsed: 2 } }, { start })).toBe(2_000);
  });
  it('nothing known → nothing shown', () => {
    expect(stepDurationMs({ result: res() }, {})).toBeUndefined();
    expect(stepDurationMs({}, { start: 5 })).toBeUndefined();
  });
});
