import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LIVE_FEATURES, type SessionFeatures } from '@shared';
import { useStore } from '@/store';
import { ago, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { imeComposing } from '@/ui/ime';
import { CAPABILITIES, CHANNELS, capabilitiesFor, parseChannels, plusSections, withChannels, withFeature, type FeatureKey } from './capabilities';
import { PLUS_ID } from './ids';
import { modKey } from '@/features/workbench/shortcuts';
import { Popover } from './Popover';
import { tr } from '@/i18n';
import { ws } from '@/ws/client';
import { openExtensions } from '@/features/extensions/state';

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
  /** 只聊天, for the new conversation only (never a stored default): no tools at all. Welcome page + Claude only */
  chatOnly?: boolean;
  onChatOnly?: (on: boolean) => void;
  /** 斜杠命令: a `/` in the box, which opens the command list */
  onSlash?: () => void;
  /** 录屏 (stage E3): desktop only — the plain web app has no picker of its own */
  onRecord?: () => void;
  /** a running conversation: its connectors switch on and off here (连接器 ›) */
  sessionId?: string;
  /** a 值班 Bot's conversation: only what goes into the message — no connectors, capabilities, 只聊天 or goal */
  plain?: boolean;
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
      <button ref={btn} type="button" className={clsx('plus', open && 'open')} disabled={p.disabled} onClick={() => setOpen((o) => !o)} title={tr('添加文件、引用对话，或让 Claude 这次还能做什么')} aria-label={tr('添加')} aria-haspopup="menu" aria-expanded={open}>
        <Icon name="plus" size={16} />
      </button>
      {open && (
        <ErrorBoundary area={tr('+ 菜单')} compact onReset={() => setOpen(false)}>
          <Popover anchor={btn} onClose={close} prefer="up" align="left" className="plus-menu" label={tr('添加')}>
            <PlusBody {...p} close={close} />
          </Popover>
        </ErrorBoundary>
      )}
    </>
  );
}

function PlusBody(p: PlusMenuProps & { close: (refocus: boolean) => void }) {
  const [view, setView] = useState<'main' | 'reference' | 'connectors'>('main');
  const s = plusSections({ claude: p.claude, live: p.live, remote: p.remote });
  // 操控电脑 can be switched on only where the server's machine supports it (engine.info). (A hook: before the
  // other view's return — the menu's two views must run the same hooks.)
  const computer = useStore((st) => st.engine?.computerUse === true);
  if (view === 'connectors' && p.sessionId) return <ConnectorList sessionId={p.sessionId} onBack={() => setView('main')} onManage={() => { p.close(false); openExtensions('connectors'); }} />;
  if (view === 'reference') return <ReferenceList selfId={p.selfId} onBack={() => setView('main')} onPick={(x) => { p.close(true); p.onReference(x); }} />;
  const caps = capabilitiesFor({ computer });
  const locked = (k: FeatureKey) => s.readOnly && (!!p.features.chatOnly || !(LIVE_FEATURES as readonly string[]).includes(k));
  const toggle = (k: FeatureKey) => { if (!locked(k)) p.onFeatures(withFeature(p.features, k, !p.features[k], { computer })); };
  const row = (k: FeatureKey) => {
    const c = caps.find((x) => x.key === k)!;
    const on = !!p.features[k] && !c.unavailable;
    const ro = locked(k);
    return (
      <button key={k} type="button" data-mi data-id={k} role="menuitemcheckbox" aria-checked={on} aria-disabled={ro || !!c.unavailable || undefined}
        className={clsx('cm-it', on && 'on', (ro || c.unavailable) && 'ro', c.unavailable && 'na')} title={c.unavailable ? c.title : ro ? tr("{title}\n这个对话{v}", { title: c.title, v: on ? tr('开着') : tr('没开') }) : c.title} onClick={() => { if (!c.unavailable) toggle(k); }}>
        <span className="cm-ic"><Icon name={c.icon} size={15} /></span>
        <span className="cm-tx"><span className="cm-l">{c.label}</span><span className="cm-d">{c.unavailable ?? c.desc}</span></span>
        {c.unavailable ? <span className="cm-na">{tr('暂不可用')}</span> : <span className={clsx('toggle sm', on && 'on')} aria-hidden />}
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
            {a.key && <span className="cm-r kbd">{modKey}+{a.key}</span>}
            {a.id === PLUS_ID.reference && <span className="cm-r"><Icon name="chevronRight" size={12} /></span>}
          </button>
        );
      })}
      {p.onRecord && (
        <button type="button" data-mi data-id={PLUS_ID.record} role="menuitem" className="cm-it one" title={tr('录一段屏幕、窗口或内置浏览器的标签，连同关键帧一起发给 Claude')} onClick={() => { p.close(false); p.onRecord!(); }}>
          <span className="cm-ic"><Icon name="monitor" size={15} /></span>
          <span className="cm-tx"><span className="cm-l">{tr('录屏')}</span></span>
        </button>
      )}
      {p.onSlash && (
        <button type="button" data-mi data-id={PLUS_ID.slash} role="menuitem" className="cm-it one" title={tr('在输入框里打一个 /，列出命令和 skills')} onClick={() => { p.close(false); p.onSlash!(); }}>
          <span className="cm-ic"><Icon name="terminal" size={15} /></span>
          <span className="cm-tx"><span className="cm-l">{tr('斜杠命令')}</span></span>
          <span className="cm-r">/</span>
        </button>
      )}
      {p.sessionId && !p.plain && (
        <button type="button" data-mi data-id={PLUS_ID.connectors} role="menuitem" className="cm-it one" title={tr('这个对话的连接器（MCP）：开关、看状态')} onClick={() => setView('connectors')}>
          <span className="cm-ic"><Icon name="mcp" size={15} /></span>
          <span className="cm-tx"><span className="cm-l">{tr('连接器')}</span></span>
          <span className="cm-r"><Icon name="chevronRight" size={12} /></span>
        </button>
      )}
      {!p.plain && <ConversationRows {...p} s={s} row={row} />}
    </>
  );
}

/** The + menu's part about the conversation itself: what it may do, 只聊天, a goal, and the 进阶 switches. */
function ConversationRows(p: PlusMenuProps & { close: (refocus: boolean) => void; s: ReturnType<typeof plusSections>; row: (k: FeatureKey) => ReactNode }) {
  const { s, row } = p;
  return (
    <>
      <div className="menu-sep" />
      <div className="cm-h">{tr('这次对话可以…')}</div>
      {s.note && <div className="cm-sub">{s.note}</div>}
      {p.onChatOnly && (
        <button type="button" data-mi data-id={PLUS_ID.chatOnly} role="menuitemcheckbox" aria-checked={!!p.chatOnly} className={clsx('cm-it', p.chatOnly && 'on')}
          title={tr('这个新对话不给 Claude 任何工具：不读写文件、不跑命令、不上网，只是聊天')} onClick={() => p.onChatOnly!(!p.chatOnly)}>
          <span className="cm-ic"><Icon name="chat" size={15} /></span>
          <span className="cm-tx"><span className="cm-l">{tr('只聊天')}</span><span className="cm-d">{tr('不碰文件、不跑命令，只这一个新对话')}</span></span>
          <span className={clsx('toggle sm', p.chatOnly && 'on')} aria-hidden />
        </button>
      )}
      {!p.chatOnly && s.capabilities && CAPABILITIES.filter((c) => c.group === 'main').map((c) => row(c.key))}
      {s.goal && (
        <button type="button" data-mi data-id={PLUS_ID.goal} role="menuitem" className="cm-it" title={tr('在输入框写下目标并发送：Claude 会一轮接一轮做下去，直到完成或卡住（等同于 /goal）')} onClick={() => { p.close(false); p.onGoal(); }}>
          <span className="cm-ic"><Icon name="goals" size={15} /></span>
          <span className="cm-tx"><span className="cm-l">{tr('设定一个目标')}</span><span className="cm-d">{tr('一轮接一轮做下去，直到完成或卡住')}</span></span>
          <span className="cm-r"><Icon name="chevronRight" size={12} /></span>
        </button>
      )}
      {s.capabilities && (
        <>
          <div className="menu-sep" />
          <div className="cm-h">{tr('进阶')}</div>
          {/* Brief and 频道 are rows of their own (final review M3: 功能 → Brief was 2 clicks, so is + → Brief) */}
          {CAPABILITIES.filter((c) => c.group === 'advanced').map((c) => row(c.key))}
          <ChannelsField features={p.features} readOnly={s.readOnly} onFeatures={p.onFeatures} />
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
        <input className="field" data-mi placeholder={readOnly ? '' : CHANNELS.placeholder} value={text} readOnly={readOnly} aria-label={tr('频道')}
          onChange={(e) => {
            if (readOnly) return;
            setText(e.target.value);
            pending.current = e.target.value;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(flush, 300);
          }}
          onBlur={flush}
          onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) { e.preventDefault(); flush(); } }} />
      </label>
    </div>
  );
}

const CONN_STATE: Record<string, () => string> = {
  connected: () => tr('已连接'), failed: () => tr('连接失败'), 'needs-auth': () => tr('要登录'), pending: () => tr('连接中'), disabled: () => tr('已关'),
};

/** 连接器 ›: this conversation's MCP servers, each on / off for it (the CLI's own toggle: it lasts while the process does). */
function ConnectorList({ sessionId, onBack, onManage }: { sessionId: string; onBack: () => void; onManage: () => void }) {
  const servers = useStore((s) => s.open[sessionId]?.info?.mcpServers);
  const live = useStore((s) => !!s.open[sessionId]?.info && s.open[sessionId]?.state !== 'closed');
  const [busy, setBusy] = useState<string | null>(null);
  const flip = (name: string, enabled: boolean) => {
    setBusy(name);
    ws.request({ kind: 'session.toggleMcp', sessionId, name, enabled })
      .catch((e) => useStore.getState().toast(tr('{name} 没切换：{e}', { name, e: e.message })))
      .finally(() => setBusy(null));
  };
  return (
    <div className="cm-ref cm-conn">
      <div className="cm-ref-head">
        <button type="button" data-mi className="icon-btn xs" aria-label={tr('返回')} onClick={onBack}><Icon name="chevronRight" size={12} className="flip" /></button>
        <span className="cm-l">{tr('连接器')}</span>
      </div>
      <div className="cm-ref-list">
        {(servers ?? []).map((m) => {
          const on = m.status !== 'disabled';
          return (
            <button key={m.name} type="button" data-mi data-conn={m.name} role="menuitemcheckbox" aria-checked={on} className={clsx('cm-it', on && 'on')} disabled={!live || busy === m.name} title={m.error ?? m.name} onClick={() => flip(m.name, !on)}>
              <span className="cm-ic"><Icon name="mcp" size={14} /></span>
              <span className="cm-tx"><span className="cm-l">{m.name}</span><span className="cm-d">{CONN_STATE[m.status]?.() ?? m.status}</span></span>
              {busy === m.name ? <span className="spinner" /> : <span className={clsx('toggle sm', on && 'on')} aria-hidden />}
            </button>
          );
        })}
        {!servers?.length && <div className="menu-note">{live ? tr('这个对话没有连接器') : tr('对话在运行时才能开关连接器')}</div>}
      </div>
      <div className="menu-sep" />
      <button type="button" data-mi className="cm-it one" onClick={onManage}>
        <span className="cm-ic"><Icon name="settings" size={14} /></span>
        <span className="cm-tx"><span className="cm-l">{tr('管理连接器…')}</span></span>
      </button>
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
        <button type="button" data-mi className="icon-btn xs" aria-label={tr('返回')} onClick={onBack}><Icon name="chevronRight" size={12} className="flip" /></button>
        <input className="field" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索对话…')} aria-label={tr('搜索对话')}
          onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && list[0]) { e.preventDefault(); onPick({ id: list[0].sessionId, title: list[0].title }); } }} />
      </div>
      <div className="cm-ref-list">
        {list.map((s) => (
          <button key={s.sessionId} type="button" data-mi className="cm-it one" onClick={() => onPick({ id: s.sessionId, title: s.title })} title={s.cwd}>
            <span className="cm-ic"><Icon name="chat" size={14} /></span>
            <span className="cm-tx"><span className="cm-l">{s.title}</span></span>
            <span className="cm-r">{s.cwd.split(/[\\/]/).pop()} · {ago(s.lastModified)}</span>
          </button>
        ))}
        {!list.length && <div className="menu-note">{q ? tr('没有匹配「{q}」的对话', { q }) : tr('还没有别的对话')}</div>}
      </div>
    </div>
  );
}
