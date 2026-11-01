import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PermissionRequestEvent } from '@shared';
import type { AssistantItem, Attachment, Block, Item, ResultItem, ShellRun, ThinkingBlock, ToolUseBlock, UserItem } from '@/model/conversation';
import { walkTools } from '@/model/conversation';
import { Expandable } from './Expandable';
import { stripAnsi } from './tools/ShellTool';
import { WorkflowLive } from '@/features/background/WorkflowLive';
import { useBgSession } from '@/features/background/state';
import { hasLive } from '@/features/background/model';
import { credentialHint, ERROR_HINT, ERROR_LABEL, noResponseHint } from '@/model/health';
import { fmtSize } from '@/model/attachments';
import type { FileChange } from '@/model/diffstat';
import { displayPath, fmtDuration, groupSteps, groupTurns, stepStarts, taskPlan, turnDone, turnDuration, turnMemo, turnStamp, turnSummaryParts, type Turn, type TurnMemo } from '@/model/turn';
import { TodoBody, planItems, planProgress } from './tools/AgentTool';
import { useScopedSession, useScopedSessionId, useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { activeGroup } from '@/model/layout';
import { clsx, fmtMs, fmtTok } from '@/util';
import { fmtCost } from '@/model/cost';
import { coldCache, usageParts } from '@/model/tokens';
import { AssistantActions, UserActions, UserEditor } from './MessageActions';
import { FindBar } from './FindBar';
import { Markdown } from './Markdown';
import type { CodeRunContext } from './CodeBlock';
import { GroupHead, ToolCard, ToolHead, type ToggleBy } from './ToolCard';
import { ProcessGlyph } from '@/themes/ProcessGlyph';
import { runStatus } from './run-status';
import { thinkingTitle } from './thinking-title';
import { getToolDef, isStandalone } from './tools/registry';
import { Icon } from '@/ui/icons';
import { blockRemoteOpen } from '@/features/remote-guard';
import { openChangedFile } from '@/features/workbench/right-panel';
import { VerifyChip } from '@/features/browser/VerifyChip';
import { splitPending, waitingToolIds } from './permission-dock';
import { AskCard } from './AskCard';
import { ArrivalCtx, LiveCtx, StepStartCtx, TurnTouchCtx, WaitingCtx } from './turn-context';
import { externalLive, readsFromOutside } from '@/store/external';
import { withExplanation } from '@errors';
import { Fold, onScreen, reducedMotion, useEntrance, useFold } from './Fold';
import { stepBusy, stepState } from './step-view';
import { COUNT_UP_MS, countAt, splitNumbers } from './count-up';
import { tr } from '@/i18n';
import { fileMenuProps } from '@/features/files/FileMenu';
import { normViewMode, type ViewMode } from './view-mode';
import { SelectionMenu } from './SelectionMenu';
import { TurnRecordings } from '@/features/browser/TurnRecordings';

const useViewMode = (): ViewMode => useStore((s) => normViewMode(s.settings['ui.viewMode']));

const EDIT_STEPS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const NO_PENDING: PermissionRequestEvent[] = [];
/** Change-card rows shown before 「还有 N 个文件」. */
const CARD_ROWS = 8;
/** A new step's entrance (chat.css `step-in`) and the user message's rise (`bubble-rise`), each with a margin: the class goes once it has played. */
const STEP_IN_MS = 380 + 60;
const BUBBLE_IN_MS = 420 + 60;

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
  if (c.read) parts.push(tr('读取 {read} 个文件', { read: c.read }));
  if (c.edit) parts.push(tr('编辑 {edit} 个文件', { edit: c.edit }));
  if (c.cmd) parts.push(tr('运行 {cmd} 条命令', { cmd: c.cmd }));
  if (c.web) parts.push(tr('搜索网页 {web} 次', { web: c.web }));
  if (c.skill) parts.push(tr('调用 {skill} 个 skill', { skill: c.skill }));
  if (c.mcp) parts.push(tr('MCP {mcp} 次', { mcp: c.mcp }));
  const other = (c.other ?? 0) + (c.plan ?? 0) + (c.agent ?? 0);
  if (other) parts.push(tr('{other} 步', { other }));
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
 * Whether the change of what is open that is being rendered moves (its height animates): a pointer's click sets it,
 * and it is off again once that render is on screen — so a setting, the keyboard, a find-in-page hit open and shut
 * things at once (spec §4.5: what the keyboard triggers has no entrance).
 */
function useMoves(): { current: boolean } {
  const moves = useRef(false);
  useEffect(() => { moves.current = false; });
  return moves;
}

/**
 * One step: its row (`ToolHead`), and under it — when it is open — the call's detail, sliding open. A step that
 * arrives while the conversation runs in view fades up into place (`enter`); one that is there when the list is
 * drawn (history, a conversation switched back to, a merged row opened) does not.
 */
function StepRow({ t, version, open, moves, onToggle }: { t: ToolUseBlock; version: number; open: boolean; moves: boolean; onToggle: (by: ToggleBy) => void }) {
  const st = stepState(t, useContext(WaitingCtx));
  const arrival = useContext(ArrivalCtx);
  const enter = useEntrance(() => arrival.current && stepBusy(st) && !reducedMotion(), STEP_IN_MS);
  return (
    <div className={clsx('tl', st, open && 'open', enter && 'enter')} data-step={t.id}>
      <ToolHead t={t} open={open} onToggle={onToggle} />
      <Fold open={open} animate={moves}><ToolCard t={t} version={version} bare /></Fold>
      {!open && t.children.length > 0 && <button className="tl-sub" onClick={() => onToggle('pointer')}>{tr('子代理 {childrenCount} 条消息', { childrenCount: t.children.length })}</button>}
    </div>
  );
}

/**
 * One run of tool calls: a row per step, 30px each, a dashed line between them (UI refresh §6). The row's first slot
 * says where the step is — a spinner while it runs, its tool's icon once it is done, a yellow shield and 「等你确认」
 * while it waits on you, red when it failed — so the list already tells you where the turn got to. Steps next to
 * each other of the same tool that all worked are one row, 「读取 ×3 · a.ts 等」 (`groupSteps`), that opens to them.
 * Clicking a row opens that step's detail under it; with 「在对话里直接展开改动」 (`ui.inlineDiffs`) the finished
 * edits start open (and so does a merged row of them).
 */
function Steps({ tools, version }: { tools: ToolUseBlock[]; version: number }) {
  const waiting = useContext(WaitingCtx);
  const touch = useContext(TurnTouchCtx);
  const inlineDiffs = useStore((s) => s.settings['ui.inlineDiffs'] === true);
  const verbose = useViewMode() === 'verbose';
  const running = tools.some((t) => t.status === 'running' || t.status === 'pending' || t.status === 'streaming');
  const failed = tools.some((t) => t.status === 'error' && !t.stopped);
  // by step id; a merged row is `g:<its first step's id>`
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);
  const moves = useMoves();
  const plan = useContext(PlanCtx);
  // the plan's own step does not open in 详细 too: the dock under the turn already shows that list (2026-10-19: twice)
  const isOpen = (t: ToolUseBlock) => all || (opened[t.id] ?? ((verbose && !(t.name === 'TodoWrite' && t === plan)) || (inlineDiffs && EDIT_STEPS.has(t.name) && t.status === 'done')));
  const toggle = (id: string, open: boolean, by: ToggleBy) => {
    moves.current = by === 'pointer';
    setAll(false);
    setOpened((o) => ({ ...o, [id]: !open }));
    if (!open) touch?.();
  };
  const row = (t: ToolUseBlock) => {
    const open = isOpen(t);
    return <StepRow key={t.id} t={t} version={version} open={open} moves={moves.current} onToggle={(by) => toggle(t.id, open, by)} />;
  };
  return (
    <div className={clsx('trail', running && 'running')}>
      <div className="tl-rows">
        {groupSteps(tools, waiting).map((g) => {
          if (g.steps.length === 1) return row(g.steps[0]);
          const id = `g:${g.key}`;
          // a step of it that is open (opened before it joined, or an edit under 「在对话里直接展开改动」) keeps the row open
          const open = all || (opened[id] ?? g.steps.some(isOpen));
          return (
            <div key={id} className={clsx('tl group done', open && 'open')} data-steps={g.steps.length}>
              <GroupHead steps={g.steps} open={open} onToggle={(by) => toggle(id, open, by)} />
              <Fold open={open} animate={moves.current}><div className="tl-rows">{g.steps.map(row)}</div></Fold>
            </div>
          );
        })}
      </div>
      {tools.length > 1 && (
        <div className="tl-foot">
          <span className="lbl">{stepLabel(tools)}</span>
          {failed && <span className="badge err">{tr('失败')}</span>}
          <button className="tl-all" onClick={(e) => { moves.current = e.detail > 0; setAll(!all); setOpened({}); if (!all) touch?.(); }}>{all ? tr('全部收起') : tr('全部展开')}</button>
        </div>
      )}
    </div>
  );
}

/**
 * A thinking block, folded to 「思考了 12 秒 ›」 (spec §5.3) — a row like a step's. 显示思考过程 (`ui.showThinking`:
 * true, or the older 'expanded') opens them; 'hidden' drops the finished ones.
 */
function Thinking({ b, streaming, run }: { b: ThinkingBlock; streaming: boolean; run?: CodeRunContext }) {
  const pref = useStore((s) => s.settings['ui.showThinking']);
  const view = useViewMode();
  const mode = view !== 'normal' || pref === true || pref === 'expanded' ? 'expanded' : pref === 'hidden' ? 'hidden' : 'collapsed';
  const touch = useContext(TurnTouchCtx);
  const [open, setOpen] = useState<boolean | null>(null);
  const moves = useMoves();
  const text = b.thinking;
  const body = useFollowEnd(text, streaming);
  if (mode === 'hidden' && !streaming) return null;
  if (!text && !streaming && !b.redacted) return null;
  const show = open ?? (mode === 'expanded');
  const toggle = (by: ToggleBy) => { moves.current = by === 'pointer'; setOpen(!show); if (!show) touch?.(); };
  // summarized thinking (Claude) names itself: the row says what it is about, the time goes after it
  const title = b.redacted ? '' : thinkingTitle(text, streaming);
  const label = b.redacted ? tr('思考内容已隐藏（redacted）') : title || (streaming ? tr('思考中') : b.ms !== undefined ? tr('思考了 {fmtDuration}', { fmtDuration: fmtDuration(b.ms) }) : text.length > 1200 ? tr('深入思考了一会儿') : tr('思考了一下'));
  const after = title && !streaming && b.ms !== undefined ? fmtDuration(b.ms) : '';
  const size = text ? (text.length > 1000 ? tr('{textCount}K 字', { textCount: (text.length / 1000).toFixed(1) }) : tr('{textCount} 字', { textCount: text.length })) : '';
  return (
    <div className={clsx('trail thinking', streaming && 'running')}>
      <div className={clsx('tl', streaming ? 'active' : 'done', show && 'open')}>
        <div className="tl-head" onClick={(e) => toggle(e.detail === 0 ? 'key' : 'pointer')} role="button" tabIndex={0} aria-expanded={show} title={size ? tr('思考内容 {size}', { size }) : undefined} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle('key'); } }}>
          <span className={clsx('sgw', streaming ? 'active' : 'done')} aria-hidden>{streaming ? <ProcessGlyph process="think" /> : <Icon name="memory" size={16} />}</span>
          <span className={clsx('lbl', streaming && 'shimmer')}>{label}</span>
          {after && <span className="th-time">{after}</span>}
          {!b.redacted && <Icon name="chevronRight" size={13} className="chev" />}
        </div>
        <Fold open={show && !b.redacted} animate={moves.current}><div className="thinking-body" ref={body.ref} onScroll={body.onScroll}><Markdown text={text} streaming={streaming} run={run} /></div></Fold>
      </div>
    </div>
  );
}

/**
 * The thinking box is 360px tall and scrolls inside: what streams in went on below its bottom edge, and the user had to
 * keep scrolling the box to read along (2026-10-19). While it streams it stays at its end — until the user scrolls it
 * up, and again once they scroll back to the end.
 */
function useFollowEnd(text: string, streaming: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && streaming && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return { ref, onScroll };
}

const Assistant = memo(function Assistant({ it, version, run }: { it: AssistantItem; version: number; run?: CodeRunContext }) {
  const segs = useMemo(() => segment(it.blocks), [it.blocks, version]);
  return (
    <div className="msg assistant" data-msg={it.id}>
      {segs.map((s, idx) => {
        if (s.kind === 'text') return <div key={idx} className={clsx('msg-text', it.streaming && idx === segs.length - 1 && 'cursor')}><Markdown text={(s.b as any).text} streaming={it.streaming && idx === segs.length - 1} run={run} /></div>;
        if (s.kind === 'thinking') return <Thinking key={idx} b={s.b as ThinkingBlock} streaming={it.streaming && idx === segs.length - 1} run={run} />;
        if (s.kind === 'agent') return <ToolCard key={s.t.id} t={s.t} version={version} />;
        // keyed by its first tool, not its position: a leading empty text/thinking segment drops out once more
        // blocks arrive, which would shift indices and remount the trail (losing which step was expanded)
        return <Steps key={`steps-${s.tools[0].id}`} tools={s.tools} version={version} />;
      })}
      {it.error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{it.error}</div>}
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
  const title = !exists ? tr('这个对话已不存在') : a.error ? a.error : tr('引用的对话：{name}（点击打开）', { name: a.name });
  const open = () => {
    if (!exists || !a.sessionId) return;
    const st = useStore.getState();
    st.open[a.sessionId] ? st.openInPane(a.sessionId, 'tab') : void st.loadHistory(a.sessionId, { mode: 'tab' });
  };
  return (
    <span className={clsx('att-chip ref', bad && 'bad')} title={title} onClick={open} role={exists ? 'button' : undefined}>
      <span className="ic"><Icon name="quote" size={12} /></span>
      {a.name}
      {onRemove && <button aria-label={tr('移除引用')} onClick={(e) => { e.stopPropagation(); onRemove(); }}><Icon name="close" size={10} /></button>}
    </span>
  );
}

/** 跨对话工具: a message Claude in another conversation sent here — which one, and a way back to it. */
function FromHead({ from }: { from: { sessionId: string; title: string } }) {
  const go = () => {
    const st = useStore.getState();
    if (st.open[from.sessionId]) st.setActive(from.sessionId);
    else void st.loadHistory(from.sessionId);
  };
  return (
    <button className="from-head" onClick={go} title={tr('打开那个对话')}>
      <Icon name="chat" size={12} /> {tr('来自「{title}」', { title: from.title || tr('另一个对话') })}
    </button>
  );
}

/** A command the user ran themselves: a box on the reply's side, like the official app's, not a thing they said. */
function ShellRunCard({ run }: { run: ShellRun }) {
  const stdout = stripAnsi(run.stdout).trimEnd();
  const stderr = stripAnsi(run.stderr).trimEnd();
  return (
    <div className="shell-run">
      {run.input && <div className="shell-run-cmd" aria-label={tr('命令')}><Icon name="terminal" size={13} /><code>{run.input}</code></div>}
      {stdout && <Expandable text={stdout} lines={40} chars={12000}>{(v) => <pre>{v}</pre>}</Expandable>}
      {stderr && <Expandable text={stderr} lines={20} chars={6000}>{(v) => <pre className="err">{v}</pre>}</Expandable>}
      {!stdout && !stderr && <div className="shell-run-none">{tr('（无输出）')}</div>}
    </div>
  );
}

function UserRow({ it, version }: { it: UserItem; version: number }) {
  const sessionId = useScopedSessionId();
  const [editing, setEditing] = useState(false);
  const open = useStore((s) => (sessionId ? s.open[sessionId] : undefined));
  const images = it.images.filter(Boolean);
  void version;
  // the message this window just sent rises into place (the store's `lastSent` is the one it echoed itself); one that
  // is there when the list is drawn, or that came from another window, does not
  const arrival = useContext(ArrivalCtx);
  const enter = useEntrance(() => arrival.current && !it.meta && !!sessionId && useStore.getState().open[sessionId]?.lastSent?.id === it.id && !reducedMotion(), BUBBLE_IN_MS);
  return (
    <div className={clsx('msg user', it.meta && 'meta', it.shell && 'shell', enter && 'enter')} data-item-id={it.id}>
      {it.shell ? (
        <ShellRunCard run={it.shell} />
      ) : editing && sessionId ? (
        <UserEditor it={it} sessionId={sessionId} onDone={() => setEditing(false)} />
      ) : (
        <div className="bubble">
          {it.from && <FromHead from={it.from} />}
          {it.text}
          {images.length > 0 && <div className="img-grid">{images.map((src, i) => <img key={i} src={src} alt="" onClick={() => open && useStore.getState().openViewer(images, i)} />)}</div>}
          {it.attachments?.length ? <AttachmentChips atts={it.attachments} /> : null}
        </div>
      )}
      {/* under the message, like the reply's (issue #1: floating above it, they could not be reached) */}
      {!it.meta && sessionId && !editing && <UserActions it={it} sessionId={sessionId} onEdit={() => setEditing(true)} />}
    </div>
  );
}

/**
 * A turn's stats line (duration · steps · cost · tokens · cache hit rate): its own row after an unfolded turn, the
 * tooltip of a folded one.
 */
function resultStats(r: ResultItem): { text: string; title?: string }[] {
  const cold = coldCache(r.usage, r.idleBeforeMs);
  return [
    { text: fmtMs(r.durationMs) },
    { text: tr('{numTurns} 步', { numTurns: r.numTurns }) },
    // a turn of the record with no ledger row (it ran in a terminal, or before the ledger): no price to show
    ...(r.costAbsent ? [] : [{ text: fmtCost(r.costUsd, r.costUnknown), title: r.costUnknown ? tr('这个模型没有可靠的价格（中转上的非 Claude 模型，按 Claude 价表估的数不作数）') : undefined }]),
    ...usageParts(r.usage, fmtTok),
    ...(cold ? [cold] : []),
  ];
}

/**
 * Items in their plain order — a subagent's messages, the detail panel, and the inside of a turn. `actions`: which
 * replies get the copy / rate / share row — every one (default), only the last (a turn that has not folded: its
 * answer), or none (the folded steps: the answer below the fold has them, and a hidden row under every step in
 * between would leave gaps).
 */
export function ItemList({ items, version, actions = 'all' }: { items: Item[]; version: number; live?: boolean; actions?: 'all' | 'last' | 'none' }) {
  const merged = useMemo(() => coalesce(items), [items, version]);
  // when each call was made (from the items as they are, before runs of them are merged): a finished step's time
  const starts = useMemo(() => stepStarts(items), [items, version]);
  const sessionId = useScopedSessionId();
  // which endpoint a "连不上" hint names: the conversation's provider (the running process's, else the recorded one),
  // none = the Claude account
  const providerName = useStore((s) => {
    if (!sessionId) return undefined;
    const info = s.open[sessionId]?.info;
    if (info) return info.providerName;
    const id = s.sessionMeta[sessionId]?.providerId;
    return id && id !== 'claude' ? s.providers.find((p) => p.id === id)?.name : undefined;
  });
  const cwd = useStore((s) => (sessionId ? s.open[sessionId]?.info?.cwd : undefined));
  const run = useMemo(() => (sessionId && cwd ? { sessionId, cwd } : undefined), [sessionId, cwd]);
  let lastReply = '';
  if (actions === 'last') for (const it of merged) if (it.kind === 'assistant' && it.blocks.some((b) => b.type === 'text' && b.text.trim())) lastReply = it.id;
  const withActions = (it: AssistantItem) => actions === 'all' || (actions === 'last' && it.id === lastReply);
  return (
    <StepStartCtx.Provider value={starts}>
      {merged.map((it) => {
        switch (it.kind) {
          case 'user':
            return <UserRow key={it.id} it={it} version={version} />;
          case 'assistant':
            return (
              <div key={it.id} className="assistant-wrap" data-item-id={it.id}>
                <Assistant it={it} version={version} run={run} />
                {!it.streaming && withActions(it) && it.blocks.some((b) => b.type === 'text' && b.text.trim()) && sessionId && <AssistantActions it={it} sessionId={sessionId} />}
              </div>
            );
          case 'result':
            return (
              <div key={it.id} className={clsx('result-line', it.isError && 'err')} data-item-id={it.id}>
                {it.isError && <span title={it.text}>{it.errorKind ? ERROR_LABEL[it.errorKind] : tr('错误')}: {(it.text ?? '').slice(0, 200)}</span>}
                {resultStats(it).map((x, i) => <span key={i} title={x.title}>{x.text}</span>)}
              </div>
            );
          case 'system':
            return (
              <div key={it.id} className={clsx('sysline', it.subtype === 'command' && 'cmd', it.level === 'warn' && 'warn', it.level === 'error' && 'err', it.subtype === 'compact' && 'compact')} data-item-id={it.id} title={it.data && typeof it.data === 'object' && (it.data as any).kind ? ERROR_HINT[(it.data as any).kind as keyof typeof ERROR_HINT] : undefined}>
                {it.subtype === 'compact' && <span className="ic"><Icon name="refresh" size={12} /></span>}
                {it.text}
                {typeof (it.data as any)?.hint === 'string' && <div className="sys-hint">{(it.data as any).hint}</div>}
                {(it.data as any)?.hintKey === 'no_response' && <div className="sys-hint">{noResponseHint(providerName)}</div>}
                {(it.data as any)?.hintKey === 'credential' && <div className="sys-hint">{credentialHint(providerName)}</div>}
              </div>
            );
        }
      })}
    </StepStartCtx.Provider>
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
        <span className="t">{tr('改动了 {rowsCount} 个文件', { rowsCount: rows.length })}</span>
        <span className="n"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
        <button className="btn sm primary" onClick={() => open()} title={tr('在右侧审阅这个对话改过的文件')}>{tr('审阅')}</button>
      </div>
      {rows.slice(0, CARD_ROWS).map((r) => {
        const p = displayPath(r.path, cwd);
        return (
          <button key={r.path} className="fcard-f" onClick={() => open(r.path)} {...fileMenuProps(r.path, sessionId)} title={tr("{path}\n点击审阅这个文件的改动", { path: r.path })} data-path={r.path}>
            <span className="p"><span className="d">{p.dir}</span><span className="f">{p.name}</span></span>
            <span className="n"><span className="add">+{r.added}</span> <span className="del">−{r.removed}</span></span>
          </button>
        );
      })}
      {rows.length > CARD_ROWS && <button className="fcard-f more" onClick={() => open()}>{tr('还有 {rowsCount} 个文件…', { rowsCount: rows.length - CARD_ROWS })}</button>}
    </div>
  );
}

/** Whether a turn is folded, per conversation and turn — kept when the tile switches conversations and back. */
const foldMemory = new Map<string, boolean>();

/**
 * A folded turn's line. At rest it is the summary's own text, part by part. `play` (the turn just ended in view):
 * its numbers count up from 0 once, 520 ms — each in a box as wide as the number it ends on, so nothing shifts.
 */
function SumLine({ parts, play }: { parts: { text: string; err?: boolean }[]; play: boolean }) {
  const [p, setP] = useState(play ? 0 : 1);
  useEffect(() => {
    if (!play) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const v = Math.min(1, Math.max(0, (now - t0) / COUNT_UP_MS));
      setP(v);
      if (v < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // frames can stall (the window went to the back): the numbers still end on the real ones
    const end = setTimeout(() => setP(1), COUNT_UP_MS + 120);
    return () => { cancelAnimationFrame(raf); clearTimeout(end); };
  }, [play]);
  return (
    <span className="lbl">
      {parts.map((part, i) => (
        <span key={i} className={clsx(part.err && 'err')}>
          {i > 0 && ' · '}
          {p < 1 ? splitNumbers(part.text).map((x, j) => ('text' in x ? x.text : <span key={j} className="num" style={{ minWidth: `${x.s.length}ch` }}>{countAt(x, p)}</span>)) : part.text}
        </span>
      ))}
    </span>
  );
}

/**
 * One turn (spec §5.3). While it runs, everything shows in order, as before. Once it is done and it called tools,
 * the work folds into one line — 「› 已处理 1 分 42 秒 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令」 — that opens to the
 * same steps; below it the answer, the 「改动了 N 个文件」 card and the message actions; errors stay visible. It
 * folds by itself when it finishes, unless the user opened something in it (or opened it) — then it stays open.
 * The fold is `hidden`, not unmounted: an expanded step keeps its state, Ctrl+F opens a fold with a hit in it, and an
 * export un-hides it.
 *
 * How it moves (UI refresh §6). A turn that ends while it is on screen: the steps fold away (a grid row 1fr → 0fr,
 * 340 ms) and the line fades in with its numbers counting up — once, for a turn that was seen running; a turn drawn
 * already finished (history, a conversation switched back to, a background tab) just shows the result. A pointer's
 * click on the line folds and unfolds with the same motion; the keyboard and a find-in-page hit do it at once.
 * `hidden` is set the moment the turn is folded (it is what FindBar, the export and ui-smoke read); while the steps
 * are still sliding shut the class `moving` keeps them in the page.
 */
type TurnProps = { turn: Turn; last: boolean; live: boolean; version: number; sessionId: string; cwd: string };
/**
 * Redrawn when its version moves — an earlier turn gets the one streamed deltas leave alone (TurnList) — not for every
 * new Turn object: groupTurns makes them anew each time, over the same items (mutated in place by the reducer).
 * Drawing every earlier turn for each frame of a stream was most of a frame's 15–30 ms (2026-10-19 profile).
 */
export const sameTurn = (a: TurnProps, b: TurnProps) =>
  a.turn.id === b.turn.id && a.last === b.last && a.live === b.live && a.version === b.version && a.sessionId === b.sessionId && a.cwd === b.cwd;

const TurnView = memo(function TurnView({ turn, last, live, version, sessionId, cwd }: TurnProps) {
  const done = turnDone(turn, { last, live });
  const run = useMemo(() => ({ sessionId, cwd }), [sessionId, cwd]);
  // a finished earlier turn is worked out once per set of items (and per loaded subagent); the last turn and one not
  // done yet (a tool still finishing behind a steer message) are redone on every event
  const memo = useRef<TurnMemo>(undefined);
  memo.current = turnMemo(memo.current, turn, done, turnStamp({ last, done, version }));
  const { parts, summary, changes } = memo.current;
  const fold = done && parts.work;
  // 后台: a workflow this turn started may still run after the turn ended — its agents stay in sight when the turn folds
  const workflows = useMemo(() => (fold ? [...walkTools(parts.process)].filter((x) => x.depth === 0 && x.tool.name === 'Workflow').map((x) => x.tool.id) : []), [fold, parts.process]);
  const view = useViewMode();
  const key = `${sessionId}|${turn.id}`;
  const [choice, setChoice] = useState<boolean | undefined>(() => foldMemory.get(key));
  const moves = useMoves();
  const setOpen = (v: boolean, move = false) => { moves.current = move; foldMemory.set(key, v); setChoice(v); };
  const touch = useCallback(() => { if (!foldMemory.has(key)) { foldMemory.set(key, true); setChoice(true); } }, [key]);
  // 显示思考 / 详细: a finished turn starts open — its steps stay one-line rows in 显示思考, open in 详细
  const open = fold ? choice ?? (view !== 'normal') : true;
  const body = useRef<HTMLDivElement>(null);
  // The first time this turn is seen folded. Drawn folded from the start: nothing plays. Folded later, in view: the
  // end of a turn the user watched — `ended` for a moment (the line's fade and count-up), and the fold below moves.
  // Only once: a turn that unfolds and folds again later (the conversation resumed for a moment) does not replay it.
  const [seenFolded, setSeenFolded] = useState(fold);
  const [ended, setEnded] = useState(false);
  let endsNow = false;
  if (fold && !seenFolded) {
    setSeenFolded(true);
    endsNow = !reducedMotion() && onScreen(body.current);
    if (endsNow) setEnded(true);
  }
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => setEnded(false), COUNT_UP_MS + 400);
    return () => clearTimeout(t);
  }, [ended]);
  const { phase } = useFold(open, endsNow || moves.current, body);
  useEffect(() => {
    // Ctrl+F landed on a hit inside the fold (FindBar dispatches this on the hidden container)
    const el = body.current;
    if (!el) return;
    const on = () => setOpen(true);
    el.addEventListener('cw:open-fold', on);
    return () => el.removeEventListener('cw:open-fold', on);
  }, [key]);
  const finals = parts.final;
  // 录下 Claude 的操作: recordings that started between this turn's message and its end (a minute's slack)
  const recStart = turn.user?.ts ? Date.parse(turn.user.ts) : NaN;
  const lastFinal = finals[finals.length - 1];
  const answerActions = !!lastFinal && !lastFinal.streaming && lastFinal.blocks.some((b) => b.type === 'text' && b.text.trim());
  return (
    <div className={clsx('turn', fold && 'folded', fold && open && 'open')} data-turn={turn.id}>
      {turn.user && <UserRow it={turn.user} version={version} />}
      {fold && summary && (
        <div className={clsx('turn-sum-row', ended && 'just')} data-item-id={parts.process[0]?.id}>
          {/* a click made by the keyboard (detail 0) folds at once */}
          <button className="turn-sum" aria-expanded={open} onClick={(e) => setOpen(!open, e.detail > 0)} title={tr('{v}这一轮的步骤{v2}', { v: open ? tr('收起') : tr('展开'), v2: turn.result ? `\n${resultStats(turn.result).map((x) => x.text).join(' · ')}` : '' })}>
            <Icon name="chevronRight" size={13} className="chev" />
            <SumLine parts={turnSummaryParts(summary)} play={ended} />
          </button>
        </div>
      )}
      <TurnTouchCtx.Provider value={touch}>
        <div className={clsx('turn-body', phase === 'pre' && 'pre', (phase === 'pre' || phase === 'opening' || phase === 'closing') && 'moving')} data-fold-body="" hidden={!open} ref={body}>
          <div className="turn-body-in">
            <ItemList items={fold ? parts.process : turn.body} version={version} actions={fold ? 'none' : 'last'} />
          </div>
        </div>
      </TurnTouchCtx.Provider>
      {fold && (finals.length > 0 || changes.length > 0) && (
        <div className="turn-answer">
          {finals.map((a) => (
            <div key={a.id} className="assistant-wrap" data-item-id={a.id}>
              <Assistant it={a} version={version} run={run} />
              {a !== lastFinal && !a.streaming && a.blocks.some((b) => b.type === 'text' && b.text.trim()) && <AssistantActions it={a} sessionId={sessionId} />}
            </div>
          ))}
          {changes.length > 0 && <ChangesCard rows={changes} sessionId={sessionId} cwd={cwd} />}
          {changes.length > 0 && <VerifyChip sessionId={sessionId} turnId={turn.id} />}
          {answerActions && <AssistantActions it={lastFinal} sessionId={sessionId} />}
        </div>
      )}
      {fold && !open && workflows.map((id) => <WorkflowLive key={id} toolUseId={id} onlyRunning />)}
      {fold && parts.tail.length > 0 && <ItemList items={parts.tail} version={version} />}
      <TurnRecordings sessionId={sessionId} start={recStart} end={last ? Infinity : recStart + (turnDuration(turn) ?? 0) + 60_000} />
    </div>
  );
}, sameTurn);

/**
 * The conversation as turns (top level only — a subagent's messages and the detail panel use `ItemList`). `settled`:
 * the version without the frames of streamed deltas — those only write into the last turn (a background subagent's
 * deltas into an earlier one show with its next whole message).
 */
function TurnList({ items, version, settled, live, waiting, sessionId, cwd, ask, scope }: { items: Item[]; version: number; settled: number; live: boolean; waiting: boolean; sessionId: string; cwd: string; ask?: PermissionRequestEvent; scope: string }) {
  const turns = useMemo(() => groupTurns(items), [items, version]);
  const view = useViewMode();
  const bg = hasLive(useBgSession(sessionId));
  const going = live || bg;
  const found = taskPlan(turns);
  const plan = planShown(found, going) ? found : null;
  return (
    <PlanCtx.Provider value={plan}>
      {/* keyed by the conversation too: a fork has its parent's message ids, and a turn's view (what it saw of its
          end, whether the user opened it) belongs to one conversation */}
      {turns.map((t, i) => <TurnView key={`${sessionId}|${t.id}|${view}`} turn={t} last={i === turns.length - 1} live={live} version={i === turns.length - 1 ? version : settled} sessionId={sessionId} cwd={cwd} />)}
      {/* the question card at the end of the turn, above the plan (stage C1) */}
      {ask && <AskCard key={ask.requestId} p={ask} sessionId={sessionId} scope={scope} />}
      {plan && <PlanDock t={plan} going={going} waiting={waiting} />}
    </PlanCtx.Provider>
  );
}

/** The plan the dock shows: its TodoWrite step does not open its list in the steps as well (2026-10-19: twice). */
export const PlanCtx = createContext<ToolUseBlock | null>(null);

/**
 * The plan of the task in progress at the foot of the conversation, as the official desktop app has it: the list as it
 * stands now (ticks, the arc on the step in progress), under everything the turn wrote. It stays while the agent or
 * its background subagents still work, and while steps are left — gone once the task is through (2026-10-19 user: the
 * plan going away is how I know the task finished). `waiting`: a question / permission waits for the user — the step
 * in progress does not turn meanwhile.
 */
export function planShown(t: ToolUseBlock | null, going: boolean): boolean {
  if (!t) return false;
  const todos = planItems(t);
  return todos.length > 0 && (going || planProgress(todos).done < todos.length);
}

function PlanDock({ t, going, waiting }: { t: ToolUseBlock; going: boolean; waiting: boolean }) {
  const { done, total, attrs } = planProgress(planItems(t));
  // left with steps not done and nothing running (stopped, or the model never ticked the last one): it holds still
  return (
    <div className="plan-dock" data-id="plan-dock" data-waiting={waiting || undefined} data-idle={!going || undefined} title={waiting ? tr('等你回答后继续') : undefined} {...(attrs as any)} aria-label={tr('计划 {done}/{total}', { done, total })}>
      <TodoBody t={t} count={false} />
    </div>
  );
}

export function ChatView() {
  const active = useScopedSession();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const version = active?.version ?? 0;
  const settled = version - (active?.streamed ?? 0);
  const [find, setFind] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [older, setOlder] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const sidRef = useRef(active?.sessionId);
  // the tile switched sessions: an older-page request or its error belongs to the previous one
  useEffect(() => { sidRef.current = active?.sessionId; setOlder({ busy: false }); }, [active?.sessionId]);
  const pane = usePaneCtx();
  const pending = active?.pending ?? NO_PENDING;
  const ask = useMemo(() => splitPending(pending).ask, [pending]);
  // the composer's pane + tile, as its `dockScope`: the composer's empty Enter moves the focus into the card
  const askScope = pane ? `${pane.paneId}|${pane.tileId}` : 'none';
  // the same Set while its ids are the same: a new one each version redrew every step of every turn (context consumers
  // are not stopped by TurnView's memo)
  const waitingRef = useRef<Set<string>>(undefined);
  const waiting = useMemo(() => {
    const next = waitingToolIds(pending, active?.conv.items ?? []);
    const prev = waitingRef.current;
    if (prev && prev.size === next.size && [...next].every((id) => prev.has(id))) return prev;
    return (waitingRef.current = next);
  }, [pending, version]);
  // the change cards' paths read relative to the conversation's folder — the list's when the open conversation has
  // none yet (like the header)
  const listCwd = useStore((s) => (active && !active.cwd ? s.sessions.find((x) => x.sessionId === active.sessionId)?.cwd : undefined));
  // a turn a CLI is writing from outside counts as running too (its last tool keeps its spinner)
  const live = !!active && (active.state === 'running' || active.state === 'waiting' || externalLive(active));
  // What arrives live (ArrivalCtx): this render shows an event of a conversation that runs — its version moved while
  // the list is the same array as at the last commit (history loading, a reload and another conversation are new
  // arrays) with the same first item (an older page prepended is not an arrival). True for this render only.
  const items = active?.conv.items;
  const drawn = useRef<{ items: Item[]; first: Item | undefined; version: number } | null>(null);
  const arrival = useRef(false);
  arrival.current = live && !!items && !!drawn.current && drawn.current.items === items && (drawn.current.first === undefined || drawn.current.first === items[0]) && drawn.current.version !== version;
  useEffect(() => {
    drawn.current = items ? { items, first: items[0], version } : null;
    arrival.current = false;
  });

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
    <div className="chat" ref={ref} onScroll={onScroll} data-state={active.state}>
      <FindBar open={find} onClose={() => setFind(false)} root={() => ref.current} />
      <SelectionMenu root={ref} sessionId={active.sessionId} />
      {!atBottom && <button className="jump-bottom" title={tr('回到底部')} onClick={() => { const el = ref.current!; el.scrollTop = el.scrollHeight; stick.current = true; }} aria-label={tr('回到底部')}><Icon name="chevronDown" size={16} /></button>}
      <div className="chat-inner" data-session-id={active.sessionId}>
        {active.loading && <div className="sysline"><ProcessGlyph process="read" /> {tr('加载历史…')}</div>}
        {active.loadError && !active.loading && (
          <div className="load-err" role="alert">
            <Icon name="alert" size={14} />
            <span className="why">{tr('加载历史失败：{loadError}', { loadError: active.loadError })}</span>
            <button className="btn sm" onClick={() => void useStore.getState().loadHistory(sid, { focus: false })}><Icon name="refresh" size={12} /> {tr('重试')}</button>
          </div>
        )}
        {active.historyCursor && !active.loading && (
          <div className="older-row">
            {older.error ? (
              <span className="load-err inline" role="alert"><span className="why">{tr('加载更早的记录失败：{error}', { error: older.error })}</span><button className="btn sm" onClick={loadOlder}><Icon name="refresh" size={12} /> {tr('重试')}</button></span>
            ) : (
              <button className="btn sm ghost" disabled={older.busy} onClick={loadOlder}>{older.busy ? <span className="spinner" /> : <Icon name="chevronDown" size={12} className="flip" />} {tr('加载更早的记录')}</button>
            )}
          </div>
        )}
        <WaitingCtx.Provider value={waiting}>
          <LiveCtx.Provider value={live}>
            <ArrivalCtx.Provider value={arrival}>
              <TurnList items={active.conv.items} version={version} settled={settled} live={live} waiting={active.state === 'waiting' || pending.length > 0} sessionId={sid} cwd={active.cwd || listCwd || ''} ask={ask} scope={askScope} />
            </ArrivalCtx.Provider>
          </LiveCtx.Provider>
        </WaitingCtx.Provider>
        {active.error && <div className="sysline" role="alert" style={{ color: 'var(--red)', whiteSpace: 'pre-line', userSelect: 'text' }}>{withExplanation(active.error)}</div>}
        {active.state === 'running' && !active.conv.streaming.size && (
          <div className="working">
            <ProcessGlyph process={runStatus(active.conv, active.state, () => null).process} size="stage" /> {tr('处理中')}
          </div>
        )}
        {readsFromOutside(active) && externalLive(active) && (
          <div className="working elsewhere">
            <ProcessGlyph process="think" /> {tr('这个对话正在别处更新（终端或其它应用），这里会跟着显示')}
          </div>
        )}
        {active.state === 'starting' && (
          <div className="working">
            <ProcessGlyph process="start" size="stage" /> {tr('正在启动 Claude Code…')}
          </div>
        )}
      </div>
    </div>
  );
}
