import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The composer's one row inside the text box (spec §5.4; structure round 2): `+` · project · branch on the left,
 * model · effort · permission · mic · send on the right. Never wraps: it is a size container, and below ~560 / 420px
 * (a split pane) the chips drop their text (`.opt`) and keep their icons; the model chip truncates last. Used as it is
 * only by the new-conversation page with 设置 › 新对话页的输入框 = 在框里; everywhere else the box keeps `+`, the words,
 * mic and send (the bar is `display: contents` there) and the chips go on the line under it (ComposerUnder).
 */
export function ComposerBar({ plus, project, branch, status, meter, model, subagent, effort, permission, mic, steer, send }: {
  plus?: ReactNode;
  project?: ReactNode;
  branch?: ReactNode;
  /** a notice about the next send (the permission a resumed conversation really has, 启动中…) */
  status?: ReactNode;
  meter?: ReactNode;
  model?: ReactNode;
  /** 子代理 — the model the conversation's subagents run on (Claude only) */
  subagent?: ReactNode;
  /** 想多深 — its own chip next to the model's (none for an agent without levels) */
  effort?: ReactNode;
  permission?: ReactNode;
  mic?: ReactNode;
  steer?: ReactNode;
  send: ReactNode;
}) {
  return (
    <div className="composer-bar cb">
      <div className="cb-left">{plus}{project}{branch}</div>
      <span className="grow" />
      <div className="cb-right">{status}{meter}{model}{subagent}{effort}{permission}{mic}{steer}{send}</div>
    </div>
  );
}

/**
 * The line under the box (redesign 2026-11 #pages 「输入框下面这一行」; the user: keep everything, all in words, never
 * icon-only). A conversation: 权限 · the conversation's numbers (ConvStatsLine) … 模型 · 子代理 · 思考强度 · the context
 * ring. The new-conversation page: 文件夹 (the machine joined to it when there are others) · 分支 · 权限 … 模型 · 子代理 ·
 * 思考强度. A phone: 项目 · 权限 · 「模型 · 强度」 / 权限 · 「模型 · 强度」 · the ring (the caller fills fewer slots).
 *
 * Narrow (composer.css + this): the numbers give way first — whole items, 轮数 then 步数, and 「缓存命中」 becomes 「缓存」
 * — then the model's name truncates; a chip never loses its words. When even that does not fit on one line (a very
 * narrow split pane), the right-hand group moves to a line of its own (`data-wrap`, measured here: a box cannot query
 * its own width in CSS).
 */
export function ComposerUnder({ lead, permission, stats, status, model, subagent, effort, meter, offstage }: {
  /** the new-conversation page: the folder (with the machine) and the branch before the permission */
  lead?: ReactNode;
  permission?: ReactNode;
  /** the conversation so far (ConvStatsLine), in the free middle of the row */
  stats?: ReactNode;
  /** a notice about the next send: the permission a resumed conversation really has (发送前核对权限), 启动中… */
  status?: ReactNode;
  model?: ReactNode;
  subagent?: ReactNode;
  effort?: ReactNode;
  meter?: ReactNode;
  /** mounted, not shown: a phone's 子代理 chip, whose sheet the model sheet's last row opens */
  offstage?: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState(false);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    // The one-line row's least width: the left group, plus the right-hand group with the model's name cut to 6em. Only
    // the model's name shrinks (composer.css: every other chip is `flex: none`), so the right group's natural width is
    // its width plus what the name hides — the same number on one line and wrapped: no flip-flop, nothing changed here
    const measure = () => {
      const left = el.querySelector<HTMLElement>(':scope > .cb-left');
      const right = el.querySelector<HTMLElement>(':scope > .cb-right');
      const label = right?.querySelector<HTMLElement>('.mm-anchor:not(.sub-anchor) .mm-chip-label');
      const em = label ? parseFloat(getComputedStyle(label).fontSize) || 13 : 13;
      const need = (left?.offsetWidth ?? 0) + (right?.offsetWidth ?? 0) + (label ? Math.min(label.scrollWidth, 6 * em) - label.clientWidth : 0) + 12;
      const fits = el.clientWidth >= need;
      setWrap((w) => (w === !fits ? w : !fits));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={row} className="composer-under cb" data-wrap={wrap ? '' : undefined}>
      <div className="cb-left">{lead}{permission}</div>
      {/* the free middle of the row: the numbers take what is left and drop whole items that do not fit */}
      <span className="grow cb-mid">{stats}</span>
      <div className="cb-right">{status}{model}{subagent}{effort}{meter}</div>
      {offstage && <span className="cb-offstage" hidden>{offstage}</span>}
    </div>
  );
}
