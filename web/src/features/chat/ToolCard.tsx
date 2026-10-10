import { memo, useContext, useEffect, useState } from 'react';
import type { ToolUseBlock } from '@/model/conversation';
import { fmtDuration } from '@/model/turn';
import { useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { clsx, basename } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { ItemList } from './ChatView';
import { getToolDef, splitMcp, toolDisplayName } from './tools/registry';
import { ArrivalCtx, LiveCtx, StepStartCtx, WaitingCtx } from './turn-context';
import { WAITING_FOR_YOU } from '@/ui/terms';
import { useJust } from './Fold';
import { fmtStepDuration, mergedLabel, mergedTarget, shortVerb, stepDurationMs, stepState, watchStep, watchedStep, type StepState } from './step-view';

/** How a step's row is toggled: a pointer's click moves (the detail slides open), the keyboard's does not (spec §4.5). */
export type ToggleBy = 'pointer' | 'key';

/** The icon's pop when a step finishes (chat.css `step-pop`), and a margin. */
const POP_MS = 320 + 80;

function SubagentLoader({ toolUseId }: { toolUseId: string }) {
  const ctx = usePaneCtx();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    setBusy(true);
    try {
      await useStore.getState().loadSubagent((ctx?.sessionId ?? useStore.getState().activeId)!, toolUseId);
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return (
    <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
      <button className="btn sm" disabled={busy} onClick={load}>
        {busy ? '加载中…' : '加载子代理对话'}
      </button>
      {err && <span style={{ color: 'var(--err)', marginLeft: 8 }}>{err}</span>}
    </div>
  );
}

/**
 * The 16px slot at the start of a step row — the one mark that says where the step is. Running: a spinner (only in a
 * conversation that runs: elsewhere a step without a result never finished, and gets a still ring). Done: the tool's
 * own icon, popping in when the step finished in view (`pop`). Waiting on you: the yellow shield. Failed or refused: red.
 */
function StepGlyph({ st, icon, spins, pop }: { st: StepState; icon: IconName; spins: boolean; pop: boolean }) {
  return (
    <span className={clsx('sgw', st)} aria-hidden>
      {st === 'failed' ? <Icon name="close" size={16} />
        : st === 'waiting' ? <Icon name="shield" size={16} />
          : st === 'done' ? <Icon name={icon} size={16} className={pop ? 'pop' : undefined} />
            : spins ? <span className="spin" />
              : <Icon name="circle" size={12} />}
    </span>
  );
}

/** The verb and the target of a call, as a row shows them (the full target stays in the tooltip). */
function rowLabel(t: ToolUseBlock): { icon: IconName; name: string; verb: string; target: string; full: string } {
  const def = getToolDef(t.name);
  const { verb, arg } = def.label(t.input as any);
  const mcp = splitMcp(t.name);
  return {
    icon: def.icon,
    name: mcp ? toolDisplayName(t.name) : shortVerb(verb) || t.name,
    verb: mcp ? verb : '',
    target: def.category === 'read' || def.category === 'edit' ? shortPath(arg) : arg,
    full: arg,
  };
}

/**
 * A tool call as one row, 30px tall (UI refresh §6): the glyph slot, the verb, the target in a small mono chip, and
 * at the row's end how long it took — or 「失败」 / 「等你确认」. Never a card, no check mark per row; expanding it shows
 * the call's detail under it. Paths show as basename with the full path in the tooltip, so a deep path can't blow the
 * line out. Also the head of a standalone tool's card and of the detail panel.
 */
export function ToolHead({ t, onToggle, open }: { t: ToolUseBlock; onToggle?: (by: ToggleBy) => void; open?: boolean }) {
  const { icon, name, verb, target, full } = rowLabel(t);
  const ctx = usePaneCtx();
  const setInspect = (id: string) => useStore.setState({ inspect: { sessionId: (ctx?.sessionId ?? useStore.getState().activeId)!, toolUseId: id } });
  // on a phone the row has no 详情 button: tapping the row itself opens the detail in the bottom sheet
  const phone = useStore((s) => s.mobile);
  const secs = useElapsed(t);
  // blocked on a permission card above the composer (the glyph is a yellow shield): say so instead of 等待
  const st = stepState(t, useContext(WaitingCtx));
  const live = useContext(LiveCtx);
  const starts = useContext(StepStartCtx);
  const watched = watchStep(t, st, Date.now(), useContext(ArrivalCtx).current);
  // finished while this row was on screen: its icon pops in (history, and a row drawn already finished, do not)
  const pop = useJust(st === 'done', POP_MS);
  const took = st === 'done' ? stepDurationMs(t, { start: starts.get(t.id), watched }) : undefined;
  const end = st === 'failed' ? '失败'
    : st === 'waiting' ? WAITING_FOR_YOU
      : t.status === 'running' ? (secs !== null ? (secs < 60 ? `${secs} 秒` : fmtDuration(secs * 1000)) : '运行中')
        // in a conversation that runs, the spinner says it; in one that does not, the step never got its turn
        : live ? ''
          : t.status === 'pending' ? '等待'
            : t.status === 'streaming' ? '…'
              : '';
  return (
    <div
      className={clsx('tool-head', open && 'open')}
      title={full}
      {...(onToggle ? {
        role: 'button', tabIndex: 0, 'aria-expanded': !!open,
        // a click made by the keyboard or by code (detail 0) does not animate.
        // On a phone a step's detail opens in the bottom sheet (详情) — the conversation is not stretched (UI refresh §8)
        onClick: (e: React.MouseEvent) => (phone ? setInspect(t.id) : onToggle(e.detail === 0 ? 'key' : 'pointer')),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (phone) setInspect(t.id); else onToggle('key'); } },
      } : {})}
    >
      <StepGlyph st={st} icon={icon} spins={live} pop={pop} />
      <span className="name">{name}</span>
      {verb && <span className="verb">{verb}</span>}
      {target && <code className="summary">{target}</code>}
      <span className="grow" />
      {/* before the time, shown on hover: the times stay in a column at the row's end */}
      {!phone && <button className="icon-btn xs" title="在右侧查看详情" aria-label="详情" onClick={(e) => { e.stopPropagation(); setInspect(t.id); }}><Icon name="external" size={12} /></button>}
      {t.progress?.lastTool && t.status === 'running' && <span className="st">{t.progress.lastTool}</span>}
      {(end || took !== undefined) && <span className={clsx('st', st === 'failed' && 'err', st === 'waiting' && 'wait', took !== undefined && 'dur')}>{end || fmtStepDuration(took!)}</span>}
    </div>
  );
}

/**
 * The row of a merged run — 「读取 ×3 · a.ts 等」: the tool's icon, its verb and how many, the first target, and the
 * time they took together when every one of them has a time. It opens to the rows it stands for.
 */
export function GroupHead({ steps, open, onToggle }: { steps: ToolUseBlock[]; open: boolean; onToggle: (by: ToggleBy) => void }) {
  const first = rowLabel(steps[0]);
  const starts = useContext(StepStartCtx);
  const now = Date.now();
  let total: number | undefined = 0;
  for (const s of steps) {
    const ms = stepDurationMs(s, { start: starts.get(s.id), watched: watchStep(s, 'done', now) });
    if (ms === undefined) { total = undefined; break; }
    total += ms;
  }
  // A step that finished in view joins the run (or makes it, with the one before): the icon pops, as the step's own
  // would have. Not for a run that is simply drawn (history, a conversation switched back to, a list opened).
  const arrival = useContext(ArrivalCtx);
  const [n, setN] = useState(steps.length);
  const [pop, setPop] = useState(() => arrival.current && watchedStep(steps[steps.length - 1]));
  if (steps.length !== n) {
    setN(steps.length);
    if (steps.length > n && arrival.current) setPop(true);
  }
  useEffect(() => {
    if (!pop) return;
    const t = setTimeout(() => setPop(false), POP_MS);
    return () => clearTimeout(t);
  }, [pop, n]);
  return (
    <div
      className={clsx('tool-head grp', open && 'open')}
      role="button" tabIndex={0} aria-expanded={open}
      aria-label={mergedLabel(first.name, steps.length, first.target)}
      title={steps.map((s) => rowLabel(s).full).filter(Boolean).join('\n')}
      onClick={(e) => onToggle(e.detail === 0 ? 'key' : 'pointer')}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle('key'); } }}
    >
      {/* keyed by the count while it pops: each step that joins plays it again */}
      <span className="sgw done" aria-hidden><Icon key={pop ? n : 0} name={first.icon} size={16} className={pop ? 'pop' : undefined} /></span>
      <span className="name">{first.name} ×{steps.length}</span>
      {first.target && <code className="summary">{mergedTarget(first.target)}</code>}
      <span className="grow" />
      {total !== undefined && <span className="st dur">{fmtStepDuration(total)}</span>}
      <Icon name="chevronRight" size={13} className="chev" />
    </div>
  );
}

/**
 * Seconds a running tool has been going, ticking on its own.
 *
 * `progress.elapsed` is authoritative when the agent keeps sending it (Claude does); ACP and Codex
 * announce the start and then go quiet, so the wall clock since `startedAt` is what stops the row
 * from sitting at "0 秒" for the whole command.
 */
function useElapsed(t: ToolUseBlock): number | null {
  const live = t.status === 'running';
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [live]);
  if (!live || (!t.progress && !t.startedAt)) return null; // nothing to count from → just "运行中"
  const reported = t.progress ? Math.round(t.progress.elapsed) : 0;
  const wall = t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : 0;
  return Math.max(reported, wall);
}

/** `a/b/c/file.ts:10-40` → `file.ts:10-40`; the head's tooltip keeps the full string. */
function shortPath(arg: string): string {
  if (!arg || /\s/.test(arg)) return arg;
  const b = basename(arg.replace(/[\\/]+$/, ''));
  return b && b.length < arg.length ? b : arg;
}

/**
 * `bare` renders only the body (the step's row already is its head), which is how every tool inside a `Steps`
 * list is shown. Standalone tools (Agent / plan / question) keep the card.
 */
export const ToolCard = memo(function ToolCard({ t, version, bare }: { t: ToolUseBlock; version: number; bare?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const def = getToolDef(t.name);
  const isAgent = def.category === 'agent';
  const defaultOpen = t.status === 'error' || (isAgent && t.status === 'running') || def.category === 'plan';
  const show = bare || (open ?? defaultOpen);
  void version;
  const Body = def.Body;
  const children = t.children.length > 0 ? (
    <div className="tool-children">
      {show ? <ItemList items={t.children} version={version} /> : <div style={{ fontSize: 13, color: 'var(--ink-3)', cursor: 'pointer' }} onClick={() => setOpen(true)}>子代理 {t.children.length} 条消息 · 展开</div>}
    </div>
  ) : isAgent && t.status === 'done' && t.name !== 'Workflow' ? (
    <div className="tool-children"><SubagentLoader toolUseId={t.id} /></div>
  ) : null;

  if (bare) return <div className="tool-out"><div className="tool-body"><Body t={t} /></div>{children}</div>;
  return (
    <div className={clsx('tool', t.status === 'error' && 'error', (t.status === 'running' || t.status === 'pending') && 'running')}>
      <ToolHead t={t} open={show} onToggle={() => setOpen(!show)} />
      {show && <div className="tool-body"><Body t={t} /></div>}
      {children}
    </div>
  );
});
