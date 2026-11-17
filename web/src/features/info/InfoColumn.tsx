// 信息栏 (spec 2026-10-16 recording-ux §1; the official app's right column): the conversation's environment, context,
// connectors, changes and background tasks as cards beside it. Each folds; their order is dragged (or Alt+↑/↓ on a
// title); both are kept in meta.json `ui.infoCards`.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteStatus } from '@shared';
import { settledVersion, useSettledSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { tr } from '@/i18n';
import { cachedDiffStat } from '@/model/diffstat';
import { sessionPeer } from '@/features/peers';
import { useBackground, stopTask } from '@/features/background/state';
import { usePrs } from '@/features/vcs/PrBar';
import { openReview } from '@/features/workbench/right-panel';
import { useRepoContext } from '@/features/workbench/repo-context';
import { openExtensions } from '@/features/extensions/state';
import { useContextUsage } from '@/features/composer/ContextMeter';
import { envFolders } from '@/features/composer/extra-dirs';
import { removeOwnDir } from '@/features/composer/extra-dirs-actions';
import { projectRoots } from '@/features/paths';
import './info.css';
import { connectorSummary, contextBreakdown, contextTitle, ctxCanRefresh, ctxLive, fmtTokens, moveCard, normInfoLayout, nudgeCard, toggleCard, type CtxBreakdown, type InfoCard, type InfoLayout } from './info-model';

const SETTING = 'ui.infoCards';

function useLayout(): [InfoLayout, (l: InfoLayout) => void] {
  const raw = useStore((s) => s.settings[SETTING]);
  const layout = useMemo(() => normInfoLayout(raw), [raw]);
  return [layout, (l) => void useStore.getState().setSetting(SETTING, l)];
}

export function InfoColumn({ sessionId }: { sessionId: string }) {
  const [layout, setLayout] = useLayout();
  const [drag, setDrag] = useState<InfoCard | null>(null);
  const titles: Record<InfoCard, string> = { env: tr('环境'), context: tr('上下文'), connectors: tr('连接器'), changes: tr('改动'), background: tr('后台任务'), pins: tr('钉住的回复') };
  // 钉住 is there once a reply is pinned
  const pins = useStore((s) => s.sessionMeta[sessionId]?.pinnedMsgs?.length ?? 0);
  return (
    <aside className="info-col" aria-label={tr('对话信息')}>
      {layout.order.filter((card) => card !== 'pins' || pins > 0).map((card) => (
        <section
          key={card}
          className={clsx('info-card', layout.collapsed.includes(card) && 'folded', drag === card && 'dragging')}
          data-card={card}
          onDragOver={(e) => { if (drag && drag !== card) e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); if (drag) setLayout(moveCard(layout, drag, card)); setDrag(null); }}
        >
          <div className="ic-head">
            <button
              className="ic-title"
              aria-expanded={!layout.collapsed.includes(card)}
              onClick={() => setLayout(toggleCard(layout, card))}
              onKeyDown={(e) => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); setLayout(nudgeCard(layout, card, e.key === 'ArrowUp' ? -1 : 1)); } }}
              title={tr('点击折叠 / 展开；Alt+↑↓ 调整顺序')}
            >
              {titles[card]}<Icon name={layout.collapsed.includes(card) ? 'chevronRight' : 'chevronDown'} size={12} />
            </button>
            <span className="ic-sum">{layout.collapsed.includes(card) && <CardSummary card={card} sessionId={sessionId} />}</span>
            <span className="ic-grip" draggable onDragStart={(e) => { setDrag(card); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card); }} onDragEnd={() => setDrag(null)} title={tr('拖动调整顺序')} aria-hidden><Icon name="grip" size={12} /></span>
          </div>
          {card === 'context' && <ContextWindowLine sessionId={sessionId} />}
          {!layout.collapsed.includes(card) && <div className="ic-body"><CardBody card={card} sessionId={sessionId} /></div>}
        </section>
      ))}
    </aside>
  );
}

// ---------- the value on a card's title row (what a folded card still says) ----------

/**
 * The context card's window and compaction point (A7), folded or not: a line of its own under the title row — on that
 * row next to the percentage it squeezed 「上下文」 to one character per line, and the English text pushed the meter out
 * of the 288px column (ui-smoke `a7`, 2026-10-24).
 */
function ContextWindowLine({ sessionId }: { sessionId: string }) {
  const w = useStore((s) => s.open[sessionId]?.info?.contextWindow);
  const c = useStore((s) => s.open[sessionId]?.info?.compactWindow);
  const title = contextTitle(w, c);
  return title ? <div className="ic-window" title={title}>{title}</div> : null;
}

function CardSummary({ card, sessionId }: { card: InfoCard; sessionId: string }) {
  const o = useSettledSession(sessionId);
  const cu = useContextUsage(sessionId);
  // only the 改动 card shows it; shared and worked out once per settled version (cachedDiffStat)
  const stat = o && card === 'changes' ? cachedDiffStat(o.conv, settledVersion(o)) : null;
  const conns = connectorSummary(o?.info?.mcpServers as any);
  const bg = useBackground((s) => s.sessions[sessionId]);
  const running = bg?.tasks.filter((t) => t.status === 'running').length ?? 0;
  if (card === 'context') return cu ? <><span>{cu.percentage}%</span><span className="ic-meter"><i style={{ width: `${Math.min(100, cu.percentage)}%` }} /></span></> : null;
  if (card === 'connectors') return conns.broken ? <span className="warn">{tr('{n} 个要重连', { n: conns.broken })}</span> : conns.rows.length ? <span>{conns.rows.length}</span> : null;
  if (card === 'changes') return stat && stat.files ? <><span className="add">+{stat.added}</span> <span className="del">−{stat.removed}</span></> : null;
  if (card === 'background') return running ? <span>{running}</span> : null;
  if (card === 'pins') return <PinCount sessionId={sessionId} />;
  return null;
}

function CardBody({ card, sessionId }: { card: InfoCard; sessionId: string }) {
  if (card === 'env') return <EnvCard sessionId={sessionId} />;
  if (card === 'context') return <ContextCard sessionId={sessionId} />;
  if (card === 'connectors') return <ConnectorsCard sessionId={sessionId} />;
  if (card === 'changes') return <ChangesCard sessionId={sessionId} />;
  if (card === 'pins') return <PinsCard sessionId={sessionId} />;
  return <BackgroundCard sessionId={sessionId} />;
}

// ---------- 钉住 ----------

const NO_PINS: { id: string; text: string }[] = [];

function PinCount({ sessionId }: { sessionId: string }) {
  const n = useStore((s) => s.sessionMeta[sessionId]?.pinnedMsgs?.length ?? 0);
  return n ? <span>{n}</span> : null;
}

/** Pinned replies; a click scrolls the conversation to one (it lights up for a moment), × unpins. */
function PinsCard({ sessionId }: { sessionId: string }) {
  const pins = useStore((s) => s.sessionMeta[sessionId]?.pinnedMsgs ?? NO_PINS);
  const jump = (id: string, at: HTMLElement) => {
    const el = at.closest('.chat-tile')?.querySelector<HTMLElement>(`.msg.assistant[data-msg="${CSS.escape(id)}"]`);
    if (!el) { useStore.getState().toast(tr('这条回复在折起来的一轮里，或者已经不在这段对话里了')); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('msg-flash');
    setTimeout(() => el.classList.remove('msg-flash'), 1600);
  };
  const unpin = (id: string) => void useStore.getState().setSessionMeta(sessionId, { pinnedMsgs: pins.filter((p) => p.id !== id) });
  return (
    <>
      {pins.map((p) => (
        <div key={p.id} className="ic-row ic-pin">
          <button className="ic-row-btn" onClick={(e) => jump(p.id, e.currentTarget)} title={tr('跳到这条回复')}><Icon name="pin" size={13} /><span className="ic-row-t">{p.text || tr('（没有文字的回复）')}</span></button>
          <button className="icon-btn xs" onClick={() => unpin(p.id)} title={tr('取消钉住')} aria-label={tr('取消钉住')}><Icon name="close" size={11} /></button>
        </div>
      ))}
    </>
  );
}

const Row = ({ icon, children, title, end }: { icon: IconName; children: React.ReactNode; title?: string; end?: React.ReactNode }) => (
  <div className="ic-row" title={title}><Icon name={icon} size={13} /><span className="ic-row-t">{children}</span>{end}</div>
);

// ---------- 环境 ----------

function EnvCard({ sessionId }: { sessionId: string }) {
  const o = useSettledSession(sessionId);
  const sessions = useStore((s) => s.sessions);
  const meta = sessions.find((x) => x.sessionId === sessionId);
  const peer = sessionPeer(sessionId, sessions);
  const cwd = o?.cwd || meta?.cwd || '';
  const { git, worktree } = useRepoContext(peer ? '' : cwd, sessionId);
  const branch = git?.branch ?? meta?.gitBranch;
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  useEffect(() => { if (!peer) ws.request<RemoteStatus>({ kind: 'remote.status' }).then(setRemote).catch(() => setRemote(null)); }, [peer]);
  const toggleRemote = async () => {
    if (!remote) return;
    try { setRemote(await ws.request<RemoteStatus>({ kind: 'remote.set', enabled: !remote.enabled })); } catch (e: any) { useStore.getState().toast(String(e?.message ?? e)); }
  };
  return (
    <>
      <Row icon="machine">{peer ? peer.name : tr('本机')}</Row>
      {cwd && <Row icon="folder" title={cwd}>{basename(cwd)}{worktree ? <span className="ic-dim"> · {tr('独立副本')}</span> : null}</Row>}
      {cwd && !peer && <EnvFolders sessionId={sessionId} cwd={cwd} />}
      {branch && <Row icon="branch" title={branch}>{branch}</Row>}
      {remote && (
        <Row icon="device" title={tr('让配对过的手机连上这台电脑，在手机上看和继续对话')} end={<button className={clsx('toggle sm', remote.enabled && 'on')} role="switch" aria-checked={remote.enabled} aria-label={tr('手机远程')} onClick={() => void toggleRemote()} />}>
          {tr('手机远程')}
        </Row>
      )}
    </>
  );
}

const NO_DIRS: readonly string[] = [];

/**
 * The folders it works in besides its own (spec: 添加文件夹, 2026-11-17): the project's extra folders — changed in the
 * project's settings, so no × here — then the ones added to this conversation (+ → 添加文件夹), each removable. A
 * change reaches a running conversation once it is idle (it restarts and resumes). Not for another machine's
 * conversation: neither list here is that machine's.
 */
function EnvFolders({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const workspaces = useStore((s) => s.workspaces);
  const own = useStore((s) => s.sessionMeta[sessionId]?.extraDirs) ?? NO_DIRS;
  const rows = useMemo(() => envFolders(cwd, projectRoots(cwd, workspaces).slice(1), own), [cwd, workspaces, own]);
  return (
    <>
      {rows.map((r) => (
        <Row key={r.path} icon="folder" title={r.from === 'project' ? tr('{path}\n项目的文件夹，在项目设置里改', { path: r.path }) : tr('{path}\n添加到这个对话的文件夹', { path: r.path })}
          end={r.from === 'conversation' ? <button className="icon-btn xs" data-act="remove-dir" onClick={() => void removeOwnDir(sessionId, r.path)} title={tr('从这个对话的工作目录移除')} aria-label={tr('从工作目录移除 {name}', { name: basename(r.path) })}><Icon name="close" size={11} /></button> : undefined}>
          {basename(r.path)}<span className="ic-dim"> · {r.from === 'project' ? tr('项目') : tr('这个对话')}</span>
        </Row>
      ))}
    </>
  );
}

// ---------- 上下文 ----------

/** The last breakdown per conversation for this run of the app: the card shows it at once, then counts again.
 *  Memory only (not meta.json, not localStorage): a count is stale by the next launch anyway. */
const ctxCache = new Map<string, { b: CtxBreakdown; at: number }>();

function ContextCard({ sessionId }: { sessionId: string }) {
  const state = useStore((s) => s.open[sessionId]?.state);
  const live = ctxLive(state);
  const [data, setData] = useState(() => ctxCache.get(sessionId) ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  // the conversation the card shows now: an answer for one it has left is cached, not shown
  const shown = useRef(sessionId);
  shown.current = sessionId;
  const load = () => {
    const sid = sessionId;
    setBusy(true);
    ws.request({ kind: 'session.contextUsage', sessionId: sid, detail: 'full' })
      .then((u: any) => {
        const b = contextBreakdown(u);
        if (b) ctxCache.set(sid, { b, at: Date.now() });
        if (shown.current !== sid) return;
        if (b) { setData(ctxCache.get(sid)!); setErr(false); } else setErr(true);
      })
      .catch(() => { if (shown.current === sid) setErr(true); })
      .finally(() => { if (shown.current === sid) setBusy(false); });
  };
  // on opening and on 刷新 only — never when a turn ends (2026-10-23, 「上下文小环不问引擎」): the engine counts it with
  // the model's API, ~15–30 requests (useContextUsage). The card only lives while unfolded (InfoColumn unmounts a folded body).
  useEffect(() => { setData(ctxCache.get(sessionId) ?? null); setErr(false); setBusy(false); if (live) load(); }, [sessionId, live]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  if (!data) return <div className="ic-dim">{!live ? tr('对话开着时才有明细') : err ? tr('这个对话的 agent 不提供明细') : tr('加载中…')}</div>;
  const { b } = data;
  const mins = Math.floor((Date.now() - data.at) / 60_000);
  return (
    <div className="ctx">
      <div className="ctx-top"><span>{tr('已用 {p}%', { p: b.percentage })}</span><span className="ic-dim">{fmtTokens(b.total)} / {fmtTokens(b.max)}</span></div>
      <div className="ctx-bar">{b.used.map((c) => <i key={c.name} className={`ctx-t-${c.tone}`} style={{ width: `${c.pct}%` }} />)}{b.buffer.map((c) => <i key={c.name} className="sw-buf" style={{ width: `${c.pct}%` }} />)}</div>
      {b.used.map((c) => (
        <div key={c.name} className="ctx-row"><i className={`ctx-t-${c.tone}`} /><span className="n">{c.name}</span><span className="t">{fmtTokens(c.tokens)}</span><span className="p">{c.pct.toFixed(1)}%</span></div>
      ))}
      {[...b.buffer, ...b.free].map((c) => (
        <div key={c.name} className="ctx-row"><i className={c.kind === 'buffer' ? 'sw-buf' : 'sw-free'} /><span className="n">{c.name}</span><span className="t">{fmtTokens(c.tokens)}</span><span className="p">{c.pct.toFixed(1)}%</span></div>
      ))}
      {b.deferred.map((c) => <div key={c.name} className="ctx-row dim"><i className="sw-free" /><span className="n">{c.name}</span><span className="t">{fmtTokens(c.tokens)}</span><span className="p">—</span></div>)}
      <CtxList title={tr('MCP 工具')} rows={b.mcpTools.map((t) => [t.name.replace(/^mcp__/, ''), t.tokens])} />
      <CtxList title={tr('记忆文件')} rows={b.memoryFiles.map((m) => [basename(m.path), m.tokens])} />
      <CtxList title={tr('自定义子代理')} rows={b.agents.map((a) => [a.name, a.tokens])} />
      <div className="ic-dim ctx-foot">{busy ? tr('更新中…') : mins < 1 ? tr('刚刚更新') : tr('{n} 分钟前更新', { n: mins })} {ctxCanRefresh(state, busy) && <button className="link" data-act="ctx-refresh" onClick={load}>{tr('刷新')}</button>}</div>
    </div>
  );
}

function CtxList({ title, rows }: { title: string; rows: [string, number][] }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <div className="ctx-list">
      <button className="ctx-list-h" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> {title}<span className="ic-dim">{rows.length}</span></button>
      {open && rows.map(([n, t]) => <div key={n} className="ctx-row sub"><span className="n" title={n}>{n}</span><span className="t">{fmtTokens(t)}</span></div>)}
    </div>
  );
}

// ---------- 连接器 ----------

const STATUS: Record<string, () => string> = { connected: () => tr('已连接'), failed: () => tr('连不上'), 'needs-auth': () => tr('要登录'), pending: () => tr('连接中'), disabled: () => tr('已关') };

function ConnectorsCard({ sessionId }: { sessionId: string }) {
  const servers = useStore((s) => s.open[sessionId]?.info?.mcpServers) as { name: string; status?: string }[] | undefined;
  const { rows } = connectorSummary(servers);
  return (
    <>
      {!rows.length && <div className="ic-dim">{tr('这个对话没有连接器')}</div>}
      {rows.map((r) => (
        <div key={r.name} className="ic-row"><Icon name="mcp" size={13} /><span className="ic-row-t">{r.name}</span><span className={clsx('ic-st', (r.status === 'failed' || r.status === 'needs-auth') && 'warn')}>{(STATUS[r.status] ?? (() => r.status))()}</span></div>
      ))}
      <button className="ic-link" onClick={() => openExtensions('connectors')}>{tr('管理连接器')}</button>
    </>
  );
}

// ---------- 改动 ----------

function ChangesCard({ sessionId }: { sessionId: string }) {
  const o = useSettledSession(sessionId);
  const stat = o ? cachedDiffStat(o.conv, settledVersion(o)) : null;
  const pr = usePrs((s) => s.bySession[sessionId] ?? null);
  const idle = o?.state === 'idle';
  const askPr = () => {
    const st = useStore.getState();
    st.send(sessionId, tr('把这个对话里的改动提交到一个新分支，推送并用 gh 开一个 PR（标题和说明根据改动写），最后告诉我 PR 的链接。')).catch((e) => st.toast(String(e?.message ?? e)));
  };
  return (
    <>
      {stat && stat.files ? (
        <div className="ic-row">
          <button className="ic-row-btn" onClick={() => openReview({ scope: 'session' })} title={tr('审阅这些改动')}>
            <Icon name="diff" size={13} /><span className="ic-row-t"><span className="add">+{stat.added}</span> <span className="del">−{stat.removed}</span> <span className="ic-dim">· {tr('{n} 个文件', { n: stat.files })}</span></span>
          </button>
          {pr ? <a className="btn sm" href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}</a>
            : <button className="btn sm" disabled={!idle} title={idle ? tr('让 Claude 提交这些改动并开一个 PR') : tr('等这一轮结束')} onClick={askPr}>{tr('建 PR')}</button>}
        </div>
      ) : <div className="ic-dim">{tr('这个对话还没有改文件')}</div>}
    </>
  );
}

// ---------- 后台任务 ----------

function BackgroundCard({ sessionId }: { sessionId: string }) {
  const bg = useBackground((s) => s.sessions[sessionId]);
  const [, tick] = useState(0);
  const running = bg?.tasks.filter((t) => t.status === 'running') ?? [];
  useEffect(() => { if (!running.length) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running.length]);
  if (!running.length) return <div className="ic-dim">{tr('没有在跑的后台任务')}</div>;
  return (
    <>
      {running.map((t) => (
        <div key={t.id} className="ic-row" title={t.description}>
          <Icon name={t.kind === 'shell' ? 'terminal' : 'agent'} size={13} />
          <span className="ic-row-t mono">{t.name || t.description}</span>
          <span className="ic-dim">{fmtElapsed(Date.now() - t.startedAt)}</span>
          <button className="icon-btn xs" aria-label={tr('停止')} title={tr('停止')} onClick={() => stopTask(sessionId, t.id)}><Icon name="stop" size={11} /></button>
        </div>
      ))}
    </>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
