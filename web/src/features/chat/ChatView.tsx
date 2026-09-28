import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PermissionRequestEvent } from '@shared';
import type { AssistantItem, Attachment, Block, Item, ResultItem, ThinkingBlock, ToolUseBlock, UserItem } from '@/model/conversation';
import { ERROR_HINT, ERROR_LABEL } from '@/model/health';
import { fmtSize } from '@/model/attachments';
import { fileChanges, type FileChange } from '@/model/diffstat';
import { displayPath, fmtDuration, groupTurns, splitTurnBody, turnSummary, turnSummaryText, type Turn } from '@/model/turn';
import { useScopedSession, useScopedSessionId, useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { activeGroup } from '@/model/layout';
import { clsx, fmtMs, fmtTok } from '@/util';
import { fmtCost } from '@/model/cost';
import { AssistantActions, UserActions, UserEditor } from './MessageActions';
import { FindBar } from './FindBar';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { getToolDef, isStandalone } from './tools/registry';
import { Icon } from '@/ui/icons';
import { ToolHead } from './ToolCard';
import { blockRemoteOpen } from '@/features/remote-guard';
import { openChangedFile } from '@/features/workbench/right-panel';
import { waitingToolIds } from './permission-dock';
import { TurnTouchCtx, WaitingCtx } from './turn-context';

const EDIT_STEPS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const NO_PENDING: PermissionRequestEvent[] = [];
/** Change-card rows shown before 「还有 N 个文件」. */
const CARD_ROWS = 8;

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
 * One run of tool calls as a vertical timeline. Four states, four distinct marks — done = hollow check, running =
 * breathing square + elapsed, pending = grey ring, waiting on you = a yellow shield and 「等你确认」 — so the collapsed
 * form already tells you where the turn got to. Clicking a node expands that step's card; with
 * 「在对话里直接展开改动」 (`ui.inlineDiffs`) the finished edits start open.
 */
function Steps({ tools, version }: { tools: ToolUseBlock[]; version: number }) {
  const waiting = useContext(WaitingCtx);
  const touch = useContext(TurnTouchCtx);
  const inlineDiffs = useStore((s) => s.settings['ui.inlineDiffs'] === true);
  const running = tools.some((t) => t.status === 'running' || t.status === 'pending' || t.status === 'streaming');
  const failed = tools.some((t) => t.status === 'error');
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);
  const isOpen = (t: ToolUseBlock) => all || (opened[t.id] ?? (inlineDiffs && EDIT_STEPS.has(t.name) && t.status === 'done'));
  const toggle = (t: ToolUseBlock, open: boolean) => {
    setAll(false);
    setOpened((o) => ({ ...o, [t.id]: !open }));
    if (!open) touch?.();
  };
  return (
    <div className={clsx('trail', running && 'running')}>
      {tools.map((t, i) => {
        const open = isOpen(t);
        return (
          <div key={t.id} className={clsx('tl', stepState(t, waiting), open && 'open')}>
            {i < tools.length - 1 && <span className="edge" />}
            <StepMark t={t} />
            <div className="tl-main">
              <ToolHead t={t} open={open} onToggle={() => toggle(t, open)} />
              {open && <ToolCard t={t} version={version} bare />}
              {!open && t.children.length > 0 && <button className="tl-sub" onClick={() => toggle(t, false)}>子代理 {t.children.length} 条消息</button>}
            </div>
          </div>
        );
      })}
      <div className="tl-foot">
        <span className="lbl">{stepLabel(tools)}</span>
        {failed && <span className="badge err">失败</span>}
        {tools.length > 1 && <button className="tl-all" onClick={() => { setAll(!all); setOpened({}); if (!all) touch?.(); }}>{all ? '全部收起' : '全部展开'}</button>}
      </div>
    </div>
  );
}

function stepState(t: ToolUseBlock, waiting?: ReadonlySet<string>) {
  if (t.status === 'error') return 'failed';
  if (t.status !== 'done' && waiting?.has(t.id)) return 'waiting';
  if (t.status === 'running' || t.status === 'streaming') return 'active';
  if (t.status === 'pending') return 'pending';
  return 'done';
}

/** The one visual that must never be ambiguous: which step is finished, which is live, which is queued, which waits on you. */
function StepMark({ t }: { t: ToolUseBlock }) {
  const st = stepState(t, useContext(WaitingCtx));
  return (
    <span className={clsx('mark', st)} aria-hidden>
      {st === 'done' && <Icon name="checkCircle" size={16} />}
      {st === 'failed' && <Icon name="close" size={13} />}
      {st === 'active' && <span className="pip" />}
      {st === 'pending' && <Icon name="circle" size={13} />}
      {st === 'waiting' && <Icon name="shield" size={14} />}
    </span>
  );
}

/**
 * A thinking block, folded to 「思考了 12 秒 ›」 (spec §5.3). 显示思考过程 (`ui.showThinking`: true, or the older
 * 'expanded') opens them; 'hidden' drops the finished ones.
 */
function Thinking({ b, streaming }: { b: ThinkingBlock; streaming: boolean }) {
  const pref = useStore((s) => s.settings['ui.showThinking']);
  const mode = pref === true || pref === 'expanded' ? 'expanded' : pref === 'hidden' ? 'hidden' : 'collapsed';
  const touch = useContext(TurnTouchCtx);
  const [open, setOpen] = useState<boolean | null>(null);
  const text = b.thinking;
  if (mode === 'hidden' && !streaming) return null;
  if (!text && !streaming && !b.redacted) return null;
  const show = open ?? (mode === 'expanded');
  const toggle = () => { setOpen(!show); if (!show) touch?.(); };
  const label = b.redacted ? '思考内容已隐藏（redacted）' : streaming ? '思考中' : b.ms !== undefined ? `思考了 ${fmtDuration(b.ms)}` : text.length > 1200 ? '深入思考了一会儿' : '思考了一下';
  const size = text ? (text.length > 1000 ? `${(text.length / 1000).toFixed(1)}K 字` : `${text.length} 字`) : '';
  return (
    <div className={clsx('trail thinking', streaming && 'running')}>
      <div className={clsx('tl', streaming ? 'active' : 'done', show && 'open')}>
        <span className={clsx('mark', streaming ? 'active' : 'done')} aria-hidden>
          {streaming ? <span className="pip" /> : <Icon name="checkCircle" size={16} />}
        </span>
        <div className="tl-main">
          <div className="tl-head" onClick={toggle} role="button" tabIndex={0} aria-expanded={show} title={size ? `思考内容 ${size}` : undefined} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
            <span className={clsx('lbl', streaming && 'shimmer')}>{label}</span>
            {!b.redacted && <Icon name={show ? 'chevronDown' : 'chevronRight'} size={13} className="chev" />}
          </div>
          {show && !b.redacted && <div className="thinking-body"><Markdown text={text} streaming={streaming} /></div>}
        </div>
      </div>
    </div>
  );
}

const Assistant = memo(function Assistant({ it, version }: { it: AssistantItem; version: number }) {
  const segs = useMemo(() => segment(it.blocks), [it.blocks, version]);
  return (
    <div className="msg assistant">
      {segs.map((s, idx) => {
        if (s.kind === 'text') return <div key={idx} className={clsx(it.streaming && idx === segs.length - 1 && 'cursor')}><Markdown text={(s.b as any).text} streaming={it.streaming && idx === segs.length - 1} /></div>;
        if (s.kind === 'thinking') return <Thinking key={idx} b={s.b as ThinkingBlock} streaming={it.streaming && idx === segs.length - 1} />;
        if (s.kind === 'agent') return <ToolCard key={s.t.id} t={s.t} version={version} />;
        // keyed by its first tool, not its position: a leading empty text/thinking segment drops out once more
        // blocks arrive, which would shift indices and remount the trail (losing which step was expanded)
        return <Steps key={`steps-${s.tools[0].id}`} tools={s.tools} version={version} />;
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
        <span key={i} className="att-chip" title={a.path ?? a.name} onClick={() => { if (a.path && a.kind !== 'folder' && sid && !blockRemoteOpen(sid, a.path)) useStore.setState({ inspect: { sessionId: sid, file: { path: a.path } } }); }}>
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

/** A turn's stats line (duration · steps · cost · tokens): its own row after an unfolded turn, the tooltip of a folded one. */
function resultStats(r: ResultItem): string[] {
  const out = [fmtMs(r.durationMs), `${r.numTurns} 步`, fmtCost(r.costUsd, r.costUnknown)];
  if (r.usage) out.push(`↑${fmtTok((r.usage as any).input_tokens + (r.usage as any).cache_read_input_tokens)} ↓${fmtTok((r.usage as any).output_tokens)}`);
  return out;
}

/**
 * Items in their plain order — a subagent's messages, the detail panel, and the inside of a turn. `actions`: which
 * replies get the copy / rate / share row — every one (default), only the last (a turn that has not folded: its
 * answer), or none (the folded steps: the answer below the fold has them, and a hidden row under every step in
 * between would leave gaps).
 */
export function ItemList({ items, version, actions = 'all' }: { items: Item[]; version: number; live?: boolean; actions?: 'all' | 'last' | 'none' }) {
  const merged = useMemo(() => coalesce(items), [items, version]);
  const sessionId = useScopedSessionId();
  let lastReply = '';
  if (actions === 'last') for (const it of merged) if (it.kind === 'assistant' && it.blocks.some((b) => b.type === 'text' && b.text.trim())) lastReply = it.id;
  const withActions = (it: AssistantItem) => actions === 'all' || (actions === 'last' && it.id === lastReply);
  return (
    <>
      {merged.map((it) => {
        switch (it.kind) {
          case 'user':
            return <UserRow key={it.id} it={it} version={version} />;
          case 'assistant':
            return (
              <div key={it.id} className="assistant-wrap" data-item-id={it.id}>
                <Assistant it={it} version={version} />
                {!it.streaming && withActions(it) && it.blocks.some((b) => b.type === 'text' && b.text.trim()) && sessionId && <AssistantActions it={it} sessionId={sessionId} />}
              </div>
            );
          case 'result':
            return (
              <div key={it.id} className={clsx('result-line', it.isError && 'err')} data-item-id={it.id}>
                {it.isError && <span title={it.text}>{it.errorKind ? ERROR_LABEL[it.errorKind] : '错误'}: {(it.text ?? '').slice(0, 200)}</span>}
                {resultStats(it).map((x, i) => <span key={i} title={i === 2 && it.costUnknown ? '这个模型 / agent 没有可靠的价格（ccb 按 Claude 价表估的数不作数）' : undefined}>{x}</span>)}
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

/**
 * 「改动了 N 个文件 +a −b [审阅]」 at the end of a turn that edited files (spec §5.3), one row per file (its folder in
 * grey, then its name and lines). A row opens 审阅 on this conversation's changes at that file; see `openChangedFile`
 * for a phone and a conversation on another machine. Counted like the header's +N −M (`fileChanges`).
 */
function ChangesCard({ rows, sessionId, cwd }: { rows: FileChange[]; sessionId: string; cwd: string }) {
  const pane = usePaneCtx();
  const at = pane ? { paneId: pane.paneId, tileId: pane.tileId } : undefined;
  let added = 0, removed = 0;
  for (const r of rows) { added += r.added; removed += r.removed; }
  const open = (path?: string) => openChangedFile(sessionId, path, at);
  return (
    <div className="fcard" data-files={rows.length}>
      <div className="fcard-h">
        <Icon name="diff" size={14} />
        <span className="t">改动了 {rows.length} 个文件</span>
        <span className="n"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
        <button className="btn sm" onClick={() => open()} title="在右侧审阅这个对话改过的文件">审阅</button>
      </div>
      {rows.slice(0, CARD_ROWS).map((r) => {
        const p = displayPath(r.path, cwd);
        return (
          <button key={r.path} className="fcard-f" onClick={() => open(r.path)} title={`${r.path}\n点击审阅这个文件的改动`} data-path={r.path}>
            <span className="p"><span className="d">{p.dir}</span>{p.name}</span>
            <span className="n"><span className="add">+{r.added}</span> <span className="del">−{r.removed}</span></span>
          </button>
        );
      })}
      {rows.length > CARD_ROWS && <button className="fcard-f more" onClick={() => open()}>还有 {rows.length - CARD_ROWS} 个文件…</button>}
    </div>
  );
}

/** Whether a turn is folded, per conversation and turn — kept when the tile switches conversations and back. */
const foldMemory = new Map<string, boolean>();

/**
 * One turn (spec §5.3). While it runs, everything shows in order, as before. Once it is done and it called tools,
 * the work folds into one line — 「› 已处理 1 分 42 秒 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令」 — that opens to the
 * same timeline; below it the answer, the 「改动了 N 个文件」 card and the message actions; errors stay visible. It
 * folds by itself when it finishes, unless the user opened something in it (or opened it) — then it stays open.
 * The fold is `hidden`, not unmounted: an expanded step keeps its state, Ctrl+F opens a fold with a hit in it, and an
 * export un-hides it.
 */
function TurnView({ turn, last, live, version, sessionId, cwd }: { turn: Turn; last: boolean; live: boolean; version: number; sessionId: string; cwd: string }) {
  const done = !!turn.result || !last || !live;
  // with nothing running, a turn does not change any more: its parts are worked out once (while a turn runs every
  // turn is redone — a tool still finishing behind a steer message belongs to the one before)
  const sig = live || last ? `v${version}` : `${turn.body.length}|${done}`;
  const parts = useMemo(() => splitTurnBody(turn.body), [sig]);
  const fold = done && parts.work;
  const summary = useMemo(() => (fold ? turnSummary(turn) : null), [sig, fold]);
  const changes = useMemo(() => (fold ? fileChanges(turn.body) : []), [sig, fold]);
  const key = `${sessionId}|${turn.id}`;
  const [choice, setChoice] = useState<boolean | undefined>(() => foldMemory.get(key));
  const setOpen = (v: boolean) => { foldMemory.set(key, v); setChoice(v); };
  const touch = useCallback(() => { if (!foldMemory.has(key)) { foldMemory.set(key, true); setChoice(true); } }, [key]);
  const open = fold ? choice ?? false : true;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Ctrl+F landed on a hit inside the fold (FindBar dispatches this on the hidden container)
    const el = body.current;
    if (!el) return;
    const on = () => setOpen(true);
    el.addEventListener('cw:open-fold', on);
    return () => el.removeEventListener('cw:open-fold', on);
  }, [key]);
  const finals = parts.final;
  const lastFinal = finals[finals.length - 1];
  const answerActions = !!lastFinal && !lastFinal.streaming && lastFinal.blocks.some((b) => b.type === 'text' && b.text.trim());
  return (
    <div className={clsx('turn', fold && 'folded', fold && open && 'open')} data-turn={turn.id}>
      {turn.user && <UserRow it={turn.user} version={version} />}
      {fold && summary && (
        <div className="turn-sum-row" data-item-id={parts.process[0]?.id}>
          <button className="turn-sum" aria-expanded={open} onClick={() => setOpen(!open)} title={`${open ? '收起' : '展开'}这一轮的步骤${turn.result ? `\n${resultStats(turn.result).join(' · ')}` : ''}`}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} className="chev" />
            <span className="lbl">{turnSummaryText(summary)}</span>
          </button>
        </div>
      )}
      <TurnTouchCtx.Provider value={touch}>
        <div className="turn-body" data-fold-body="" hidden={!open} ref={body}>
          <ItemList items={fold ? parts.process : turn.body} version={version} actions={fold ? 'none' : 'last'} />
        </div>
      </TurnTouchCtx.Provider>
      {fold && (finals.length > 0 || changes.length > 0) && (
        <div className="turn-answer">
          {finals.map((a) => (
            <div key={a.id} className="assistant-wrap" data-item-id={a.id}>
              <Assistant it={a} version={version} />
              {a !== lastFinal && !a.streaming && a.blocks.some((b) => b.type === 'text' && b.text.trim()) && <AssistantActions it={a} sessionId={sessionId} />}
            </div>
          ))}
          {changes.length > 0 && <ChangesCard rows={changes} sessionId={sessionId} cwd={cwd} />}
          {answerActions && <AssistantActions it={lastFinal} sessionId={sessionId} />}
        </div>
      )}
      {fold && parts.tail.length > 0 && <ItemList items={parts.tail} version={version} />}
    </div>
  );
}

/** The conversation as turns (top level only — a subagent's messages and the detail panel use `ItemList`). */
function TurnList({ items, version, live, sessionId, cwd }: { items: Item[]; version: number; live: boolean; sessionId: string; cwd: string }) {
  const turns = useMemo(() => groupTurns(items), [items, version]);
  return <>{turns.map((t, i) => <TurnView key={t.id} turn={t} last={i === turns.length - 1} live={live} version={version} sessionId={sessionId} cwd={cwd} />)}</>;
}

export function ChatView() {
  const active = useScopedSession();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const version = active?.version ?? 0;
  const [find, setFind] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [older, setOlder] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const sidRef = useRef(active?.sessionId);
  // the tile switched sessions: an older-page request or its error belongs to the previous one
  useEffect(() => { sidRef.current = active?.sessionId; setOlder({ busy: false }); }, [active?.sessionId]);
  const pane = usePaneCtx();
  const pending = active?.pending ?? NO_PENDING;
  const waiting = useMemo(() => waitingToolIds(pending, active?.conv.items ?? []), [pending, version]);

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
      if (sidRef.current !== sid) return;
      setOlder({ busy: false });
      requestAnimationFrame(() => { if (el) el.scrollTop = t0 + (el.scrollHeight - h0); });
    } catch (e) {
      if (sidRef.current !== sid) return;
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
        <WaitingCtx.Provider value={waiting}>
          <TurnList items={active.conv.items} version={version} live={live} sessionId={sid} cwd={active.cwd} />
        </WaitingCtx.Provider>
        {active.error && <div className="sysline" style={{ color: 'var(--red)' }}>{active.error}</div>}
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
