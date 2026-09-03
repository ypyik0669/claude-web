import { useEffect, useMemo, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import { Markdown } from '@/features/chat/Markdown';
import type { VcsDetail, VcsItem, VcsRepo } from '@shared';

type Mode = 'issues' | 'pulls';
const ago = (iso: string) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 3600 ? `${Math.max(1, Math.floor(s / 60))} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`; };
const REVIEW_L: Record<string, string> = { approved: '已批准', changes_requested: '需修改', review_required: '待审', '': '' };
const CHECK_IC: Record<string, string> = { success: '✓', failure: '✗', pending: '◌', none: '' };

function Card({ it, active, onClick }: { it: VcsItem; active: boolean; onClick: () => void }) {
  return (
    <div className={clsx('vcs-card', active && 'active', it.state)} onClick={onClick}>
      <div className="t"><span className="num">#{it.number}</span> {it.draft && <span className="badge">草稿</span>} {it.title}</div>
      <div className="m">
        <span>{it.author}</span><span>·</span><span>{ago(it.updatedAt)}</span>
        {it.comments > 0 && <span>· 💬 {it.comments}</span>}
        {it.isPr && it.checks && it.checks !== 'none' && <span className={clsx('chk', it.checks)}>{CHECK_IC[it.checks]}</span>}
        {it.isPr && it.reviewDecision && <span className={clsx('rv', it.reviewDecision)}>{REVIEW_L[it.reviewDecision] ?? it.reviewDecision}</span>}
        {it.isPr && it.additions !== undefined && <span className="mono"><span style={{ color: 'var(--green)' }}>+{it.additions}</span> <span style={{ color: 'var(--red)' }}>−{it.deletions}</span></span>}
      </div>
      {it.labels.length > 0 && <div className="labels">{it.labels.map((l) => <span key={l.name} className="lbl" style={l.color ? { borderColor: `#${l.color}`, color: `#${l.color}` } : undefined}>{l.name}</span>)}</div>}
      {it.assignees.length > 0 && <div className="m">指派 {it.assignees.join(', ')}</div>}
    </div>
  );
}

/** GitHub / GitLab issues & PR/MR board for the session's repo: columns, detail drawer, actions, hand-off to Claude. */
export function BoardView({ cwd, sid }: { cwd: string; sid: string | null }) {
  const toast = useStore((s) => s.toast);
  const send = useStore((s) => s.send);
  const openSession = useStore((s) => s.openSession);
  const [repoOverride, setRepoOverride] = useState(() => localStorage.getItem(`cw.board.repo:${cwd}`) ?? '');
  const [repo, setRepo] = useState<VcsRepo | null>(null);
  const [mode, setMode] = useState<Mode>('pulls');
  const [state, setState] = useState<'open' | 'closed' | 'merged' | 'all'>('open');
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<VcsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<VcsDetail | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const r = repoOverride || undefined;

  const loadRepo = () => ws.request<VcsRepo>({ kind: 'vcs.repo', cwd, repo: r }).then((x) => { setRepo(x); setErr(x.error); }).catch((e) => { setRepo(null); setErr(e.message); });
  const load = () => {
    setLoading(true); setErr('');
    const p = mode === 'issues' ? ws.request<VcsItem[]>({ kind: 'vcs.issues', cwd, repo: r, state: state === 'merged' ? 'closed' : state, q: q || undefined, mine }) : ws.request<VcsItem[]>({ kind: 'vcs.pulls', cwd, repo: r, state });
    p.then(setItems).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => { void loadRepo(); }, [cwd, repoOverride]);
  useEffect(() => { if (repo?.authOk) load(); }, [repo?.authOk, mode, state, mine, repoOverride]);
  useEffect(() => { if (sel === null) { setDetail(null); return; } setDetail(null); ws.request<VcsDetail>({ kind: 'vcs.item', cwd, repo: r, number: sel, isPr: mode === 'pulls' }).then(setDetail).catch((e) => toast(e.message)); }, [sel]);

  const columns = useMemo(() => {
    if (mode === 'issues') {
      const by = (f: (i: VcsItem) => boolean, l: string) => ({ l, items: items.filter(f) });
      return state === 'open' ? [by((i) => i.assignees.length === 0, '待认领'), by((i) => i.assignees.length > 0, '进行中')] : [by(() => true, state === 'closed' ? '已关闭' : '全部')];
    }
    const col = (l: string, f: (i: VcsItem) => boolean) => ({ l, items: items.filter(f) });
    if (state !== 'open') return [col(state === 'merged' ? '已合并' : state === 'closed' ? '已关闭' : '全部', () => true)];
    return [col('草稿', (i) => !!i.draft), col('待审', (i) => !i.draft && (i.reviewDecision === 'review_required' || !i.reviewDecision)), col('需修改', (i) => !i.draft && i.reviewDecision === 'changes_requested'), col('已批准', (i) => !i.draft && i.reviewDecision === 'approved')];
  }, [items, mode, state]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) toast(ok, true); load(); if (sel !== null) setDetail(await ws.request<VcsDetail>({ kind: 'vcs.item', cwd, repo: r, number: sel, isPr: mode === 'pulls' })); } catch (e: any) { toast(e.message); } finally { setBusy(false); } };
  const handOff = async (d: VcsDetail, kind: 'fix' | 'review') => {
    const text = kind === 'fix' ? `请处理 ${repo?.url}/issues/${d.number}：\n\n# ${d.title}\n\n${d.body || '(无描述)'}\n\n完成后总结改了什么、怎么验证的。` : `请审查 PR #${d.number}「${d.title}」（分支 ${d.head} → ${d.base}）。\n\n${d.body || ''}\n\n重点：正确性、边界条件、测试覆盖、是否符合仓库约定。给出可直接发到 PR 的评审意见。`;
    if (sid) await send(sid, text); else { const id = await openSession({ cwd }); await send(id, text); }
  };
  const checkoutAndSession = async (d: VcsDetail) => {
    const wt = await dlg.confirm(`检出 PR #${d.number} 到独立 worktree？`, { message: '选「取消」则直接在当前目录切换分支。', okLabel: 'worktree', cancelLabel: '当前目录' });
    await act(async () => {
      const res = await ws.request<{ branch: string; path: string }>({ kind: 'vcs.checkout', cwd, repo: r, number: d.number, worktree: wt });
      const id = await openSession({ cwd: res.path });
      await send(id, `这是 PR #${d.number}「${d.title}」的检出（分支 ${res.branch}）。先读一遍改动（git diff ${d.base}...HEAD），然后告诉我它做了什么、有没有问题。`);
    }, '已检出并开了会话');
  };
  const newItem = async () => {
    const title = await dlg.prompt(mode === 'issues' ? '新 Issue 标题' : '新 PR 标题', '');
    if (!title) return;
    const body = await dlg.prompt('描述（可空，支持 Markdown）', '');
    if (mode === 'pulls') {
      const head = await dlg.prompt('源分支', ''); if (!head) return;
      const base = await dlg.prompt('目标分支', repo?.defaultBranch ?? 'main'); if (!base) return;
      await act(() => ws.request({ kind: 'vcs.create', cwd, repo: r, title, body: body ?? '', isPr: true, head, base }), 'PR 已创建');
    } else await act(() => ws.request({ kind: 'vcs.create', cwd, repo: r, title, body: body ?? '' }), 'Issue 已创建');
  };
  const changeRepo = async () => {
    const v = await dlg.prompt('仓库', repoOverride, { message: '留空 = 用当前目录的 origin；也可以填 owner/repo 或 https://gitlab.example.com/group/project' });
    if (v === null) return;
    localStorage.setItem(`cw.board.repo:${cwd}`, v);
    setRepoOverride(v); setSel(null);
  };

  return (
    <div className="board">
      <div className="board-head">
        <div className="seg mini">
          <button className={clsx(mode === 'pulls' && 'active')} onClick={() => { setMode('pulls'); setSel(null); }}>{repo?.provider === 'gitlab' ? 'MR' : 'PR'}</button>
          <button className={clsx(mode === 'issues' && 'active')} onClick={() => { setMode('issues'); setSel(null); }}>Issues</button>
        </div>
        <select className="field sm" value={state} onChange={(e) => setState(e.target.value as any)}>
          <option value="open">开放</option>{mode === 'pulls' && <option value="merged">已合并</option>}<option value="closed">已关闭</option><option value="all">全部</option>
        </select>
        {mode === 'issues' && <><input className="field sm" placeholder="搜索…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} style={{ width: 160 }} /><label className="chip"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> 指派给我</label></>}
        <span className="grow" />
        {repo && <button className="btn sm ghost" title={repo.url} onClick={changeRepo}>{repo.provider === 'gitlab' ? '🦊' : '🐙'} {repo.owner}/{repo.repo}{repo.user ? ` · @${repo.user}` : ''}</button>}
        {!repo && <button className="btn sm ghost" onClick={changeRepo}>选择仓库…</button>}
        <button className="btn sm ghost" onClick={newItem} disabled={!repo?.authOk}>＋ 新建</button>
        <button className="btn sm ghost" onClick={() => { void loadRepo(); load(); }} disabled={loading}>{loading ? '…' : '↻'}</button>
      </div>
      {err && <div className="board-err">{err}{/未登录/.test(err) && <> · <a href="#" onClick={(e) => { e.preventDefault(); useStore.getState().openSettings({ section: 'tools' }); }}>安装 / 登录 {repo?.cli ?? 'gh'}</a></>}</div>}
      <div className="board-body">
        <div className="board-cols">
          {columns.map((c) => (
            <div key={c.l} className="board-col">
              <div className="board-col-h">{c.l} <span className="muted">{c.items.length}</span></div>
              {c.items.map((it) => <Card key={it.number} it={it} active={sel === it.number} onClick={() => setSel(it.number)} />)}
              {c.items.length === 0 && <div className="empty" style={{ padding: 16 }}>—</div>}
            </div>
          ))}
        </div>
        {sel !== null && (
          <div className="board-detail">
            <div className="board-detail-h">
              <b>#{sel}</b>
              <span className="grow" />
              {detail && <a className="btn sm ghost" href={detail.url} target="_blank" rel="noreferrer">↗ 打开</a>}
              <button className="icon-btn" onClick={() => setSel(null)}>✕</button>
            </div>
            {!detail && <div className="empty">读取中…</div>}
            {detail && (
              <div className="board-detail-b">
                <h3>{detail.title}</h3>
                <div className="m">{detail.author} · 创建于 {new Date(detail.createdAt).toLocaleDateString()} · 更新 {ago(detail.updatedAt)}{detail.isPr && <> · <code>{detail.head}</code> → <code>{detail.base}</code></>}{detail.milestone && <> · 里程碑 {detail.milestone}</>}</div>
                <div className="actions">
                  <button className="btn sm" disabled={busy} onClick={() => handOff(detail, detail.isPr ? 'review' : 'fix')}>{detail.isPr ? '让 Claude 审查' : '让 Claude 处理'}</button>
                  {detail.isPr && detail.state === 'open' && <button className="btn sm ghost" disabled={busy} onClick={() => checkoutAndSession(detail)}>检出 → 新会话</button>}
                  {detail.state === 'open' && repo?.user && !detail.assignees.includes(repo.user) && <button className="btn sm ghost" disabled={busy} onClick={() => act(() => ws.request({ kind: 'vcs.assign', cwd, repo: r, number: detail.number, isPr: detail.isPr, assignees: [...detail.assignees, repo.user] }), '已指派给你')}>指派给我</button>}
                  {detail.state === 'open' && detail.isPr && detail.mergeable !== false && <button className="btn sm ghost" disabled={busy || detail.checks === 'failure'} onClick={async () => { const m = await dlg.confirm(`合并 #${detail.number}？`, { message: 'squash 合并；取消则不合并。', okLabel: 'Squash 合并' }); if (m) await act(() => ws.request({ kind: 'vcs.merge', cwd, repo: r, number: detail.number, method: 'squash' }), '已合并'); }}>合并</button>}
                  {detail.state === 'open' ? <button className="btn sm ghost danger" disabled={busy} onClick={() => act(() => ws.request({ kind: 'vcs.setState', cwd, repo: r, number: detail.number, isPr: detail.isPr, state: 'closed' }), '已关闭')}>关闭</button> : detail.state === 'closed' && <button className="btn sm ghost" disabled={busy} onClick={() => act(() => ws.request({ kind: 'vcs.setState', cwd, repo: r, number: detail.number, isPr: detail.isPr, state: 'open' }), '已重开')}>重新打开</button>}
                </div>
                {detail.isPr && (detail.checkRuns?.length ?? 0) > 0 && (
                  <div className="checks">{detail.checkRuns!.map((c, i) => <a key={i} href={c.url || undefined} target="_blank" rel="noreferrer" className={clsx('chk', c.conclusion === 'success' ? 'success' : c.conclusion && c.conclusion !== 'neutral' && c.conclusion !== 'skipped' ? 'failure' : 'pending')}>{c.conclusion === 'success' ? '✓' : c.status === 'completed' ? '✗' : '◌'} {c.name}</a>)}</div>
                )}
                {detail.isPr && (detail.reviews?.length ?? 0) > 0 && <div className="m">评审：{detail.reviews!.map((rv) => `${rv.author} ${REVIEW_L[rv.state] ?? rv.state}`).join(' · ')}</div>}
                <div className="body"><Markdown text={detail.body || '_没有描述_'} /></div>
                {detail.isPr && (detail.files?.length ?? 0) > 0 && (
                  <details><summary>改动文件 {detail.files!.length}</summary><ul className="files">{detail.files!.map((f) => <li key={f.path}><code>{f.path}</code> <span style={{ color: 'var(--green)' }}>+{f.additions}</span> <span style={{ color: 'var(--red)' }}>−{f.deletions}</span></li>)}</ul></details>
                )}
                <div className="comments">
                  {detail.comments.map((c: any) => <div key={c.id} className="comment"><div className="m"><b>{c.author}</b> · {ago(c.createdAt)}</div><Markdown text={c.body} /></div>)}
                </div>
                <div className="reply">
                  <textarea className="field" rows={3} placeholder="写评论（Markdown）…" value={comment} onChange={(e) => setComment(e.target.value)} />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
                    <button className="btn sm ghost" onClick={() => { if (sid) void send(sid, `帮我给 #${detail.number} 写一条评论。上下文：\n\n${detail.title}\n${detail.body.slice(0, 1500)}`); }}>让 Claude 起草</button>
                    <button className="btn sm" disabled={!comment.trim() || busy} onClick={() => act(() => ws.request({ kind: 'vcs.comment', cwd, repo: r, number: detail.number, isPr: detail.isPr, body: comment }).then(() => setComment('')), '已评论')}>发送</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
