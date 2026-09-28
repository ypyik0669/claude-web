import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useScopedSession, useStore } from '@/store';
import { ago, clsx } from '@/util';
import type { GitError, GitLogEntry, GitStatus } from '@shared';
import { walkTools } from '@/model/conversation';
import { DiffView } from '@/features/chat/DiffView';
import { sessionPeer } from '@/features/peers';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { EMPTY, TERMS, emptyText } from '@/ui/terms';
import { EmptyState } from '@/ui/EmptyState';
import { GitView } from './GitView';
import { Popover } from '@/features/composer/Popover';
import { coalesce, gitEventConcerns } from './git-refresh';
import { SCOPE_LABEL, bulkTargets, commitPlan, diffRequest, discardConfirm, reviewRows, scopeCounts, splitPath, splitUnifiedByFile, stageAllConfirm, unifiedStat, type DiffResult, type ReviewRow, type ReviewScope } from './review-model';
import { useRightPanel } from './right-panel';
import { modKey } from './shortcuts';
import { markChecklist } from '@/features/home/checklist-sync';

/** Diffs fetched up front (for the +N −M on every row); the rest when a file is opened. */
const EAGER = 8;
/** Files open when a list first shows. */
const OPEN_FIRST = 3;
/** A new / not-in-git file longer than this is not drawn line by line. */
const MAX_LINES = 1500;
/** Rows drawn at most (a repo with thousands of untracked files); the full Git view lists them all. */
const MAX_ROWS = 300;
/** Commit message per repo, kept across tab / conversation switches (not persisted). */
const drafts = new Map<string, string>();
/** The last open request (`useRightPanel().review.n`) the right panel's review applied: each is applied once, also
 *  across a remount (a request is not replayed when the tab is closed and opened again in workbench mode). */
let appliedIntent = 0;
/** The same for a phone's in-place 改动 view (`useRightPanel().inPlace.n`). */
let appliedPlace = 0;
/** Git 视图 in words the default UI uses (TERMS.worktree); the git words stay in the tooltip. */
const GIT_VIEW_LABEL = 'Git：分支、拉取推送、历史…';
const GIT_VIEW_TITLE = `完整的 Git 视图：分支、拉取 / 推送、提交历史、修改上一次提交、暂存区快照（stash）、${TERMS.worktree}`;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const lines = (t: string) => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** "message\n\n[kind] hint" (the hub's encoding of a GitCommandError) → its parts. */
function gitError(e: unknown): GitError {
  const msg = String((e as Error)?.message ?? e);
  const m = /^([\s\S]*?)\n\n\[(\w+)\] ([\s\S]*)$/.exec(msg);
  return m ? { kind: m[2] as GitError['kind'], message: m[1], hint: m[3] } : { kind: 'unknown', message: msg, hint: '' };
}

function statOf(row: ReviewRow, d: DiffResult | undefined): { added: number; removed: number } | null {
  if (row.patch) return row.patch.binary ? null : { added: row.patch.added, removed: row.patch.removed };
  if (d?.kind === 'diff') return unifiedStat(d.text);
  if (d?.kind === 'new') return { added: lines(d.text), removed: 0 };
  return null;
}

function tagOf(row: ReviewRow, scope: ReviewScope, inRepo: boolean): string | null {
  const p = row.patch;
  if (p) return p.status === 'added' ? '新增' : p.status === 'deleted' ? '删除' : p.status === 'renamed' ? `重命名自 ${p.from ?? ''}` : null;
  const g = row.git;
  if (!g) return scope === 'session' && inRepo ? '无改动' : null;
  if (g.status === 'conflict') return '冲突';
  if (g.status === 'untracked') return '新文件';
  if (g.status === 'added') return '新增';
  if (g.status === 'deleted') return '删除';
  if (g.status === 'renamed') return '重命名';
  if (scope !== 'staged' && g.staged && !g.unstaged) return '已暂存';
  if (scope !== 'staged' && g.staged && g.unstaged) return '部分暂存';
  return null;
}

function FileBody({ row, diff }: { row: ReviewRow; diff: DiffResult | undefined }) {
  const p = row.patch;
  if (p) {
    if (p.binary) return <div className="rv-note">二进制文件</div>;
    if (!/^@@/m.test(p.text)) return <div className="rv-note">{p.status === 'renamed' ? '只改了文件名' : '内容没有变化'}</div>;
    return <DiffView unified={p.text} collapse />;
  }
  if (!diff) return <div className="rv-note">读取中…</div>;
  switch (diff.kind) {
    case 'diff': return <DiffView unified={diff.text} collapse />;
    case 'new': return lines(diff.text) > MAX_LINES ? <div className="rv-note">新文件，共 {lines(diff.text)} 行，太长了不在这里逐行显示</div> : <DiffView oldText="" newText={diff.text} collapse={false} />;
    case 'content': return <><div className="rv-note">不在 git 仓库里，没有可以对比的版本：这是它现在的内容</div><pre className="rv-pre">{diff.text.slice(0, 20000)}</pre></>;
    case 'binary': return <div className="rv-note">二进制文件</div>;
    case 'error': return <div className="rv-note err">{diff.text}</div>;
    default: return <div className="rv-note">和上一次提交相同（已经提交或还原了）</div>;
  }
}

/**
 * 审阅 (redesign phase 2, spec §5.6 / mock-session.png): the conversation's changes as file cards with folding diffs.
 * A scope menu (未提交的改动 / 已暂存 / 本次对话改动 / 某次提交), 全部还原 / 全部暂存, per-file stage / revert / open,
 * and a commit box at the bottom. Everything else git — branches, pull / push, stash, worktrees, history, amend —
 * is the full Git view (GitView, unchanged) behind ···. It merges the old 文件改动 panel (the conversation scope)
 * and GitView's status / diff / stage / commit.
 * Git is asked only while it is on screen (`visible`): the repo is watched (`git.watch`, which also schedules a
 * background `git fetch` every 5 minutes on the server) the first time it is shown for that repo, never while the
 * panel is only mounted; events while hidden mark it stale for the next show.
 * `inDock`: the right panel's own copy — it takes the open requests (`right-panel.ts`) and publishes the tab's count.
 * `inPlace`: the phone's in-place 改动 view (starts on this conversation's changes).
 */
export function ReviewView({ visible, inPlace, inDock }: { visible: boolean; inPlace?: boolean; inDock?: boolean }) {
  const active = useScopedSession();
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const openTile = useStore((s) => s.openTile);
  const diffMode = useStore((s) => s.settings['ui.diffMode']);
  const setSetting = useStore((s) => s.setSetting);
  const sid = active?.sessionId ?? '';
  const cwd = active?.cwd ?? '';
  const peer = sessionPeer(sid || null, sessions);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [changed, setChanged] = useState<string[]>([]);
  const [scope, setScope] = useState<ReviewScope | null>(inPlace ? 'session' : null);
  const [rev, setRev] = useState<Pick<GitLogEntry, 'hash' | 'short' | 'subject'> & Partial<GitLogEntry> | null>(null);
  const [commitText, setCommitText] = useState<string | null>(null);
  const [log, setLog] = useState<GitLogEntry[] | null>(null);
  const [sub, setSub] = useState<'diff' | 'git'>('diff');
  const [gitMounted, setGitMounted] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, DiffResult>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [scopeMenu, setScopeMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<GitError | null>(null);
  const [gen, setGen] = useState(0);
  const [msg, setMsgState] = useState('');
  const stale = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const rootRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const root = status?.root ?? null;
  rootRef.current = root;
  // default: 未提交的改动 in a repo, the conversation's files elsewhere (a git scope asked for outside a repo too)
  const sc: ReviewScope = !scope ? (root ? 'uncommitted' : 'session') : loaded && !root && scope !== 'session' ? 'session' : scope;
  const scopeBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);

  /** reload now when on screen, else on the next show */
  const bump = () => { if (visibleRef.current) setGen((g) => g + 1); else stale.current = true; };
  useEffect(() => { if (visible && stale.current) { stale.current = false; setGen((g) => g + 1); } }, [visible]);

  // another conversation: its own scope, files and diffs (the commit draft is per repo and stays)
  useEffect(() => {
    setStatus(null); setLoaded(false); setChanged([]); setScope(inPlace ? 'session' : null); setRev(null); setCommitText(null); setLog(null);
    // (the Git view is another repo's now: dropped, not remounted hidden — it would run its git and watch the repo)
    setOpen({}); setDiffs({}); setErr(null); setSub('diff'); setGitMounted(false);
    fetched.current.clear();
    bump();
  }, [sid, cwd]);

  // a request from the 改动 button / header ··· / palette (each one once)
  const intent = useRightPanel((s) => s.review);
  useEffect(() => {
    if (!inDock || !intent || intent.n <= appliedIntent) return;
    appliedIntent = intent.n;
    if (intent.git) { setSub('git'); setGitMounted(true); return; }
    setSub('diff');
    if (intent.rev) { setScope('commit'); setRev({ hash: intent.rev, short: intent.rev.slice(0, 7), subject: '' }); }
    else if (intent.scope) setScope(intent.scope);
    if (intent.path) setFocus(intent.path);
  }, [intent?.n]);
  // a phone's change card (no right panel): only this conversation's in-place view takes it, once
  const placeReq = useRightPanel((s) => s.inPlace);
  useEffect(() => {
    if (!inPlace || !placeReq || placeReq.sessionId !== sid || placeReq.n <= appliedPlace) return;
    appliedPlace = placeReq.n;
    setSub('diff');
    setScope('session');
    if (placeReq.path) setFocus(placeReq.path);
  }, [placeReq?.n, sid]);

  // status + the conversation's files
  useEffect(() => {
    if (!gen || !cwd || peer) return;
    let alive = true;
    ws.request<GitStatus>({ kind: 'git.status', cwd })
      .then((s) => { if (alive) { setStatus(s); setLoaded(true); } })
      .catch(() => { if (alive) { setStatus(null); setLoaded(true); } });
    if (sid) ws.request<{ path: string }[]>({ kind: 'files.changed', sessionId: sid }).then((f) => alive && setChanged(f.map((x) => x.path))).catch(() => alive && setChanged([]));
    return () => { alive = false; };
  }, [gen]);

  // git / file events for this repo, and the conversation finishing a turn / an edit: refresh (coalesced — every
  // refresh is a few git processes on the server). The repo is watched once it is on screen, not before: a watch
  // is a file watcher plus a background `git fetch` every 5 minutes, for good.
  const watched = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !cwd || peer || watched.current === cwd) return;
    watched.current = cwd;
    void ws.request({ kind: 'git.watch', cwd }).catch(() => {});
  }, [visible, cwd, !!peer]);
  useEffect(() => {
    if (!cwd || peer) return;
    const soon = coalesce(bump, 600, 3000);
    const off = ws.on((e) => { if (gitEventConcerns(e, { cwd, root: rootRef.current })) soon.trigger(); });
    return () => { soon.cancel(); off(); };
  }, [cwd, !!peer]);
  // (counted only while on screen: the walk runs on every streamed event; a change made while hidden shows up as a
  // different signature on the next show)
  const editSig = useMemo(() => {
    if (!visible || !active) return null;
    let n = 0;
    for (const { tool } of walkTools(active.conv.items)) if (EDIT_TOOLS.has(tool.name) && tool.status === 'done') n++;
    return `${sid}|${active.conv.lastResult?.id ?? ''}|${n}`;
  }, [active?.version, visible, sid]);
  const lastSig = useRef<string | null>(null);
  useEffect(() => {
    if (editSig === null) return;
    const prev = lastSig.current;
    lastSig.current = editSig;
    if (prev && prev !== editSig && prev.split('|')[0] === sid) bump();
  }, [editSig]);

  // 某次提交: the commit's patch
  useEffect(() => {
    if (sc !== 'commit' || !rev || !root || !visible) return;
    let alive = true;
    setCommitText(null);
    ws.request<{ text: string; stat: string }>({ kind: 'git.show', cwd: root, rev: rev.hash }).then((r) => alive && setCommitText(r.text)).catch((e) => alive && setErr(gitError(e)));
    return () => { alive = false; };
  }, [sc, rev?.hash, root, visible && sc === 'commit']);
  const patches = useMemo(() => (commitText ? splitUnifiedByFile(commitText) : []), [commitText]);

  // the scope menu's recent commits: asked for each time it opens (also when the repo is known only after it opened)
  useEffect(() => {
    if (!scopeMenu || !root) return;
    let alive = true;
    ws.request<GitLogEntry[]>({ kind: 'git.log', cwd: root, n: 20 }).then((l) => alive && setLog(l)).catch(() => alive && setLog([]));
    return () => { alive = false; };
  }, [scopeMenu, root]);

  const rows = useMemo(() => reviewRows(sc, { status, changed, patches }), [sc, status, changed, patches]);
  const isOpen = (r: ReviewRow, i: number) => open[`${sc}|${r.key}`] ?? i < OPEN_FIRST;

  // the diffs: the first few (their numbers) and every open file — again whenever the list is reloaded. Each file
  // remembers which list it was fetched for and which request is the latest: an answer to an older request (or for
  // another conversation) never overwrites a newer one.
  const fetched = useRef(new Map<string, unknown>());
  const latest = useRef(new Map<string, number>());
  const sidRef = useRef(sid);
  sidRef.current = sid;
  useEffect(() => {
    // (not before the status: until then the scope is only a guess)
    if (!visible || !loaded || sc === 'commit') return;
    rows.forEach((r, i) => {
      if (i >= EAGER && !isOpen(r, i)) return;
      const k = `${sc}|${r.key}`;
      if (fetched.current.get(k) === rows) return;
      const req = diffRequest(r, sc, { root, sessionId: sid });
      if (!req) return;
      fetched.current.set(k, rows);
      const id = (latest.current.get(k) ?? 0) + 1;
      latest.current.set(k, id);
      const mine = sid;
      const put = (d: DiffResult) => { if (sidRef.current === mine && latest.current.get(k) === id) setDiffs((m) => ({ ...m, [k]: d })); };
      ws.request<DiffResult>(req).then(put).catch((e) => put({ kind: 'error', text: String(e?.message ?? e) }));
    });
  }, [rows, open, visible, loaded]);

  // 入门清单 「审阅一次改动」: a file with changes unfolded on screen (not merely the panel opened on nothing)
  useEffect(() => {
    if (!visible || !loaded) return;
    const seen = rows.slice(0, MAX_ROWS).some((r, i) => {
      if (!isOpen(r, i)) return false;
      const s = statOf(r, diffs[`${sc}|${r.key}`]);
      return !!s && (s.added > 0 || s.removed > 0);
    });
    if (seen) markChecklist('review');
  }, [visible, loaded, rows, diffs, open]);

  // the tab's number (the right panel's copy only)
  useEffect(() => {
    if (!inDock) return;
    useRightPanel.setState({ reviewCount: loaded ? rows.length : 0 });
  }, [rows.length, inDock, loaded]);
  useEffect(() => () => { if (inDock) useRightPanel.setState({ reviewCount: 0 }); }, []);

  // scroll to the file a request named (a file card in the conversation, phase 5)
  useEffect(() => {
    if (!focus || !rows.length) return;
    const r = rows.find((x) => samePath(x.abs, focus) || samePath(x.rel, focus));
    if (!r) return;
    setOpen((o) => ({ ...o, [`${sc}|${r.key}`]: true }));
    setFocus(null);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-key="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: 'start' }));
  }, [focus, rows]);

  // the commit draft follows the repo
  useEffect(() => { setMsgState(root ? drafts.get(root) ?? '' : ''); }, [root]);
  const setMsg = (v: string) => { setMsgState(v); if (root) drafts.set(root, v); };

  const counts = scopeCounts(status, changed.length);
  const targets = bulkTargets(rows);
  const plan = commitPlan(status);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setErr(null);
    try { await fn(); } catch (e) { setErr(gitError(e)); }
    setBusy(null);
    bump();
  };
  const stage = (files: string[]) => act('stage', () => ws.request({ kind: 'git.stage', cwd: root!, files }));
  const unstage = (files: string[]) => act('unstage', () => ws.request({ kind: 'git.unstage', cwd: root!, files }));
  // 还原 is `checkout HEAD` + deleting new files: the dialog names the files and what is lost, and 取消 has the focus
  const discard = async (files: string[]) => {
    if (!files.length) return;
    const c = discardConfirm(rows.filter((r) => files.includes(r.rel)), sc);
    if (!(await dlg.confirm(c.title, { message: c.message, items: c.items, danger: true, okLabel: c.okLabel, focusCancel: true }))) return;
    await act('discard', () => ws.request({ kind: 'git.discard', cwd: root!, files }));
  };
  const commit = async () => {
    if (!root || (plan.kind !== 'commit' && plan.kind !== 'stageAll')) return;
    if (!msg.trim()) { toast('先写一句提交说明'); return; }
    if (plan.kind === 'stageAll') {
      const q = stageAllConfirm(plan);
      if (!(await dlg.confirm(q.title, { message: q.message, items: q.items, okLabel: q.okLabel }))) return;
    }
    await act('commit', async () => {
      // the same files 全部暂存 takes (never a conflicted one), not `git add -A`
      if (plan.kind === 'stageAll') await ws.request({ kind: 'git.stage', cwd: root, files: plan.stage });
      await ws.request({ kind: 'git.commit', cwd: root, message: msg });
      setMsg('');
      toast('已提交', true);
    });
  };
  const openGit = () => { setSub('git'); setGitMounted(true); };
  const openFile = (r: ReviewRow) => openTile({ id: `d${Date.now().toString(36)}`, kind: 'doc', path: r.abs }, 'tab');
  const pickScope = (s: ReviewScope) => { setScope(s); setScopeMenu(false); setErr(null); };
  const toggleScopeMenu = () => setScopeMenu(!scopeMenu);
  const closeScope = useCallback((refocus: boolean) => { setScopeMenu(false); if (refocus) scopeBtn.current?.focus(); }, []);
  const closeMore = useCallback((refocus: boolean) => { setMoreMenu(false); if (refocus) moreBtn.current?.focus(); }, []);
  const setAll = (v: boolean) => setOpen((o) => { const n = { ...o }; for (const r of rows) n[`${sc}|${r.key}`] = v; return n; });

  if (!active) return <EmptyState e={EMPTY.reviewNoChat} />;
  if (peer) return <div className="empty">这个对话在机器「{peer.name}」上，它的改动要在那台机器上审阅。</div>;

  // (before the status arrives the default scope is only a guess: say so instead of showing one and jumping)
  const scopeLabel = !scope && !loaded ? '读取中…' : sc === 'commit' && rev ? `提交 ${rev.short}` : SCOPE_LABEL[sc];
  const empty =
    !loaded ? '读取中…'
    : sc === 'uncommitted' ? emptyText(EMPTY.reviewUncommitted)
    : sc === 'staged' ? emptyText(EMPTY.reviewStaged)
    : sc === 'session' ? emptyText(EMPTY.reviewSession)
    : !rev ? '从左上角的范围菜单里选一次提交。'
    : commitText === null ? '读取中…' : '这次提交没有改动文件。';

  return (
    <div className={clsx('review', inPlace && 'in-place')}>
      <div className="rv-git" hidden={sub !== 'git'}>
        <div className="rv-bar">
          <button className="btn sm ghost" onClick={() => setSub('diff')} title="回到审阅"><Icon name="restore" size={13} /> 审阅</button>
          <span className="rv-sub-title" title={GIT_VIEW_TITLE}>{GIT_VIEW_LABEL.replace('…', '')}</span>
        </div>
        {gitMounted && root && <div className="rv-git-body"><GitView cwd={cwd} visible={visible && sub === 'git'} /></div>}
        {gitMounted && !root && <div className="empty">{loaded ? `${cwd} 不是 git 仓库。` : '读取中…'}</div>}
      </div>
      <div className="rv-main" hidden={sub !== 'diff'}>
        <div className="rv-bar">
          <button ref={scopeBtn} className={clsx('rv-scope', scopeMenu && 'on')} onClick={toggleScopeMenu} aria-haspopup="menu" aria-expanded={scopeMenu} title="要看哪些改动">
            <span className="t">{scopeLabel}</span><Icon name="chevronDown" size={12} />
          </button>
          {scopeMenu && <Popover anchor={scopeBtn} onClose={closeScope} prefer="down" align="left" className="rv-scope-menu" label="审阅范围">
            {root && <button role="menuitemradio" data-mi aria-checked={sc === 'uncommitted'} onClick={() => pickScope('uncommitted')}><span className="grow">{SCOPE_LABEL.uncommitted}</span><span className="n">{counts.uncommitted}</span><span className="ck">{sc === 'uncommitted' && <Icon name="check" size={13} />}</span></button>}
            {root && <button role="menuitemradio" data-mi aria-checked={sc === 'staged'} onClick={() => pickScope('staged')}><span className="grow">{SCOPE_LABEL.staged}</span><span className="n">{counts.staged}</span><span className="ck">{sc === 'staged' && <Icon name="check" size={13} />}</span></button>}
            <button role="menuitemradio" data-mi aria-checked={sc === 'session'} onClick={() => pickScope('session')}><span className="grow">{SCOPE_LABEL.session}</span><span className="n">{counts.session}</span><span className="ck">{sc === 'session' && <Icon name="check" size={13} />}</span></button>
            {root && <div className="menu-label">某次提交</div>}
            {root && log === null && <div className="rv-menu-note">读取中…</div>}
            {root && log?.map((c) => (
              <button key={c.hash} role="menuitemradio" data-mi aria-checked={sc === 'commit' && rev?.hash === c.hash} className="rv-commit-item" title={`${c.hash}\n${c.author} · ${new Date(c.date).toLocaleString()}`} onClick={() => { setRev(c); pickScope('commit'); }}>
                <span className="mono h">{c.short}</span><span className="grow s">{c.subject}</span><span className="n">{ago(c.date)}</span><span className="ck">{sc === 'commit' && rev?.hash === c.hash && <Icon name="check" size={13} />}</span>
              </button>
            ))}
            {root && log?.length === 0 && <div className="rv-menu-note">还没有提交</div>}
          </Popover>}
          <span className="grow" />
          {/* 全部还原 only over the whole working tree: in 本次对话改动 it would also drop changes this conversation did
              not make (a checkout takes the whole file back) — there each file has its own 还原, with its own warning */}
          {root && sc === 'uncommitted' && <button className="btn sm ghost" disabled={!!busy || !targets.discard.length} onClick={() => discard(targets.discard)} title="把这些文件恢复成上一次提交的样子：已暂存的改动也会丢掉，新文件会被永久删除">全部还原</button>}
          {root && (sc === 'uncommitted' || sc === 'session') && <button className="btn sm" disabled={!!busy || !targets.stage.length} onClick={() => stage(targets.stage)} title="把这些改动加入下一次提交（有冲突的文件除外）">全部暂存</button>}
          {root && sc === 'staged' && <button className="btn sm" disabled={!!busy || !targets.unstage.length} onClick={() => unstage(targets.unstage)}>全部取消暂存</button>}
          {root && sc === 'commit' && rev && <button className="btn sm ghost" onClick={() => openTile({ id: `c${Date.now().toString(36)}`, kind: 'diff', sessionId: '', path: rev.hash, rev: rev.hash, cwd: root, title: `${rev.short} ${rev.subject.slice(0, 30)}` }, 'tab')} title="在一个标签页里打开整个提交">在标签页打开</button>}
          <button ref={moreBtn} className={clsx('icon-btn', moreMenu && 'active')} aria-label="更多审阅操作" title="Git 视图（分支、拉取推送、历史…）、展开折叠、diff 显示方式" aria-haspopup="menu" aria-expanded={moreMenu} onClick={() => setMoreMenu(!moreMenu)}><Icon name="more" size={16} /></button>
          {moreMenu && <Popover anchor={moreBtn} onClose={closeMore} prefer="down" align="right" className="rv-more-menu" label="更多审阅操作">
            <div onClick={() => setMoreMenu(false)}>
              <button role="menuitem" data-mi onClick={openGit} disabled={!root} title={GIT_VIEW_TITLE}><Icon name="branch" size={14} /> <span className="grow">{GIT_VIEW_LABEL}</span></button>
              <div className="menu-sep" />
              <button role="menuitem" data-mi onClick={() => setAll(true)} disabled={!rows.length}><Icon name="chevronDown" size={14} /> 全部展开</button>
              <button role="menuitem" data-mi onClick={() => setAll(false)} disabled={!rows.length}><Icon name="chevronRight" size={14} /> 全部折叠</button>
              <button role="menuitem" data-mi onClick={() => void setSetting('ui.diffMode', diffMode === 'split' ? 'unified' : 'split')}><Icon name="diff" size={14} /> {diffMode === 'split' ? '改成上下对照' : '改成左右并排'}</button>
              <button role="menuitem" data-mi onClick={bump}><Icon name="refresh" size={14} /> 刷新</button>
            </div>
          </Popover>}
        </div>
        {err && (
          <div className="git-error rv-err">
            <div className="msg">{err.message}</div>
            {err.hint && <div className="hint">{err.hint}</div>}
            <span className="row-btns"><button className="btn sm" onClick={openGit}>在 Git 视图里处理</button><button className="btn sm ghost" onClick={() => setErr(null)}>知道了</button></span>
          </div>
        )}
        {sc === 'commit' && rev && (
          <div className="rv-commit" title={rev.hash}>
            <span className="mono">{rev.short}</span> <span className="s">{rev.subject}</span>
            {rev.author && <span className="sub"> · {rev.author} · {ago(rev.date)}</span>}
          </div>
        )}
        <div className="rv-list" ref={listRef}>
          {rows.slice(0, MAX_ROWS).map((r, i) => {
            const k = `${sc}|${r.key}`;
            const d = diffs[k];
            const on = isOpen(r, i);
            const stat = statOf(r, d);
            const tag = tagOf(r, sc, !!root);
            const { dir, name } = splitPath(r.rel);
            const one = bulkTargets([r]);
            return (
              <div key={k} className={clsx('rv-file', on && 'open')} data-key={r.key}>
                <div className="rv-fh" role="button" tabIndex={0} aria-expanded={on} onClick={() => setOpen((o) => ({ ...o, [k]: !on }))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => ({ ...o, [k]: !on })); } }} title={r.abs}>
                  <span className="cv"><Icon name={on ? 'chevronDown' : 'chevronRight'} size={13} /></span>
                  <span className="p"><span className="d">{dir}</span>{name}</span>
                  {stat && (stat.added > 0 || stat.removed > 0) && <span className="rv-stat"><span className="add">+{stat.added}</span> <span className="del">−{stat.removed}</span></span>}
                  {tag && <span className={clsx('rv-tag', tag === '冲突' && 'warn')}>{tag}</span>}
                  <span className="grow" />
                  <span className="rv-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {root && sc !== 'commit' && one.stage.length > 0 && <button className="icon-btn xs" title="暂存（加入下一次提交）" aria-label={`暂存 ${r.rel}`} disabled={!!busy} onClick={() => stage(one.stage)}><Icon name="plus" size={13} /></button>}
                    {root && sc !== 'commit' && !one.stage.length && one.unstage.length > 0 && <button className="icon-btn xs" title="取消暂存" aria-label={`取消暂存 ${r.rel}`} disabled={!!busy} onClick={() => unstage(one.unstage)}><Icon name="minus" size={13} /></button>}
                    {root && sc !== 'commit' && sc !== 'staged' && one.discard.length > 0 && <button className="icon-btn xs" title="还原（丢弃这个文件的改动）" aria-label={`还原 ${r.rel}`} disabled={!!busy} onClick={() => discard(one.discard)}><Icon name="undo" size={13} /></button>}
                    {!(r.patch?.status === 'deleted' || r.git?.status === 'deleted') && <button className="icon-btn xs" title="在编辑器打开" aria-label={`打开 ${r.rel}`} onClick={() => openFile(r)}><Icon name="external" size={13} /></button>}
                  </span>
                </div>
                {on && <div className="rv-body"><FileBody row={r} diff={d} /></div>}
              </div>
            );
          })}
          {rows.length > MAX_ROWS && <div className="rv-note">还有 {rows.length - MAX_ROWS} 个文件没有列出来：在 ··· →「Git」里可以看到全部。</div>}
          {!rows.length && <div className="empty">{empty}</div>}
        </div>
        {root && sc !== 'commit' && plan.kind === 'conflicts' && (
          <div className="rv-foot-note">
            <Icon name="alert" size={13} />
            <span className="grow">有 {plan.conflicts} 个冲突文件：先在 Git 视图里解决，再回来提交。</span>
            <button className="btn sm ghost" onClick={openGit}>打开 Git 视图</button>
          </div>
        )}
        {root && sc !== 'commit' && (
          <div className="rv-foot">
            {/* several lines like the Git view's box: Enter is a new line, Ctrl+Enter commits */}
            <textarea
              className="field"
              rows={1}
              placeholder={plan.kind === 'none' ? '没有可以提交的改动' : plan.kind === 'conflicts' ? '有冲突的文件解决之后才能提交' : `提交说明…（${modKey}+Enter 提交）`}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void commit(); } }}
              disabled={plan.kind === 'none'}
              aria-label="提交说明"
            />
            <button className="btn primary sm" disabled={!!busy || (plan.kind !== 'commit' && plan.kind !== 'stageAll') || !msg.trim()} onClick={() => void commit()} title={plan.kind === 'stageAll' ? `还没有暂存的改动：会先问你要不要把 ${plan.stage.length} 个文件暂存` : plan.kind === 'conflicts' ? '有冲突的文件：先在 Git 视图里解决' : `提交已暂存的改动（${plan.staged} 个文件）`}>{busy === 'commit' ? '提交中…' : '提交'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
