import { useMemo } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { useOrch, waitingOf } from '@/features/orchestra/state';
import { NO_SELECTION, SessionRow, StatusMark, openFromSidebar, type RowCtx } from './rows';
import { showPanel } from './panels';
import { dismissKey, needsYou, type AttentionItem, type OpenLike } from './status';
import type { SectionId } from './entries';

/**
 * 「需要你」 (spec §5.1 / §5.9): only while something waits for a human — a permission request or question, an
 * orchestration approval / pick, a conversation whose process died. One click goes to it (the card is docked in
 * that conversation; an orchestration node opens the orchestration panel). An error can be dismissed (×) until it
 * changes (the dismissals live in the store: the sidebar unmounts when it is collapsed / the phone drawer closes);
 * the full four-lane board stays in the palette's 总览. Its rows have a context of their own (`where: 'attn'`): the
 * same conversation is also listed in its project, and a menu / expansion must open on the row that was used; they
 * take no part in multi-select (their conversations are selectable where they are listed).
 */
export function NeedsYou({ ctx: listCtx }: { ctx: RowCtx }) {
  const ctx = useMemo<RowCtx>(() => ({ ...listCtx, where: 'attn', sel: NO_SELECTION }), [listCtx]);
  const sessions = useStore((s) => s.sessions);
  // what matters of the open sessions (state, pending tools, error) as one string: a streaming reply re-renders
  // its own row, not this section
  const sig = useStore((s) => Object.values(s.open).map((o) => `${o.sessionId} ${o.state} ${o.pending.map((p) => p.toolName).join(',')} ${o.error ?? ''}`).join('\n'));
  const open = useMemo(() => {
    const out: Record<string, OpenLike> = {};
    for (const o of Object.values(useStore.getState().open)) out[o.sessionId] = { state: o.state, pending: o.pending, error: o.error };
    return out;
  }, [sig]);
  const orchFull = useOrch((s) => s.full);
  const orch = useMemo(() => waitingOf(orchFull), [orchFull]);
  const dismissedMap = useStore((s) => s.attnDismissed);
  const dismissed = useMemo(() => new Set(Object.keys(dismissedMap)), [dismissedMap]);
  const items = useMemo(() => needsYou({ sessions, open, orch, dismissed }), [sessions, open, orch, dismissed]);
  if (!items.length) return null;
  const section: SectionId = 'attention';
  return (
    <div className="sb-sec sb-attn" data-id={section} role="region" aria-label="需要你">
      <div className="sb-sec-h"><span>需要你</span><span className="n">{items.length}</span></div>
      <div className="sb-attn-list">
        {items.map((it) => <Item key={it.kind === 'orch' ? `o:${it.wait.runId}:${it.wait.nodeId}` : it.sessionId} it={it} ctx={ctx} dismiss={(k) => useStore.setState((s) => ({ attnDismissed: { ...s.attnDismissed, [k]: true } }))} />)}
      </div>
    </div>
  );
}

function Item({ it, ctx, dismiss }: { it: AttentionItem; ctx: RowCtx; dismiss: (key: string) => void }) {
  const error = useStore((s) => (it.kind === 'session' ? s.open[it.sessionId]?.error : undefined));
  if (it.kind === 'orch') {
    const w = it.wait;
    // bring the orchestration panel into view first: `ask()` only toggles it when it is not a tab yet, so a tab that
    // is hidden (Ctrl+J), minimized or behind another tab would get the intent and stay out of sight
    // (a phone has no dock: showPanel says so in a toast, and no intent is left behind for later)
    const go = () => {
      showPanel('orchestra');
      if (!useStore.getState().mobile) useOrch.getState().ask('open', w.runId);
    };
    return (
      <div className="sess sb-row flat orch" role="button" tabIndex={0} title={`编排「${w.runName}」· ${w.kind === 'approval' ? '等你审批' : '候选跑完了，等你选一个合并'}`}
        onClick={go} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }}>
        <span className="pip" />
        <Icon name={w.kind === 'approval' ? 'approval' : 'compare'} size={13} className="orch-ic" />
        <span className="t">{w.title}</span>
        <span className="st need">{w.kind === 'approval' ? '待审批' : '待选择'}</span>
      </div>
    );
  }
  const x = (
    <button className="dismiss" title="忽略（出错信息变了会再出现）" aria-label="忽略" onClick={(e) => { e.stopPropagation(); dismiss(dismissKey(it.sessionId, error)); }}><Icon name="close" size={12} /></button>
  );
  if (it.summary) {
    return (
      <div className={clsx('sb-attn-item', it.status.kind === 'error' && 'can-dismiss')}>
        <SessionRow s={it.summary} ctx={ctx} flat pip />
        {it.status.kind === 'error' && x}
      </div>
    );
  }
  // open here but not in the list yet (a brand-new conversation)
  return (
    <div className={clsx('sb-attn-item', it.status.kind === 'error' && 'can-dismiss')}>
      <div className="sess sb-row flat" role="button" tabIndex={0} onClick={() => openFromSidebar(it.sessionId, 'replace')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFromSidebar(it.sessionId, 'replace'); } }} title={it.status.title}>
        <span className={clsx('pip', it.status.kind === 'error' && 'err')} />
        <span className="t">{it.title}</span>
        <StatusMark st={it.status} />
      </div>
      {it.status.kind === 'error' && x}
    </div>
  );
}
