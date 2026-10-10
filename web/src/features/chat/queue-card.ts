// What a queued message's card above the composer shows (QueueCards.tsx draws it; UI refresh §8 「排队的消息」).
// Pure: the queue itself — who is in it, in what order, when one is sent — is the store's (`send`, `recall`,
// `stopAndRun`), untouched by this.
import { decodeAttachments } from '@/model/conversation';

/** The card's first line for the message that goes next. */
export const QUEUED_LABEL = '已排队，这一轮结束后发送';
/** The label's tooltip: what queueing means, and the other way to say something to a running turn. */
export const QUEUED_HINT = '排队的消息在当前轮结束后按顺序发送；用「插话」可以不中断地传递指令';
/** More than this many queued: only the first QUEUE_FOLD_SHOWN have a card until 「还有 N 条排队…」 is opened. */
export const QUEUE_FOLD_OVER = 3;
export const QUEUE_FOLD_SHOWN = 2;
/** Characters of a message a card carries (the card clips them to two lines; the tooltip has all of it). */
export const QUEUE_PREVIEW_MAX = 280;

/** The buttons on a card: their words, and what they say on hover (they are icons only when the card is narrow). */
export const QUEUE_ACTIONS = {
  edit: { label: '编辑', title: '从排队里取出来，放回输入框修改' },
  now: { label: '立即发送', title: '中断当前轮，立刻发送这条' },
  remove: { label: '删除', title: '不发了，从排队里删除' },
} as const;
export const QUEUE_FOLD_LABEL = '收起';
/** What the list of cards is called when it is read out. */
export const QUEUE_LIST_LABEL = '排队的消息';

/** What of a queued message the cards read (the store's QueuedMessage has it). */
export interface QueuedLike { id: string; text: string; images?: readonly unknown[]; attachments?: readonly unknown[] }

export interface QueueCard {
  id: string;
  /** its place in the queue, from 1 */
  pos: number;
  label: string;
  /** its words on one line, without the markers the composer appended; cut at QUEUE_PREVIEW_MAX with … */
  preview: string;
  /** all of its words (the tooltip) */
  full: string;
  /** 「2 个附件 · 1 张图 · 引用 1 个对话」; '' when it is words only */
  extras: string;
  /** what 编辑 puts back into the box: the message as it was queued */
  restore: string;
}

export interface QueueView {
  cards: QueueCard[];
  /** queued messages without a card right now */
  hidden: number;
  /** 「还有 N 条排队…」 while some are hidden, else '' */
  more: string;
  /** there are enough for the fold to exist (collapsed or opened) */
  foldable: boolean;
}

/** Only the next message goes when this turn ends; the ones behind it say where they stand. */
export function queueLabel(pos: number): string {
  return pos <= 1 ? QUEUED_LABEL : `已排队，排在第 ${pos} 条`;
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max).join('')}…`;
}

function card(q: QueuedLike, pos: number): QueueCard {
  const d = decodeAttachments(q.text);
  const refs = d.attachments.filter((a) => a.kind === 'session').length;
  const files = (q.attachments?.length ?? 0) + d.attachments.length - refs;
  const images = q.images?.length ?? 0;
  const extras = [files ? `${files} 个附件` : '', images ? `${images} 张图` : '', refs ? `引用 ${refs} 个对话` : ''].filter(Boolean).join(' · ');
  return { id: q.id, pos, label: queueLabel(pos), preview: cut(d.text.replace(/\s+/g, ' ').trim(), QUEUE_PREVIEW_MAX), full: d.text, extras, restore: q.text };
}

export function queueView(queue: readonly QueuedLike[], expanded: boolean): QueueView {
  const foldable = queue.length > QUEUE_FOLD_OVER;
  const shown = foldable && !expanded ? QUEUE_FOLD_SHOWN : queue.length;
  const hidden = queue.length - shown;
  return { cards: queue.slice(0, shown).map((q, i) => card(q, i + 1)), hidden, more: hidden ? `还有 ${hidden} 条排队…` : '', foldable };
}

/** Changes exactly when the cards would: a queued message is never edited in place, so its id stands for it. */
export function queueSig(queue: readonly QueuedLike[] | undefined): string {
  return queue?.length ? queue.map((q) => q.id).join('\n') : '';
}
