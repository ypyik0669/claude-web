import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionFeatures } from '@shared';
import { useStore } from '@/store';
import { ago, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { CAPABILITIES, CHANNELS, parseChannels, plusSections, withChannels, withFeature, type FeatureKey } from './capabilities';
import { PLUS_ID } from './ids';
import { Popover } from './Popover';

export interface PlusMenuProps {
  /** the conversation runs on Claude (the capabilities are Claude Code flags) */
  claude: boolean;
  /** an already running conversation: its capabilities were fixed when it started — shown read-only */
  live: boolean;
  remote?: boolean;
  disabled?: boolean;
  /** the switches as shown: the welcome page's set for the new conversation, or (live) what this one started with */
  features: SessionFeatures;
  /** welcome page only (a live conversation's switches are read-only) */
  onFeatures: (f: SessionFeatures) => void;
  onFiles: () => void;
  onFolder: () => void;
  onReference: (s: { id: string; title: string }) => void;
  /** the conversation's own id: it cannot reference itself */
  selfId?: string;
  onGoal: () => void;
}

/**
 * The composer's `+` (spec §5.4): attachments, a reference to another conversation, and what used to be the 「功能」
 * dropdown — the per-conversation capabilities (browser, computer, goal; coordinator / proactive / Brief / channels
 * under 进阶). One level; 「引用另一个对话」 swaps the menu body for a searchable conversation list. Every row renders
 * its `data-id` from `PLUS_ID` / the capability keys — the reach table and ui-smoke read the same ids.
 */
export function PlusMenu(p: PlusMenuProps) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus(); };
  return (
    <>
      <button ref={btn} type="button" className={clsx('plus', open && 'open')} disabled={p.disabled} onClick={() => setOpen((o) => !o)} title="添加文件、引用对话，或让 Claude 这次还能做什么" aria-label="添加" aria-haspopup="menu" aria-expanded={open}>
        <Icon name="plus" size={16} />
      </button>
      {open && (
        <ErrorBoundary area="+ 菜单" compact onReset={() => setOpen(false)}>
          <Popover anchor={btn} onClose={close} prefer="up" align="left" className="plus-menu" label="添加">
            <PlusBody {...p} close={close} />
          </Popover>
        </ErrorBoundary>
      )}
    </>
  );
}

function PlusBody(p: PlusMenuProps & { close: (refocus: boolean) => void }) {
  const [view, setView] = useState<'main' | 'reference'>('main');
  const [more, setMore] = useState(() => !!(p.features.brief || p.features.channels?.length));
  const briefRow = useRef<HTMLButtonElement>(null);
  const focusBrief = useRef(false);
  // 「Brief、频道…」 expands in place: the row that was focused is gone, so the focus moves to the first new row
  useEffect(() => {
    if (!more || !focusBrief.current) return;
    focusBrief.current = false;
    briefRow.current?.focus();
  }, [more]);
  const s = plusSections({ claude: p.claude, live: p.live, remote: p.remote });
  if (view === 'reference') return <ReferenceList selfId={p.selfId} onBack={() => setView('main')} onPick={(x) => { p.close(true); p.onReference(x); }} />;
  const toggle = (k: FeatureKey) => { if (!s.readOnly) p.onFeatures(withFeature(p.features, k, !p.features[k])); };
  const row = (k: FeatureKey) => {
    const c = CAPABILITIES.find((x) => x.key === k)!;
    const on = !!p.features[k];
    return (
      <button key={k} ref={k === 'brief' ? briefRow : undefined} type="button" data-mi data-id={k} role="menuitemcheckbox" aria-checked={on} aria-disabled={s.readOnly || undefined}
        className={clsx('cm-it', on && 'on', s.readOnly && 'ro')} title={s.readOnly ? `${c.title}\n这个对话${on ? '开着' : '没开'}` : c.title} onClick={() => toggle(k)}>
        <span className="cm-ic"><Icon name={c.icon} size={15} /></span>
        <span className="cm-tx"><span className="cm-l">{c.label}</span><span className="cm-d">{c.desc}</span></span>
        <span className={clsx('toggle sm', on && 'on')} aria-hidden />
      </button>
    );
  };
  return (
    <>
      {s.attach.map((a) => {
        const act = a.id === PLUS_ID.files ? () => { p.close(false); p.onFiles(); } : a.id === PLUS_ID.folder ? () => { p.close(false); p.onFolder(); } : () => setView('reference');
        return (
          <button key={a.id} type="button" data-mi data-id={a.id} role="menuitem" className="cm-it one" disabled={!!a.disabled} title={a.disabled} onClick={act}>
            <span className="cm-ic"><Icon name={a.icon} size={15} /></span>
            <span className="cm-tx"><span className="cm-l">{a.label}</span></span>
            {a.note && <span className="cm-r">{a.note}</span>}
            {a.id === PLUS_ID.reference && <span className="cm-r"><Icon name="chevronRight" size={12} /></span>}
          </button>
        );
      })}
      <div className="menu-sep" />
      <div className="cm-h">这次对话可以…</div>
      {s.note && <div className="cm-sub">{s.note}</div>}
      {s.capabilities && CAPABILITIES.filter((c) => c.group === 'main').map((c) => row(c.key))}
      {s.goal && (
        <button type="button" data-mi data-id={PLUS_ID.goal} role="menuitem" className="cm-it" title="在输入框写下目标并发送：Claude 会一轮接一轮做下去，直到完成或卡住（等同于 /goal）" onClick={() => { p.close(false); p.onGoal(); }}>
          <span className="cm-ic"><Icon name="goals" size={15} /></span>
          <span className="cm-tx"><span className="cm-l">设定一个目标</span><span className="cm-d">一轮接一轮做下去，直到完成或卡住</span></span>
          <span className="cm-r"><Icon name="chevronRight" size={12} /></span>
        </button>
      )}
      {s.capabilities && (
        <>
          <div className="menu-sep" />
          <div className="cm-h">进阶</div>
          {CAPABILITIES.filter((c) => c.group === 'advanced' && c.key !== 'brief').map((c) => row(c.key))}
          {more ? (
            <>
              {row('brief')}
              <ChannelsField features={p.features} readOnly={s.readOnly} onFeatures={p.onFeatures} />
            </>
          ) : (
            <button type="button" data-mi data-id={PLUS_ID.more} className="cm-it one dim" aria-expanded={false} onClick={() => { focusBrief.current = true; setMore(true); }}>
              <span className="cm-ic"><Icon name="more" size={15} /></span>
              <span className="cm-tx"><span className="cm-l">Brief、频道…</span></span>
            </button>
          )}
        </>
      )}
    </>
  );
}

/**
 * 频道 (--channels): a controlled field saved as you type (a short debounce, flushed on Enter, blur and when the menu
 * closes — closing it with a click outside used to drop what was typed). Read-only in a running conversation.
 */
function ChannelsField({ features, readOnly, onFeatures }: { features: SessionFeatures; readOnly: boolean; onFeatures: (f: SessionFeatures) => void }) {
  const [text, setText] = useState(() => (features.channels ?? []).join(', '));
  const latest = useRef({ features, onFeatures });
  latest.current = { features, onFeatures };
  const pending = useRef<string | null>(null);
  const timer = useRef(0);
  const flush = () => {
    window.clearTimeout(timer.current);
    const v = pending.current;
    pending.current = null;
    if (v === null) return;
    const next = parseChannels(v);
    const cur = latest.current.features.channels ?? [];
    if (next.join('\n') !== cur.join('\n')) latest.current.onFeatures(withChannels(latest.current.features, next));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flush(), []);
  return (
    <div className="cm-field" data-id={PLUS_ID.channels} title={CHANNELS.title}>
      <span className="cm-ic"><Icon name="bell" size={15} /></span>
      <label className="cm-tx">
        <span className="cm-l">{CHANNELS.label}</span>
        <span className="cm-d">{CHANNELS.desc}</span>
        <input className="field" data-mi placeholder={readOnly ? '' : CHANNELS.placeholder} value={text} readOnly={readOnly} aria-label="频道"
          onChange={(e) => {
            if (readOnly) return;
            setText(e.target.value);
            pending.current = e.target.value;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(flush, 300);
          }}
          onBlur={flush}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); flush(); } }} />
      </label>
    </div>
  );
}

/** 「引用另一个对话」: pick one; its briefing goes along with the message (<session-ref />, expanded by the server). */
function ReferenceList({ selfId, onBack, onPick }: { selfId?: string; onBack: () => void; onPick: (s: { id: string; title: string }) => void }) {
  const sessions = useStore((s) => s.sessions);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return sessions.filter((s) => s.sessionId !== selfId && (!t || `${s.title} ${s.cwd}`.toLowerCase().includes(t))).slice(0, 40);
  }, [sessions, q, selfId]);
  return (
    <div className="cm-ref">
      <div className="cm-ref-head">
        <button type="button" data-mi className="icon-btn xs" aria-label="返回" onClick={onBack}><Icon name="chevronRight" size={12} className="flip" /></button>
        <input className="field" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索对话…" aria-label="搜索对话"
          onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); onPick({ id: list[0].sessionId, title: list[0].title }); } }} />
      </div>
      <div className="cm-ref-list">
        {list.map((s) => (
          <button key={s.sessionId} type="button" data-mi className="cm-it one" onClick={() => onPick({ id: s.sessionId, title: s.title })} title={s.cwd}>
            <span className="cm-ic"><Icon name="chat" size={14} /></span>
            <span className="cm-tx"><span className="cm-l">{s.title}</span></span>
            <span className="cm-r">{s.cwd.split(/[\\/]/).pop()} · {ago(s.lastModified)}</span>
          </button>
        ))}
        {!list.length && <div className="menu-note">{q ? `没有匹配「${q}」的对话` : '还没有别的对话'}</div>}
      </div>
    </div>
  );
}
