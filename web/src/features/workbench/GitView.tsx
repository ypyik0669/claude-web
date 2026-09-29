import { useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { ago, basename, clsx } from '@/util';
import type { GitBranch, GitError, GitFileStatus, GitLogEntry, GitStatus, GitWorktree } from '@shared';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { useDropdown } from '@/ui/menus';

const STATUS_LABEL: Record<GitFileStatus['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!', typechange: 'T' };

/** Parse the hub's error string back into a GitError when the server threw a GitCommandError. */
function gitErr(e: any): GitError {
  const msg = String(e?.message ?? e);
  return { kind: 'unknown', message: msg, hint: '' };
}

function ErrorCard({ err, onFix }: { err: GitError & { action?: { label: string; run: () => void } }; onFix?: () => void }) {
  return (
    <div className="git-error">
      <div className="msg">{err.message}</div>
      {err.hint && <div className="hint">{err.hint}</div>}
      {err.action && <button className="btn sm" onClick={() => { err.action!.run(); onFix?.(); }}>{err.action.label}</button>}
    </div>
  );
}

function FileRows({ files, staged, cwd, root, onOpen }: { files: GitFileStatus[]; staged: boolean; cwd: string; root: string; onOpen: (f: GitFileStatus, staged: boolean) => void }) {
  const toast = useStore((s) => s.toast);
  const act = (kind: 'git.stage' | 'git.unstage' | 'git.discard', f: GitFileStatus) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (kind === 'git.discard' && !(await dlg.confirm(`丢弃对 ${f.path} 的改动？`, { message: '不可恢复。', danger: true }))) return;
    await ws.request({ kind, cwd, files: [f.path] } as any).catch((x: any) => toast(x.message));
  };
  return (
    <>
      {files.map((f) => (
        <div key={f.path} className={clsx('git-file', `st-${f.status}`)} onClick={() => onOpen(f, staged)} title={f.path}>
          <span className="st">{STATUS_LABEL[f.status]}</span>
          <span className="name">{basename(f.path)}</span>
          <span className="dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
          <span className="acts">
            {staged ? <button title="取消暂存" aria-label="取消暂存" onClick={act('git.unstage', f)}>−</button> : <button title="暂存" aria-label="暂存" onClick={act('git.stage', f)}><Icon name="plus" size={12} /></button>}
            {!staged && <button title="丢弃改动" aria-label="丢弃改动" onClick={act('git.discard', f)}><Icon name="refresh" size={12} /></button>}
            <button title="在编辑器打开" aria-label="在编辑器打开" onClick={(e) => { e.stopPropagation(); useStore.getState().openTile({ id: `d${Date.now()}`, kind: 'doc', path: `${root}\\${f.path.replace(/\//g, '\\')}` }, 'tab'); }}><Icon name="edit" size={12} /></button>
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * Source control view for one working directory: branch / sync / changes / commit / log / worktrees / stash.
 * `visible` (default true): kept mounted but out of sight (审阅's Git view behind the diff list, a hidden right panel)
 * it runs no git — events only mark it stale for the next show — and the repo is watched once it is first shown.
 */
export function GitView({ cwd, visible = true }: { cwd: string; visible?: boolean }) {
  const toast = useStore((s) => s.toast);
  const openTile = useStore((s) => s.openTile);
  const [st, setSt] = useState<GitStatus | null>(null);
  const [err, setErr] = useState<(GitError & { action?: { label: string; run: () => void } }) | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [wts, setWts] = useState<GitWorktree[]>([]);
  const [msg, setMsg] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [branchMenu, setBranchMenu] = useState(false);
  const branchBox = useRef<HTMLSpanElement>(null);
  // one anchored menu app-wide (polish P2): also closes on a click outside, Esc, another menu opening
  useDropdown(branchMenu, () => setBranchMenu(false), branchBox);
  const [bq, setBq] = useState('');
  const [tab, setTab] = useState<'changes' | 'log' | 'worktrees'>('changes');
  const [newWt, setNewWt] = useState<{ name: string; from: string } | null>(null);

  const refresh = async () => {
    try {
      const s = await ws.request<GitStatus>({ kind: 'git.status', cwd });
      setSt(s);
      if (s.root) {
        void ws.request<GitLogEntry[]>({ kind: 'git.log', cwd, n: 30 }).then(setLog).catch(() => setLog([]));
        void ws.request<GitBranch[]>({ kind: 'git.branches', cwd }).then(setBranches).catch(() => setBranches([]));
        void ws.request<GitWorktree[]>({ kind: 'git.worktrees', cwd }).then(setWts).catch(() => setWts([]));
      }
    } catch (e: any) { setErr(gitErr(e)); }
  };
  const visRef = useRef(visible);
  visRef.current = visible;
  const stale = useRef(false);
  const watched = useRef<string | null>(null);
  // on screen: load now; out of sight: load on the next show
  const load = () => { if (visRef.current) { stale.current = false; void refresh(); } else stale.current = true; };
  useEffect(() => {
    load();
    const off = ws.on((e) => { if (e.kind === 'git.changed' && (st?.root ? e.cwd.toLowerCase() === st.root.toLowerCase() : true)) load(); });
    return () => { off(); };
  }, [cwd, st?.root]);
  useEffect(() => {
    if (!visible) return;
    if (stale.current) { stale.current = false; void refresh(); }
    if (watched.current !== cwd) { watched.current = cwd; void ws.request({ kind: 'git.watch', cwd }).catch(() => {}); }
  }, [visible, cwd]);

  const run = async (label: string, req: any, opts: { fixFor?: (e: GitError) => { label: string; run: () => void } | undefined; then?: (r: any) => void } = {}) => {
    setBusy(label); setErr(null);
    try {
      const r = await ws.request<any>(req);
      opts.then?.(r);
      await refresh();
    } catch (e: any) {
      const ge = gitErr(e);
      // the server embeds kind/hint in the message as "message\n\n[kind] hint" — parse them back
      const m = /^([\s\S]*?)\n\n\[(\w+)\] ([\s\S]*)$/.exec(ge.message);
      const parsed: GitError = m ? { kind: m[2] as any, message: m[1], hint: m[3] } : ge;
      setErr({ ...parsed, action: opts.fixFor?.(parsed) ?? defaultFix(parsed) });
    }
    setBusy(null);
  };
  const defaultFix = (e: GitError): { label: string; run: () => void } | undefined => {
    switch (e.kind) {
      case 'no_upstream': return { label: '推送并设置上游', run: () => void run('push', { kind: 'git.push', cwd, setUpstream: true }) };
      case 'rejected': return { label: '先拉取（rebase）再推送', run: () => void run('pull', { kind: 'git.pull', cwd, rebase: true }, { then: () => void run('push', { kind: 'git.push', cwd }) }) };
      case 'dirty': return { label: 'Stash 后重试', run: () => void run('stash', { kind: 'git.stash', cwd, op: 'push', message: 'claude-web auto stash' }) };
      case 'nothing_to_commit': return { label: '暂存全部改动', run: () => void run('stage', { kind: 'git.stage', cwd, files: 'all' }) };
      case 'identity': return { label: '在终端配置身份', run: () => useStore.getState().openTile({ id: `t${Date.now()}`, kind: 'term', cwd }, 'tab') };
      case 'conflict': return { label: '打开终端处理冲突', run: () => useStore.getState().openTile({ id: `t${Date.now()}`, kind: 'term', cwd }, 'tab') };
      case 'auth': case 'network': return { label: '在终端重试', run: () => useStore.getState().openTile({ id: `t${Date.now()}`, kind: 'term', cwd }, 'tab') };
      default: return undefined;
    }
  };

  const openDiff = (f: GitFileStatus, staged: boolean) => {
    const abs = `${st!.root}${st!.root!.includes('\\') ? '\\' : '/'}${f.path.replace(/\//g, st!.root!.includes('\\') ? '\\' : '/')}`;
    openTile({ id: `df${Date.now().toString(36)}`, kind: 'diff', sessionId: '', path: abs, staged, cwd: st!.root!, title: `${staged ? '已暂存 · ' : ''}${basename(f.path)}` }, 'tab');
  };
  const commit = async () => {
    if (!msg.trim() && !amend) return toast('请输入提交信息');
    await run('commit', { kind: 'git.commit', cwd, message: msg, amend }, { then: () => { setMsg(''); setAmend(false); toast('已提交', true); } });
  };

  const staged = useMemo(() => st?.files.filter((f) => f.staged) ?? [], [st]);
  const unstaged = useMemo(() => st?.files.filter((f) => f.unstaged && f.status !== 'untracked') ?? [], [st]);
  const untracked = useMemo(() => st?.files.filter((f) => f.status === 'untracked') ?? [], [st]);
  const filteredBranches = branches.filter((b) => !bq || b.name.toLowerCase().includes(bq.toLowerCase()));

  if (!st) return <div className="empty">{err ? <ErrorCard err={err} /> : '读取仓库…'}</div>;
  if (!st.root)
    return (
      <div className="empty" style={{ flexDirection: 'column', gap: 8 }}>
        <div>{cwd} 不是 git 仓库。</div>
        <button className="btn sm" onClick={() => useStore.getState().openTile({ id: `t${Date.now()}`, kind: 'term', cwd }, 'tab')}>打开终端执行 git init</button>
      </div>
    );

  return (
    <div className="git-view">
      <div className="git-head">
        <span ref={branchBox} style={{ position: 'relative' }}>
          <button className="branch" onClick={() => setBranchMenu(!branchMenu)} title="切换分支" aria-haspopup="menu" aria-expanded={branchMenu}>
            <Icon name="branch" size={13} /> {st.detached ? `HEAD 分离 ${log[0]?.short ?? ''}` : st.branch}
            {st.state !== 'clean' && st.state !== 'detached' && <span className="badge err">{st.state}</span>}
          </button>
          {branchMenu && (
            <div className="menu branch-menu" onMouseLeave={() => setBranchMenu(false)}>
              <input className="field" autoFocus placeholder="筛选或新建分支名…" value={bq} onChange={(e) => setBq(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && bq.trim() && !branches.some((b) => b.name === bq.trim())) { setBranchMenu(false); void run('checkout', { kind: 'git.checkout', cwd, name: bq.trim(), create: true }); } }} />
              {bq.trim() && !branches.some((b) => b.name === bq.trim()) && <button onClick={() => { setBranchMenu(false); void run('checkout', { kind: 'git.checkout', cwd, name: bq.trim(), create: true }); }}><Icon name="plus" size={12} /> 新建分支「{bq.trim()}」</button>}
              <div className="list">
                {filteredBranches.slice(0, 60).map((b) => (
                  <button key={b.name} className={clsx(b.current && 'cur')} onClick={() => { setBranchMenu(false); if (!b.current) void run('checkout', { kind: 'git.checkout', cwd, name: b.remote ? b.name.replace(/^[^/]+\//, '') : b.name, create: b.remote && !branches.some((x) => !x.remote && x.name === b.name.replace(/^[^/]+\//, '')), from: b.remote ? b.name : undefined }); }}>
                    <span className="grow">{b.remote && <Icon name="cloud" size={12} />} {b.name}</span>
                    <span className="muted">{ago(b.date)}</span>
                    {!b.current && !b.remote && <span className="x" title="删除分支" onClick={async (e) => { e.stopPropagation(); if (await dlg.confirm(`删除分支 ${b.name}？`, { danger: true })) void run('branch', { kind: 'git.deleteBranch', cwd, name: b.name }); }}><Icon name="close" size={11} /></span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </span>
        <span className="sync muted" title={st.upstream ? `上游 ${st.upstream}` : '没有上游分支'}>
          {st.upstream ? <>↑{st.ahead} ↓{st.behind}</> : '无上游'}
        </span>
        <span className="grow" />
        <button className="icon-btn" title="Fetch" disabled={!!busy} onClick={() => run('fetch', { kind: 'git.fetch', cwd })} aria-label="Fetch">{busy === 'fetch' ? '…' : <Icon name="refresh" size={14} />}</button>
        <button className="btn sm ghost" disabled={!!busy} onClick={() => run('pull', { kind: 'git.pull', cwd, rebase: true })}>{busy === 'pull' ? '拉取中…' : <><Icon name="chevronDown" size={12} /> 拉取</>}</button>
        <button className="btn sm ghost" disabled={!!busy} onClick={() => run('push', { kind: 'git.push', cwd, setUpstream: !st.upstream })}>{busy === 'push' ? '推送中…' : `↑ 推送${st.upstream ? '' : ' (-u)'}`}</button>
        <button className="icon-btn" title={`Stash（当前 ${st.stashes} 个）`} onClick={async () => { if (!st.stashes) return run('stash', { kind: 'git.stash', cwd, op: 'push' }); if (await dlg.confirm('弹出最近的 stash？')) void run('stash', { kind: 'git.stash', cwd, op: 'pop' }); }} aria-label="Stash">{st.stashes ? <><Icon name="archive" size={13} /> {st.stashes}</> : <Icon name="archive" size={13} />}</button>
      </div>
      {err && <ErrorCard err={err} onFix={() => setErr(null)} />}
      <div className="subtabs">
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>改动 {st.files.length ? <span className="badge">{st.files.length}</span> : null}</button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>历史</button>
        <button className={tab === 'worktrees' ? 'active' : ''} onClick={() => setTab('worktrees')} title="git worktree">独立副本 {wts.length > 1 ? <span className="badge">{wts.length}</span> : null}</button>
      </div>
      {tab === 'changes' && (
        <div className="git-body">
          <div className="commit-box">
            <textarea className="field" placeholder={amend ? '修改上一次提交（留空沿用原信息）' : '提交信息（Ctrl+Enter 提交）'} value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void commit(); }} rows={3} />
            <div className="row">
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> amend</label>
              <span className="grow" />
              <button className="btn sm ghost" disabled={!unstaged.length && !untracked.length} onClick={() => run('stage', { kind: 'git.stage', cwd, files: 'all' })}>全部暂存</button>
              <button className="btn sm primary" disabled={!!busy || (!staged.length && !amend)} onClick={commit}>{busy === 'commit' ? '提交中…' : `提交${staged.length ? ` (${staged.length})` : ''}`}</button>
            </div>
          </div>
          {staged.length > 0 && (
            <div className="git-group">
              <div className="gh"><b>已暂存</b><span className="badge">{staged.length}</span><span className="grow" /><button className="link" onClick={() => run('unstage', { kind: 'git.unstage', cwd, files: 'all' })}>全部取消</button></div>
              <FileRows files={staged} staged cwd={cwd} root={st.root} onOpen={openDiff} />
            </div>
          )}
          {unstaged.length > 0 && (
            <div className="git-group">
              <div className="gh"><b>改动</b><span className="badge">{unstaged.length}</span><span className="grow" /><button className="link" onClick={() => run('stage', { kind: 'git.stage', cwd, files: unstaged.map((f) => f.path) })}>全部暂存</button></div>
              <FileRows files={unstaged} staged={false} cwd={cwd} root={st.root} onOpen={openDiff} />
            </div>
          )}
          {untracked.length > 0 && (
            <div className="git-group">
              <div className="gh"><b>未跟踪</b><span className="badge">{untracked.length}</span><span className="grow" /><button className="link" onClick={() => run('stage', { kind: 'git.stage', cwd, files: untracked.map((f) => f.path) })}>全部暂存</button></div>
              <FileRows files={untracked} staged={false} cwd={cwd} root={st.root} onOpen={openDiff} />
            </div>
          )}
          {!st.files.length && <div className="empty">工作区干净</div>}
        </div>
      )}
      {tab === 'log' && (
        <div className="git-body list">
          {log.map((c) => (
            <div key={c.hash} className="row clickable" onClick={() => openTile({ id: `c${Date.now().toString(36)}`, kind: 'diff', sessionId: '', path: c.hash, rev: c.hash, cwd: st.root!, title: `${c.short} ${c.subject.slice(0, 30)}` }, 'tab')} title={`${c.hash}\n${c.author} <${c.email}>`}>
              <span className="mono muted">{c.short}</span>
              <div className="grow">
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject} {c.refs.map((r) => <span key={r} className="badge" style={{ marginLeft: 4 }}>{r.replace('HEAD -> ', '')}</span>)}</div>
                <div className="sub">{c.author} · {ago(c.date)}</div>
              </div>
              <button className="icon-btn" title="复制 hash" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(c.hash); }} aria-label="复制 hash"><Icon name="copy" size={12} /></button>
            </div>
          ))}
          {!log.length && <div className="empty">还没有提交</div>}
        </div>
      )}
      {tab === 'worktrees' && (
        <div className="git-body list">
          {wts.map((w) => (
            <div key={w.path} className="row" title={w.path}>
              <span><Icon name={w.main ? 'folder' : 'branch'} size={13} /></span>
              <div className="grow">
                <div>{w.branch ?? `(分离 ${w.head})`} {w.locked && <span className="badge">locked</span>}</div>
                <div className="sub">{w.path}</div>
              </div>
              <button className="btn sm ghost" onClick={() => useStore.getState().openSession({ cwd: w.path })}><Icon name="plus" size={12} /> 对话</button>
              <button className="btn sm ghost" onClick={() => ws.request({ kind: 'shell.open', path: w.path, app: 'code' })}>VS Code</button>
              {!w.main && <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(`删除独立副本 ${w.path}？`, { message: '分支保留，目录会被删除。', danger: true })) void run('wt', { kind: 'git.worktreeRemove', cwd, dir: w.path, force: true }); }} aria-label="删除独立副本" title="git worktree remove"><Icon name="trash" size={12} /></button>}
            </div>
          ))}
          {newWt ? (
            <div className="row" style={{ gap: 6 }}>
              <input className="field" placeholder="名称 / 分支" value={newWt.name} onChange={(e) => setNewWt({ ...newWt, name: e.target.value })} autoFocus />
              <input className="field" placeholder="基于（默认当前 HEAD）" value={newWt.from} onChange={(e) => setNewWt({ ...newWt, from: e.target.value })} />
              <button className="btn sm primary" disabled={!newWt.name.trim()} onClick={() => { const n = newWt; setNewWt(null); void run('wt', { kind: 'git.worktreeAdd', cwd, name: n.name.trim(), from: n.from.trim() || undefined }, { then: (w: GitWorktree) => toast(`已创建 ${w.path}`, true) }); }}>创建</button>
              <button className="btn sm" onClick={() => setNewWt(null)}>取消</button>
            </div>
          ) : (
            <div className="row"><button className="btn sm" onClick={() => setNewWt({ name: '', from: '' })} title="放在 .claude/worktrees/<名称>，和 Claude Code 的 --worktree 一致"><Icon name="plus" size={12} /> 新建独立副本</button><span className="muted" style={{ fontSize: 11.5 }}>仓库的另一份检出，在自己的分支上改，不动当前目录</span></div>
          )}
        </div>
      )}
    </div>
  );
}
