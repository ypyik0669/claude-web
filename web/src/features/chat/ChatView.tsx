import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantItem, Attachment, Block, Item, ToolUseBlock, UserItem } from '@/model/conversation';
import { ERROR_HINT, ERROR_LABEL } from '@/model/health';
import { fmtSize } from '@/model/attachments';
import { useScopedSession, useScopedSessionId, useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { activeGroup } from '@/model/layout';
import { clsx, fmtMs, fmtTok, fmtUsd } from '@/util';
import { AssistantActions, UserActions, UserEditor } from './MessageActions';
import { FindBar } from './FindBar';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { PermissionCards } from './PermissionCards';
import { getToolDef, isStandalone } from './tools/registry';
import { Icon } from '@/ui/icons';
import { ToolHead } from './ToolCard';

/** Human summary for a run of consecutive tool calls, Claude-Code-on-web style: "读取 2 个文件 · 运行 1 条命令". */
function stepLabel(tools: ToolUseBlock[]): string {
  if (tools.length === 1) {
    const def = getToolDef(tools[0].name);
    if (def.category === 'other' || def.category === 'mcp') {
      const { verb, arg } = def.label(tools[0].input as any);
      return `${verb || tools[0].name.replace(/^mcp__/, '')} ${arg}`.trim().slice(0, 80);
    }
  }
  const c: Record<string, number> = {};
  for (const t of tools) {
    const k = getToolDef(t.name).category;
    c[k] = (c[k] ?? 0) + 1;
  }
  const parts: string[] = [];
  if (c.read) parts.push(`读取 ${c.read} 个文件`);
  if (c.edit) parts.push(`编辑 ${c.edit} 个文件`);
  if (c.cmd) parts.push(`运行 ${c.cmd} 条命令`);
  if (c.web) parts.push(`搜索网页 ${c.web} 次`);
  if (c.skill) parts.push(`调用 ${c.skill} 个 skill`);
  if (c.mcp) parts.push(`MCP ${c.mcp} 次`);
  const other = (c.other ?? 0) + (c.plan ?? 0) + (c.agent ?? 0);
  if (other) parts.push(`${other} 步`);
  return parts.join(' · ');
}

type Seg = { kind: 'text'; b: Block; i: number } | { kind: 'thinking'; b: Block; i: number } | { kind: 'agent'; t: ToolUseBlock } | { kind: 'steps'; tools: ToolUseBlock[] };

function segment(blocks: Block[]): Seg[] {
  const out: Seg[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'text') { if (b.text.trim() || i === blocks.length - 1) out.push({ kind: 'text', b, i }); }
    else if (b.type === 'thinking') { if (b.thinking || i === blocks.length - 1) out.push({ kind: 'thinking', b, i }); }
    else if (isStandalone(b.name)) out.push({ kind: 'agent', t: b });
    else {
      const last = out[out.length - 1];
      if (last?.kind === 'steps') last.tools.push(b);
      else out.push({ kind: 'steps', tools: [b] });
    }
  });
  return out;
}

/**
 * One run of tool calls as a vertical timeline. Three states, three distinct marks —
 * done = hollow check, running = breathing square + elapsed, pending = grey ring — so the
 * collapsed form already tells you where the turn got to. Clicking a node expands that step's card.
 */
function Steps({ tools, version, live }: { tools: ToolUseBlock[]; version: number; live: boolean }) {
  const running = tools.some((t) => t.status === 'running' || t.status === 'pending' || t.status === 'streaming');
  const failed = tools.some((t) => t.status === 'error');
  const [openId, setOpenId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  return (
    <div className={clsx('trail', running && 'running')}>
      {tools.map((t, i) => {
        const open = all || openId === t.id;
        return (
          <div key={t.id} className={clsx('tl', stepState(t), open && 'open')}>
            {i < tools.length - 1 && <span className="edge" />}
            <StepMark t={t} />
            <div className="tl-main">
              <ToolHead t={t} open={open} onToggle={() => { setAll(false); setOpenId(open ? null : t.id); }} />
              {open && <ToolCard t={t} version={version} bare />}
              {!open && t.children.length > 0 && <button className="tl-sub" onClick={() => setOpenId(t.id)}>子代理 {t.children.length} 条消息</button>}
            </div>
          </div>
        );
      })}
      <div className="tl-foot">
        <span className="lbl">{stepLabel(tools)}</span>
        {failed && <span className="badge err">失败</span>}
        {tools.length > 1 && <button className="tl-all" onClick={() => { setAll(!all); setOpenId(null); }}>{all ? '全部收起' : '全部展开'}</button>}
      </div>
    </div>
  );
}

function stepState(t: ToolUseBlock) {
  if (t.status === 'error') return 'failed';
  if (t.status === 'running' || t.status === 'streaming') return 'active';
  if (t.status === 'pending') return 'pending';
  return 'done';
}

/** The one visual that must never be ambiguous: which step is finished, which is live, which is queued. */
function StepMark({ t }: { t: ToolUseBlock }) {
  const st = stepState(t);
  return (
    <span className={clsx('mark', st)} aria-hidden>
      {st === 'done' && <Icon name="checkCircle" size={16} />}
      {st === 'failed' && <Icon name="close" size={13} />}
      {st === 'active' && <span className="pip" />}
      {st === 'pending' && <Icon name="circle" size={13} />}
    </span>
  );
}

/** Thinking rows honour settings['ui.showThinking']: 'collapsed' (default) | 'expanded' | 'hidden'. */
function Thinking({ text, streaming, redacted }: { text: string; streaming: boolean; redacted?: boolean }) {
  const mode = useStore((s) => (s.settings['ui.showThinking'] as string | undefined) ?? 'collapsed');
  const [open, setOpen] = useState<boolean | null>(null);
  if (mode === 'hidden' && !streaming) return null;
  if (!text && !streaming && !redacted) return null;
  const show = open ?? (mode === 'expanded');
  return (
    <div className={clsx('trail thinking', streaming && 'running')}>
      <div className={clsx('tl', streaming ? 'active' : 'done', show && 'open')}>
        <span className={clsx('mark', streaming ? 'active' : 'done')} aria-hidden>
          {streaming ? <span className="pip" /> : <Icon name="checkCircle" size={16} />}
        </span>
        <div className="tl-main">
          <div className="tl-head" onClick={() => setOpen(!show)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(!show); }}>
            <span className={clsx('lbl', streaming && 'shimmer')}>{redacted ? '思考内容已隐藏（redacted）' : streaming ? '思考中' : text.length > 1200 ? '深入思考了一会儿' : '思考了一下'}</span>
            {!streaming && text && <span className="tool-meta">{text.length > 1000 ? `${(text.length / 1000).toFixed(1)}K 字` : `${text.length} 字`}</span>}
            <Icon name={show ? 'chevronDown' : 'chevronRight'} size={13} className="chev" />
          </div>
          {show && !redacted && <div className="thinking-body"><Markdown text={text} streaming={streaming} /></div>}
        </div>
      </div>
    </div>
  );
}

const Assistant = memo(function Assistant({ it, version, live }: { it: AssistantItem; version: number; live: boolean }) {
  const segs = useMemo(() => segment(it.blocks), [it.blocks, version]);
  return (
    <div className="msg assistant">
      {segs.map((s, idx) => {
        if (s.kind === 'text') return <div key={idx} className={clsx(it.streaming && idx === segs.length - 1 && 'cursor')}><Markdown text={(s.b as any).text} streaming={it.streaming && idx === segs.length - 1} /></div>;
        if (s.kind === 'thinking') return <Thinking key={idx} text={(s.b as any).thinking} redacted={(s.b as any).redacted} streaming={it.streaming && idx === segs.length - 1} />;
        if (s.kind === 'agent') return <ToolCard key={s.t.id} t={s.t} version={version} />;
        // keyed by its first tool, not its position: a leading empty text/thinking segment drops out once more
        // blocks arrive, which would shift indices and remount the trail (losing which step was expanded)
        return <Steps key={`steps-${s.tools[0].id}`} tools={s.tools} version={version} live={live} />;
      })}
      {it.error && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{it.error}</div>}
    </div>
  );
});

/** Merge runs of assistant items that carry only tool calls (the CLI emits one API message per tool call) so steps collapse into one row. */
function coalesce(items: Item[]): Item[] {
  const out: Item[] = [];
  const toolsOnly = (it: AssistantItem) => it.blocks.length > 0 && it.blocks.every((b) => b.type === 'tool_use' || (b.type === 'thinking' && !b.thinking));
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.kind === 'assistant' && prev?.kind === 'assistant' && toolsOnly(it) && (toolsOnly(prev) || prev.blocks[prev.blocks.length - 1]?.type === 'tool_use') && !prev.streaming && !prev.error) {
      out[out.length - 1] = { ...prev, blocks: [...prev.blocks, ...it.blocks], streaming: it.streaming, usage: it.usage ?? prev.usage };
      continue;
    }
    out.push(it);
  }
  return out;
}

function AttachmentChips({ atts }: { atts: NonNullable<UserItem['attachments']> }) {
  const sid = useScopedSessionId();
  return (
    <div className="att-chips">
      {atts.map((a, i) => a.kind === 'session' ? <SessionRefChip key={i} a={a} /> : (
        <span key={i} className="att-chip" title={a.path ?? a.name} onClick={() => { if (a.path && a.kind !== 'folder' && sid) useStore.setState({ inspect: { sessionId: sid, file: { path: a.path } } }); }}>
          <span className="ic"><Icon name={a.kind === 'image' ? 'image' : a.kind === 'folder' ? 'folder' : a.kind === 'text' ? 'read' : 'attach'} size={12} /></span>
          {a.name}{a.size ? <span className="sz"> {fmtSize(a.size)}</span> : null}
        </span>
      ))}
    </div>
  );
}

/** A referenced session. Red when it is gone from the library (deleted, or its source left) or failed to expand. */
export function SessionRefChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  const exists = useStore((s) => !!a.sessionId && s.sessions.some((x) => x.sessionId === a.sessionId));
  const bad = !exists || !!a.error;
  const title = !exists ? '会话已不存在' : a.error ? a.error : `引用的会话：${a.name}（点击打开）`;
  const open = () => {
    if (!exists || !a.sessionId) return;
    const st = useStore.getState();
    st.open[a.sessionId] ? st.openInPane(a.sessionId, 'tab') : void st.loadHistory(a.sessionId, { mode: 'tab' });
  };
  return (
    <span className={clsx('att-chip ref', bad && 'bad')} title={title} onClick={open} role={exists ? 'button' : undefined}>
      <span className="ic"><Icon name="quote" size={12} /></span>
      {a.name}
      {onRemove && <button aria-label="移除引用" onClick={(e) => { e.stopPropagation(); onRemove(); }}><Icon name="close" size={10} /></button>}
    </span>
  );
}

function UserRow({ it, version }: { it: UserItem; version: number }) {
  const sessionId = useScopedSessionId();
  const [editing, setEditing] = useState(false);
  const open = useStore((s) => (sessionId ? s.open[sessionId] : undefined));
  const images = it.images.filter(Boolean);
  void version;
  return (
    <div className={clsx('msg user', it.meta && 'meta')} data-item-id={it.id}>
      {!it.meta && sessionId && !editing && <UserActions it={it} sessionId={sessionId} onEdit={() => setEditing(true)} />}
      {editing && sessionId ? (
        <UserEditor it={it} sessionId={sessionId} onDone={() => setEditing(false)} />
      ) : (
        <div className="bubble">
          {it.text}
          {images.length > 0 && <div className="img-grid">{images.map((src, i) => <img key={i} src={src} alt="" onClick={() => open && useStore.getState().openViewer(images, i)} />)}</div>}
          {it.attachments?.length ? <AttachmentChips atts={it.attachments} /> : null}
        </div>
      )}
    </div>
  );
}

export function ItemList({ items, version, live = false }: { items: Item[]; version: number; live?: boolean }) {
  const merged = useMemo(() => coalesce(items), [items, version]);
  const sessionId = useScopedSessionId();
  return (
    <>
      {merged.map((it) => {
        switch (it.kind) {
          case 'user':
            return <UserRow key={it.id} it={it} version={version} />;
          case 'assistant':
            return (
              <div key={it.id} className="assistant-wrap" data-item-id={it.id}>
                <Assistant it={it} version={version} live={live} />
                {!it.streaming && it.blocks.some((b) => b.type === 'text' && b.text.trim()) && sessionId && <AssistantActions it={it} sessionId={sessionId} />}
              </div>
            );
          case 'result':
            return (
              <div key={it.id} className={clsx('result-line', it.isError && 'err')} data-item-id={it.id}>
                {it.isError && <span title={it.text}>{it.errorKind ? ERROR_LABEL[it.errorKind] : '错误'}: {(it.text ?? '').slice(0, 200)}</span>}
                <span>{fmtMs(it.durationMs)}</span>
                <span>{it.numTurns} 步</span>
                <span>{fmtUsd(it.costUsd)}</span>
                {it.usage ? <span>↑{fmtTok((it.usage as any).input_tokens + (it.usage as any).cache_read_input_tokens)} ↓{fmtTok((it.usage as any).output_tokens)}</span> : null}
              </div>
            );
          case 'system':
            return (
              <div key={it.id} className={clsx('sysline', it.subtype === 'command' && 'cmd', it.level === 'warn' && 'warn', it.level === 'error' && 'err', it.subtype === 'compact' && 'compact')} data-item-id={it.id} title={it.data && typeof it.data === 'object' && (it.data as any).kind ? ERROR_HINT[(it.data as any).kind as keyof typeof ERROR_HINT] : undefined}>
                {it.subtype === 'compact' && <span className="ic"><Icon name="refresh" size={12} /></span>}
                {it.text}
              </div>
            );
        }
      })}
    </>
  );
}

export function ChatView() {
  const active = useScopedSession();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const version = active?.version ?? 0;
  const [find, setFind] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [older, setOlder] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const pane = usePaneCtx();

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey && !e.altKey)) return;
      // every pane (and every background tab in a pane) keeps its ChatView mounted: only the one the user is
      // looking at — the focused pane's active tile — may open its find bar
      if (pane) {
        const g = activeGroup(useStore.getState().layout);
        const p = g.panes[pane.paneId];
        if (g.focusedPaneId !== pane.paneId || !p || (p.activeTileId ?? p.tiles[0]?.id) !== pane.tileId) return;
      }
      e.preventDefault();
      setFind(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pane?.paneId, pane?.tileId]);

  if (!active) return null;
  const onScroll = () => {
    const el = ref.current!;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = b;
    if (b !== atBottom) setAtBottom(b);
  };
  const live = active.state === 'running' || active.state === 'waiting';
  const sid = active.sessionId;
  /** prepend the next older page and keep the message the user was looking at in place */
  const loadOlder = async () => {
    const el = ref.current;
    const h0 = el?.scrollHeight ?? 0, t0 = el?.scrollTop ?? 0;
    stick.current = false;
    setOlder({ busy: true });
    try {
      await useStore.getState().loadOlder(sid);
      setOlder({ busy: false });
      requestAnimationFrame(() => { if (el) el.scrollTop = t0 + (el.scrollHeight - h0); });
    } catch (e) {
      setOlder({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      <FindBar open={find} onClose={() => setFind(false)} root={() => ref.current} />
      {!atBottom && <button className="jump-bottom" title="回到底部" onClick={() => { const el = ref.current!; el.scrollTop = el.scrollHeight; stick.current = true; }} aria-label="回到底部"><Icon name="chevronDown" size={16} /></button>}
      <div className="chat-inner" data-session-id={active.sessionId}>
        {active.loading && <div className="sysline"><span className="spinner" /> 加载历史…</div>}
        {active.loadError && !active.loading && (
          <div className="load-err" role="alert">
            <Icon name="alert" size={14} />
            <span className="why">加载历史失败：{active.loadError}</span>
            <button className="btn sm" onClick={() => void useStore.getState().loadHistory(sid, { focus: false })}><Icon name="refresh" size={12} /> 重试</button>
          </div>
        )}
        {active.historyCursor && !active.loading && (
          <div className="older-row">
            {older.error ? (
              <span className="load-err inline" role="alert"><span className="why">加载更早的记录失败：{older.error}</span><button className="btn sm" onClick={loadOlder}><Icon name="refresh" size={12} /> 重试</button></span>
            ) : (
              <button className="btn sm ghost" disabled={older.busy} onClick={loadOlder}>{older.busy ? <span className="spinner" /> : <Icon name="chevronDown" size={12} className="flip" />} 加载更早的记录</button>
            )}
          </div>
        )}
        <ItemList items={active.conv.items} version={version} live={live} />
        {active.error && <div className="sysline" style={{ color: 'var(--red)' }}>{active.error}</div>}
        <PermissionCards />
        {active.state === 'running' && !active.conv.streaming.size && (
          <div className="working">
            <span className="spinner" /> 处理中
          </div>
        )}
        {active.state === 'starting' && (
          <div className="working">
            <span className="spinner" /> 正在启动 Claude Code…
          </div>
        )}
      </div>
    </div>
  );
}
