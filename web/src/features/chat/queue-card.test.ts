import { describe, expect, it } from 'vitest';
import { sessionRefMarker } from '@/model/conversation';
import { QUEUED_LABEL, QUEUE_FOLD_OVER, QUEUE_FOLD_SHOWN, QUEUE_PREVIEW_MAX, queueLabel, queueSig, queueView, type QueuedLike } from './queue-card';

const q = (id: string, text: string, extra: Partial<QueuedLike> = {}): QueuedLike => ({ id, text, ...extra });
const many = (n: number) => Array.from({ length: n }, (_, i) => q(`m${i + 1}`, `message ${i + 1}`));

describe('queueLabel: the first line of a queued card', () => {
  it('the one that goes next says when: after this turn', () => {
    expect(QUEUED_LABEL).toBe('已排队，这一轮结束后发送');
    expect(queueLabel(1)).toBe(QUEUED_LABEL);
  });

  it('the ones behind it say their place instead (they wait for more than this turn)', () => {
    expect(queueLabel(2)).toBe('已排队，排在第 2 条');
    expect(queueLabel(5)).toBe('已排队，排在第 5 条');
  });
});

describe('queueView: what the cards above the composer show', () => {
  it('nothing queued: no cards, nothing folded', () => {
    expect(queueView([], false)).toEqual({ cards: [], hidden: 0, more: '', foldable: false });
  });

  it('a card carries the message\'s id, its place, its words and what 编辑 puts back', () => {
    const v = queueView([q('a', 'fix the tests'), q('b', 'then push')], false);
    expect(v.cards).toEqual([
      { id: 'a', pos: 1, label: QUEUED_LABEL, preview: 'fix the tests', full: 'fix the tests', extras: '', restore: 'fix the tests' },
      { id: 'b', pos: 2, label: '已排队，排在第 2 条', preview: 'then push', full: 'then push', extras: '', restore: 'then push' },
    ]);
    expect(v.hidden).toBe(0);
  });

  it('line breaks and runs of blanks are one space in the preview (the card clips it to two lines); the tooltip keeps them', () => {
    const [c] = queueView([q('a', 'first line\n\n  second   line\n')], false).cards;
    expect(c.preview).toBe('first line second line');
    expect(c.full).toBe('first line\n\n  second   line');
  });

  it('a long message is cut, by character (not through the middle of an emoji), and says so with …', () => {
    const long = '字'.repeat(QUEUE_PREVIEW_MAX - 1) + '😀😀😀';
    const [c] = queueView([q('a', long)], false).cards;
    expect([...c.preview]).toHaveLength(QUEUE_PREVIEW_MAX + 1);
    expect(c.preview.endsWith('😀…')).toBe(true);
    expect(c.full).toBe(long);
    const exact = 'x'.repeat(QUEUE_PREVIEW_MAX);
    expect(queueView([q('b', exact)], false).cards[0].preview).toBe(exact);
  });

  it('attachments and images are counted, as the status strip counted them', () => {
    const [c] = queueView([q('a', 'look at these', { attachments: [{}, {}], images: [{}] })], false).cards;
    expect(c.extras).toBe('2 个附件 · 1 张图');
    expect(queueView([q('b', 'x', { images: [{}, {}, {}] })], false).cards[0].extras).toBe('3 张图');
    expect(queueView([q('c', 'x', { attachments: [], images: [] })], false).cards[0].extras).toBe('');
  });

  it('a referenced conversation is a count, not markup in the preview — and 编辑 still puts the marker back', () => {
    const text = `compare with this\n\n${sessionRefMarker('s-1', 'the "old" one')}`;
    const [c] = queueView([q('a', text)], false).cards;
    expect(c.preview).toBe('compare with this');
    expect(c.full).toBe('compare with this');
    expect(c.extras).toBe('引用 1 个对话');
    expect(c.restore).toBe(text);
  });

  it('only attachments, no words: an empty preview and the counts', () => {
    const [c] = queueView([q('a', '', { attachments: [{}] })], false).cards;
    expect(c).toMatchObject({ preview: '', extras: '1 个附件' });
  });

  it(`up to ${QUEUE_FOLD_OVER} queued: every one has a card`, () => {
    const v = queueView(many(QUEUE_FOLD_OVER), false);
    expect(v.cards.map((c) => c.id)).toEqual(['m1', 'm2', 'm3']);
    expect(v).toMatchObject({ hidden: 0, more: '', foldable: false });
  });

  it(`more than ${QUEUE_FOLD_OVER}: the first ${QUEUE_FOLD_SHOWN} and 「还有 N 条排队…」`, () => {
    const v = queueView(many(5), false);
    expect(v.cards.map((c) => c.id)).toEqual(['m1', 'm2']);
    expect(v.cards.map((c) => c.pos)).toEqual([1, 2]);
    expect(v).toMatchObject({ hidden: 3, more: '还有 3 条排队…', foldable: true });
    expect(queueView(many(4), false)).toMatchObject({ hidden: 2, more: '还有 2 条排队…' });
  });

  it('expanded: all of them, in order, and it can be folded again', () => {
    const v = queueView(many(5), true);
    expect(v.cards.map((c) => c.pos)).toEqual([1, 2, 3, 4, 5]);
    expect(v).toMatchObject({ hidden: 0, more: '', foldable: true });
  });

  it('expanded, then the queue shrinks to what fits: nothing left to fold', () => {
    expect(queueView(many(3), true)).toMatchObject({ hidden: 0, foldable: false });
  });
});

describe('queueSig: changes when the cards would', () => {
  it('the same messages in the same order: the same signature', () => {
    expect(queueSig(many(3))).toBe(queueSig(many(3)));
    expect(queueSig([])).toBe('');
    expect(queueSig(undefined)).toBe('');
  });

  it('one more, one fewer, another order: another signature', () => {
    const three = many(3);
    expect(queueSig(three)).not.toBe(queueSig(many(4)));
    expect(queueSig(three)).not.toBe(queueSig(three.slice(1)));
    expect(queueSig(three)).not.toBe(queueSig([three[1], three[0], three[2]]));
  });
});
