import { describe, expect, it } from 'vitest';
import { askQuestions, assemble, askKey, answerOf, EMPTY_DRAFT, OTHER, pick, rowEnter, rowFor, skip, skippedAnswer, step, type AskQ } from './ask-card';

const single: AskQ = { question: '用哪个库？', header: '库', options: [{ label: 'zod' }, { label: 'yup', description: '老一点' }], multiSelect: false };
const multi: AskQ = { question: '要哪些检查？', options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }], multiSelect: true };

describe('askQuestions', () => {
  it('keeps well-formed questions, drops junk, defaults multiSelect to false', () => {
    const qs = askQuestions({ questions: [{ question: 'A?', options: [{ label: 'x', preview: 'p' }, { nope: 1 }] }, { header: 'no question' }, null] });
    expect(qs).toEqual([{ question: 'A?', header: undefined, options: [{ label: 'x', description: undefined, preview: 'p' }], multiSelect: false }]);
    expect(askQuestions(undefined)).toEqual([]);
    // a list sent as a JSON string, one question as a bare object (2026-11-14: a model did, and the conversation went down)
    expect(askQuestions({ questions: JSON.stringify([{ question: 'A?', options: [{ label: 'x' }] }]) })).toEqual([{ question: 'A?', header: undefined, options: [{ label: 'x', description: undefined, preview: undefined }], multiSelect: false }]);
    expect(askQuestions({ questions: { question: 'A?' } }).map((q) => q.question)).toEqual(['A?']);
    for (const questions of ['nope', 3, true, '"str"']) expect(askQuestions({ questions })).toEqual([]);
  });
});

describe('pick / answerOf', () => {
  it('single choice: one label; picking another replaces it; 其它 clears the pick', () => {
    let d = pick(single, EMPTY_DRAFT, 'zod');
    d = pick(single, d, 'yup');
    expect(answerOf(single, d)).toBe('yup');
    d = pick(single, d, OTHER);
    expect(d.picked).toEqual([]);
    expect(answerOf(single, d)).toBeNull(); // 其它 on, nothing typed yet
    expect(answerOf(single, { ...d, other: '  valibot ' })).toBe('valibot');
  });
  it('multi choice: toggles, joined in option order with ", ", 其它 last', () => {
    let d = pick(multi, EMPTY_DRAFT, 'build');
    d = pick(multi, d, 'lint');
    d = pick(multi, d, OTHER);
    expect(answerOf(multi, { ...d, other: 'e2e' })).toBe('lint, build, e2e');
    d = pick(multi, d, 'lint');
    expect(answerOf(multi, { ...d, other: 'e2e' })).toBe('build, e2e');
  });
  it('nothing picked → null; skipped → 「（用户跳过）」', () => {
    expect(answerOf(single, EMPTY_DRAFT)).toBeNull();
    expect(answerOf(single, undefined)).toBeNull();
    expect(answerOf(single, skip(EMPTY_DRAFT))).toBe(skippedAnswer());
  });
  it('picking after a skip un-skips', () => {
    expect(pick(single, skip(EMPTY_DRAFT), 'zod').skipped).toBe(false);
  });
  it('跳过 clears the page’s picks and 其它 text (C-V2): going back shows nothing chosen, the answer is the skip', () => {
    const d = skip({ ...pick(multi, EMPTY_DRAFT, 'lint'), otherOn: true, other: 'e2e' });
    expect(d).toEqual({ ...EMPTY_DRAFT, skipped: true });
    expect(answerOf(multi, d)).toBe(skippedAnswer());
    // a new pick after it: only that pick, no longer skipped
    const again = pick(multi, d, 'test');
    expect(again).toMatchObject({ picked: ['test'], skipped: false });
    expect(answerOf(multi, again)).toBe('test');
    // 其它 after a skip un-skips too
    expect(pick(single, skip(EMPTY_DRAFT), OTHER).skipped).toBe(false);
  });
});

describe('rowFor / rowEnter (focus and Enter on a row)', () => {
  it('rowFor: the 其它 row when it is on, else the first chosen option, else the first row', () => {
    expect(rowFor(single, undefined)).toBe(0);
    expect(rowFor(single, pick(single, EMPTY_DRAFT, 'yup'))).toBe(1);
    expect(rowFor(multi, pick(multi, pick(multi, EMPTY_DRAFT, 'build'), 'test'))).toBe(1);
    expect(rowFor(single, pick(single, EMPTY_DRAFT, OTHER))).toBe(2);
    expect(rowFor(undefined, EMPTY_DRAFT)).toBe(0);
  });
  it('single choice: Enter on an option picks it and goes on', () => {
    expect(rowEnter(single, EMPTY_DRAFT, 1)).toEqual({ t: 'pick-next', label: 'yup' });
  });
  it('multi choice: Enter goes to the next question, never ticks (C-V3; Space ticks — the button’s own click)', () => {
    expect(rowEnter(multi, pick(multi, EMPTY_DRAFT, 'lint'), 2)).toEqual({ t: 'next' });
    expect(rowEnter(multi, EMPTY_DRAFT, 0)).toEqual({ t: 'next' });
  });
  it('其它: the first Enter opens its box, the next one goes on', () => {
    expect(rowEnter(single, EMPTY_DRAFT, 2)).toEqual({ t: 'other' });
    expect(rowEnter(multi, { ...EMPTY_DRAFT, otherOn: true, other: 'x' }, 3)).toEqual({ t: 'next' });
  });
});

describe('assemble', () => {
  it('every question answered → allow with question → answer', () => {
    expect(assemble([single, multi], [pick(single, EMPTY_DRAFT, 'zod'), pick(multi, EMPTY_DRAFT, 'test')])).toEqual({ kind: 'allow', answers: { '用哪个库？': 'zod', '要哪些检查？': 'test' } });
  });
  it('one skipped, one answered → allow, the skipped one says so', () => {
    const r = assemble([single, multi], [skip(EMPTY_DRAFT), pick(multi, EMPTY_DRAFT, 'lint')]);
    expect(r).toEqual({ kind: 'allow', answers: { '用哪个库？': skippedAnswer(), '要哪些检查？': 'lint' } });
  });
  it('all skipped → deny (the old 跳过)', () => {
    expect(assemble([single, multi], [skip(EMPTY_DRAFT), skip(EMPTY_DRAFT)])).toEqual({ kind: 'deny' });
  });
  it('an unanswered question → incomplete at the first one', () => {
    expect(assemble([single, multi], [pick(single, EMPTY_DRAFT, 'zod'), undefined])).toEqual({ kind: 'incomplete', first: 1 });
  });
});

describe('step (下一题 / 提交)', () => {
  it('stays on an unanswered page, goes to the next one when answered, sends on the last', () => {
    const qs = [single, multi];
    expect(step(qs, [], 0)).toEqual({ t: 'stay' });
    expect(step(qs, [pick(single, EMPTY_DRAFT, 'zod')], 0)).toEqual({ t: 'goto', index: 1 });
    expect(step(qs, [pick(single, EMPTY_DRAFT, 'zod'), pick(multi, EMPTY_DRAFT, 'lint')], 1)).toEqual({ t: 'send', result: { kind: 'allow', answers: { '用哪个库？': 'zod', '要哪些检查？': 'lint' } } });
  });
  it('the last page answered but an earlier one left open (paged back and cleared) → back to it', () => {
    expect(step([single, multi], [{ ...EMPTY_DRAFT, otherOn: true }, pick(multi, EMPTY_DRAFT, 'lint')], 1)).toEqual({ t: 'goto', index: 0 });
  });
  it('all skipped on the last page → send deny', () => {
    expect(step([single], [skip(EMPTY_DRAFT)], 0)).toEqual({ t: 'send', result: { kind: 'deny' } });
  });
});

describe('askKey', () => {
  it('↑↓ move, 1–9 pick (index = option count is 其它), Enter / Ctrl+Enter next', () => {
    expect(askKey({ key: 'ArrowDown' }, 2)).toEqual({ t: 'move', by: 1 });
    expect(askKey({ key: 'ArrowUp' }, 2)).toEqual({ t: 'move', by: -1 });
    expect(askKey({ key: '1' }, 2)).toEqual({ t: 'pick', index: 0 });
    expect(askKey({ key: '3' }, 2)).toEqual({ t: 'pick', index: 2 });
    expect(askKey({ key: '4' }, 2)).toBeNull();
    expect(askKey({ key: 'Enter' }, 2)).toEqual({ t: 'next' });
    expect(askKey({ key: 'Enter', ctrl: true }, 2)).toEqual({ t: 'next' });
    expect(askKey({ key: 'Enter', shift: true }, 2)).toBeNull();
  });
  it('nothing while the IME composes; in the 其它 box only Enter counts', () => {
    expect(askKey({ key: 'Enter', composing: true }, 2)).toBeNull();
    expect(askKey({ key: '1', inText: true }, 2)).toBeNull();
    expect(askKey({ key: 'ArrowDown', inText: true }, 2)).toBeNull();
    expect(askKey({ key: 'Enter', inText: true }, 2)).toEqual({ t: 'next' });
  });
});
