import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitBranch, GitStatus } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { TERMS } from '@/ui/terms';
import { DirPicker } from './DirPicker';
import { Popover } from './Popover';
import { PROJECT_MENU_ID } from './ids';
import { busyInCheckout, liveSessions } from './branch-guard';

/** A default name for a new worktree: `task-0928-1432`. */
export function worktreeName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `task-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * The welcome composer's project chip (spec §5.4, §4.2 「选择目录 / …」): recent projects, 打开文件夹…, and 「在独立副本里
 * 运行（worktree）」 — the new conversation then works in a git worktree of the project (`openSession({worktree})`,
 * Claude Code's --worktree). Reuses DirPicker (its own portalled menu).
 */
export function ProjectChip({ cwd, recent, onPick, onBrowse, worktree, onWorktree }: {
  cwd: string;
  recent: string[];
  onPick: (dir: string) => void;
  onBrowse: () => void;
  /** '' = off, else the worktree's name */
  worktree: string;
  onWorktree: (name: string) => void;
}) {
  const toggle = async (close: () => void) => {
    close();
    if (worktree) { onWorktree(''); return; }
    const n = (await dlg.prompt('在独立副本里运行', worktreeName(), { message: '新对话会在这个项目的一个 git worktree 里工作，不动你当前的检出。给这个副本起个名字：', okLabel: '开启' }))?.trim();
    if (n) onWorktree(n);
  };
  return (
    <DirPicker cwd={cwd} recent={recent} onPick={onPick} onBrowse={onBrowse}
      footer={(close) => (
        <button type="button" role="menuitemcheckbox" aria-checked={!!worktree} data-id={PROJECT_MENU_ID.worktree} className="dirmenu-wt" onClick={() => void toggle(close)} title="Claude Code 的 --worktree：在仓库的独立副本里运行，改动在自己的分支上">
          <Icon name="branch" size={13} />
          <span className="grow">在{TERMS.worktree}里运行{worktree ? `：${worktree}` : ''}</span>
          <span className={clsx('toggle sm', worktree && 'on')} aria-hidden />
        </button>
      )} />
  );
}

/**
 * The branch of the chosen project, next to the project chip (welcome page only; in a conversation the branch is in
 * the header). Its menu switches branches (git.checkout, same as the Git view); a dirty tree is carried over or
 * refused by git itself. Conversations running in the same checkout are asked about first (they would see the other
 * branch's files), and the chip re-reads the branch itself afterwards — the repo may not be watched (no git.changed).
 */
export function BranchChip({ cwd }: { cwd: string }) {
  const { git, reload } = useBranchStatus(cwd);
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  if (!cwd || !git?.branch) return null;
  const dirty = git.files.length;
  return (
    <>
      <button ref={chip} type="button" className={clsx('cchip branch-chip', open && 'open')} onClick={() => setOpen((o) => !o)}
        title={`分支 ${git.branch}${dirty ? ` · ${dirty} 处未提交的改动` : ''}\n点击切换分支`} aria-label={`分支：${git.branch}`} aria-haspopup="menu" aria-expanded={open}>
        <Icon name="branch" size={14} />
        <span className="cc-l opt">{git.branch}{dirty ? ' •' : ''}</span>
        <span className="caret opt"><Icon name="chevronDown" size={10} /></span>
      </button>
      {open && (
        <ErrorBoundary area="分支菜单" compact onReset={() => setOpen(false)}>
          <Popover anchor={chip} onClose={(r) => { setOpen(false); if (r) chip.current?.focus(); }} prefer="down" align="left" className="cm-branch" label="分支">
            <BranchList cwd={cwd} root={git.root ?? cwd} onDone={(changed) => { setOpen(false); chip.current?.focus(); if (changed) reload(); }} />
          </Popover>
        </ErrorBoundary>
      )}
    </>
  );
}

/** git.status of the chosen project, re-read on git.changed for its root and on demand (after our own checkout). */
function useBranchStatus(cwd: string): { git: GitStatus | null; reload: () => void } {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!cwd) { setGit(null); return; }
    let live = true;
    let root: string | null = null;
    const load = async () => {
      const s = await ws.request<GitStatus>({ kind: 'git.status', cwd }).catch(() => null);
      if (!live) return;
      setGit(s);
      root = s?.root ?? null;
    };
    void load();
    const off = ws.on((e) => { if (e.kind === 'git.changed' && root && e.cwd.toLowerCase() === root.toLowerCase()) void load(); });
    return () => { live = false; off(); };
  }, [cwd, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { git, reload };
}

function BranchList({ cwd, root, onDone }: { cwd: string; root: string; onDone: (changed: boolean) => void }) {
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  useEffect(() => { void ws.request<GitBranch[]>({ kind: 'git.branches', cwd }).then(setBranches).catch(() => setBranches([])); }, [cwd]);
  const local = useMemo(() => (branches ?? []).filter((b) => !b.remote && (!q.trim() || b.name.toLowerCase().includes(q.trim().toLowerCase()))), [branches, q]);
  const checkout = async (b: GitBranch) => {
    if (b.current) { onDone(false); return; }
    const st = useStore.getState();
    const n = busyInCheckout(root, liveSessions(st.sessions, st.open));
    if (n > 0) {
      onDone(false); // the question comes up over the page, not under a menu that stays open
      if (!(await dlg.confirm(`切换到 ${b.name}？`, {
        message: `${n} 个对话正在这个项目里运行，切换后它们会看到切换后的文件（它们读写的是同一份检出）。想让新对话和它们互不干扰，可以改用「在${TERMS.worktree}里运行」。`,
        okLabel: '仍然切换',
      }))) return;
    }
    setBusy(true);
    try {
      await ws.request({ kind: 'git.checkout', cwd, name: b.name });
      toast(`已切换到 ${b.name}`, true);
      onDone(true);
    } catch (e: any) { toast(String(e.message).split('\n\n')[0]); } finally { setBusy(false); }
  };
  return (
    <>
      {(branches?.filter((b) => !b.remote).length ?? 0) > 8 && (
        <div className="cm-search"><Icon name="search" size={13} /><input className="field" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选分支…" aria-label="筛选分支" /></div>
      )}
      <div className="cm-h">切换分支</div>
      {branches === null && <div className="menu-note"><span className="spinner" /> 读取分支…</div>}
      <div className="cm-scroll">
        {local.map((b) => (
          <button key={b.name} type="button" data-mi role="menuitemradio" aria-checked={b.current} className={clsx('cm-it one', b.current && 'on')} disabled={busy} onClick={() => void checkout(b)}>
            <span className="cm-ck">{b.current && <Icon name="check" size={13} />}</span>
            <span className="cm-tx"><span className="cm-l mono">{b.name}</span></span>
          </button>
        ))}
      </div>
      {branches !== null && !local.length && <div className="menu-note">{q ? '没有匹配的分支' : '没有本地分支'}</div>}
    </>
  );
}
