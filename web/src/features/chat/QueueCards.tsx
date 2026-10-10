import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { QUEUED_HINT, QUEUE_ACTIONS, QUEUE_FOLD_LABEL, QUEUE_LIST_LABEL, queueSig, queueView, type QueuedLike } from './queue-card';

/** A card that was just queued comes in once (styles/extras.css `.queue-card.enter`) — not again every time its tab is shown. */
const enter = (el: HTMLDivElement | null) => {
  if (!el || el.dataset.in) return;
  el.dataset.in = '1';
  el.classList.add('enter');
};

/**
 * The messages sent while a turn runs: a small dashed card each, right above the composer's box (UI refresh §8).
 * 编辑 takes one out of the queue and back into the box, 立即发送 stops the turn for it, 删除 drops it. The queue is
 * the store's (`recall`, `stopAndRun`); what a card says is queue-card.ts.
 */
export function QueueCards({ sessionId, queue, onEdit }: { sessionId: string; queue: readonly QueuedLike[]; onEdit: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // the store pushes onto the same array, so the array's identity says nothing: the ids say when the cards change
  const sig = queueSig(queue);
  const view = useMemo(() => queueView(queue, open), [sig, open]);
  // back under the fold's size: the next time it grows past it, it starts folded again
  useEffect(() => { if (open && !view.foldable) setOpen(false); }, [open, view.foldable]);
  if (!view.cards.length) return null;

  const st = useStore.getState;
  /**
   * The card under a keyboard's focus is gone: the same button on the card that took its place (else the last
   * card's), and with no card left the composer's box. A click or a tap keeps its focus where it is — on a phone
   * focusing the box would bring the keyboard up.
   */
  const refocus = (e: MouseEvent<HTMLElement>, pos: number) => {
    if (e.detail !== 0) return;
    const act = e.currentTarget.dataset.act;
    const composer = e.currentTarget.closest('.composer');
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const cards = box.current?.querySelectorAll<HTMLElement>('.queue-card');
      const card = cards?.length ? cards[Math.min(pos - 1, cards.length - 1)] : undefined;
      (card?.querySelector<HTMLElement>(`[data-act="${act}"]`) ?? composer?.querySelector<HTMLElement>('textarea'))?.focus();
    });
  };

  return (
    <div className="queue-cards" ref={box} role="list" aria-label={QUEUE_LIST_LABEL} data-count={queue.length}>
      {view.cards.map((c) => (
        <div key={c.id} ref={enter} className="queue-card" role="listitem" data-queue-id={c.id} data-pos={c.pos} onAnimationEnd={(e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('enter'); }}>
          <div className="qc-body">
            <div className="qc-label" title={QUEUED_HINT}>{c.label}</div>
            {c.preview && <div className="qc-text" title={c.full}>{c.preview}</div>}
            {c.extras && <div className="qc-extras">{c.extras}</div>}
          </div>
          <div className="qc-acts">
            <button type="button" className="qc-act" data-act="edit" title={QUEUE_ACTIONS.edit.title} aria-label={QUEUE_ACTIONS.edit.label} onClick={() => { const m = st().recall(sessionId, c.id); if (m) onEdit(m.text); }}>
              <Icon name="edit" size={16} /><span className="qc-word">{QUEUE_ACTIONS.edit.label}</span>
            </button>
            <button type="button" className="qc-act" data-act="now" title={QUEUE_ACTIONS.now.title} aria-label={QUEUE_ACTIONS.now.label} onClick={(e) => { refocus(e, c.pos); void st().stopAndRun(sessionId, c.id); }}>
              <Icon name="send" size={16} /><span className="qc-word">{QUEUE_ACTIONS.now.label}</span>
            </button>
            <button type="button" className="qc-act" data-act="remove" title={QUEUE_ACTIONS.remove.title} aria-label={QUEUE_ACTIONS.remove.label} onClick={(e) => { refocus(e, c.pos); st().recall(sessionId, c.id); }}>
              <Icon name="trash" size={16} /><span className="qc-word">{QUEUE_ACTIONS.remove.label}</span>
            </button>
          </div>
        </div>
      ))}
      {view.foldable && (
        <div className="qc-more" role="listitem">
          <button type="button" className="queue-more" data-act="more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? QUEUE_FOLD_LABEL : view.more}
          </button>
        </div>
      )}
    </div>
  );
}
