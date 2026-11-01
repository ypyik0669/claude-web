// PR 监控条 (spec 2026-10-16 review-pr §3, stage E): the pull / merge request of the conversation's branch, over the
// conversation — its checks, and a CI menu: 自动修 CI / 自动修流水线 (the conversation is asked to fix a failed check,
// once per push), 就绪后自动合并 / 流水线通过后合并, 自动处理评论 (E1: trusted reviewers' comments go to the conversation
// five at a time while it is idle, replied to after the push). Other comments are listed for the user to hand over one
// by one. With 设置 → PR 合并或关闭后自动归档对话 the conversation archives itself when the PR is done.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { parsePeerId, type BranchPr, type PrComment } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { Popover } from '@/features/composer/Popover';
import { ciFixMessage, fixKey, newFailures, prSettled } from './pr-bar-model';
import { afterTurn, autoCandidates, commentsMessage, externalComments, nextBatch, NO_BATCH, prLabel, rememberDone, replyText, shouldReply } from './pr-comments-model';
import { PrComments } from './PrComments';

const POLL_MS = 60_000;
const NONE: string[] = [];
const NONE_C: PrComment[] = [];

// One bar per conversation does the work, whichever on-screen one asked first: it polls, and only it auto-fixes or
// auto-archives (a conversation can sit in two panes; hidden tabs stay mounted). The others draw what it found.
// Across windows the server's lease picks one (below).
/** also read by 总览 (MissionPanel): what the bars found, by conversation */
export const usePrs = create<{ bySession: Record<string, BranchPr | null> }>(() => ({ bySession: {} }));
/** the PR's open comments, by conversation (stage E1) */
export const useComments = create<{ bySession: Record<string, PrComment[]> }>(() => ({ bySession: {} }));
const owners = new Map<string, symbol>();
const claim = (sid: string, me: symbol) => { const o = owners.get(sid); if (o && o !== me) return false; owners.set(sid, me); return true; };
// …and one window per conversation (fix E-I3): the server's lease (`vcs.autoLease`, renewed each poll) says which
// window acts; this one trusts its grant a little less long than the server keeps it
const WINDOW = globalThis.crypto?.randomUUID?.() ?? `w${Math.random().toString(36).slice(2)}${Date.now()}`;
const LEASE_TRUST_MS = 120_000;
const leasedUntil = new Map<string, number>();
const leased = (sid: string) => (leasedUntil.get(sid) ?? 0) > Date.now();
const letGo = (sid: string) => {
  if (!leasedUntil.delete(sid)) return;
  ws.request({ kind: 'vcs.autoLease', sessionId: sid, holder: WINDOW, release: true }).catch(() => { /* runs out by itself */ });
};
/** The conversation folder's HEAD commit ('' = unknown). */
const localHead = (cwd: string) => ws.request<{ hash: string }[]>({ kind: 'git.log', cwd, n: 1 }).then((l) => l?.[0]?.hash ?? '', () => '');
// asked already in this window, before meta.json's `prFixed` comes back round (two renders a frame apart must not both send)
const sentFix = new Set<string>();
// comments handed over from this window, before `prCommentsDone` comes back round
const sentComments = new Set<string>();
// a reply round in flight (one per conversation)
const replying = new Set<string>();
// 自动归档 acts on a PR this window saw open: turning the setting on must not sweep up conversations whose PRs were
// merged months ago; one try each
const sawOpen = new Set<string>();

export function PrBar({ sessionId, visible = true }: { sessionId: string; visible?: boolean }) {
  const cwd = useStore((s) => s.open[sessionId]?.cwd);
  const state = useStore((s) => s.open[sessionId]?.state);
  const autoFix = useStore((s) => !!s.sessionMeta[sessionId]?.prAutoFix);
  const asked = useStore((s) => s.sessionMeta[sessionId]?.prFixed) ?? NONE;
  const autoComments = useStore((s) => s.sessionMeta[sessionId]?.prAutoComments ?? 0);
  const done = useStore((s) => s.sessionMeta[sessionId]?.prCommentsDone) ?? NONE;
  const sent = useStore((s) => s.sessionMeta[sessionId]?.prCommentsSent);
  const autoArchive = useStore((s) => s.settings['ui.autoArchivePr'] === true);
  const resolveOnReply = useStore((s) => s.settings['vcs.resolveOnReply'] === true);
  const pr = usePrs((s) => s.bySession[sessionId] ?? null);
  const cs = useComments((s) => s.bySession[sessionId]) ?? NONE_C;
  const [menu, setMenu] = useState(false);
  const [list, setList] = useState(false);
  const [busy, setBusy] = useState(false);
  const ciBtn = useRef<HTMLButtonElement>(null);
  const me = useRef(Symbol('pr-bar')).current;
  const remote = !!parsePeerId(sessionId);
  const idle = state === 'idle' || state === 'history' || state === 'closed';
  const on = visible && !remote && !!cwd;
  const ext = useMemo(() => externalComments(cs, done, !!autoComments), [cs, done, autoComments]);

  useEffect(() => () => { if (owners.get(sessionId) === me) { owners.delete(sessionId); letGo(sessionId); } }, [sessionId, me]);
  useEffect(() => { if (!visible && owners.get(sessionId) === me) { owners.delete(sessionId); letGo(sessionId); } }, [visible, sessionId, me]);
  /** this bar does the conversation's automatic actions: the window's one bar for it, in the window holding the lease */
  const acts = useCallback(() => owners.get(sessionId) === me && leased(sessionId), [sessionId, me]);

  const refresh = useCallback(async () => {
    if (!on || !claim(sessionId, me)) return;
    try {
      const l = await ws.request<{ ok: boolean }>({ kind: 'vcs.autoLease', sessionId, holder: WINDOW }).catch(() => ({ ok: false }));
      if (l?.ok) leasedUntil.set(sessionId, Date.now() + LEASE_TRUST_MS); else leasedUntil.delete(sessionId);
      const r = (await ws.request({ kind: 'vcs.prForBranch', cwd: cwd! })) as { pr?: BranchPr };
      const next = r.pr ?? null;
      if (next?.state === 'open') sawOpen.add(sessionId);
      usePrs.setState((st) => ({ bySession: { ...st.bySession, [sessionId]: next } }));
      if (next?.state === 'open') {
        const c = (await ws.request({ kind: 'vcs.prComments', cwd: cwd!, number: next.number, ...(next.base ? { base: next.base } : {}) })) as { comments: PrComment[] };
        useComments.setState((st) => ({ bySession: { ...st.bySession, [sessionId]: c.comments ?? [] } }));
      }
    } catch { /* offline / rate-limited: keep what is shown */ }
  }, [on, cwd, sessionId, me]);

  // on open, whenever a turn ends (it may have pushed or opened the PR), and every minute while it is on screen
  useEffect(() => { if (idle) void refresh(); }, [idle, refresh]);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [on, refresh]);

  // 自动修 CI / 自动修流水线: a check failed on the pushed commit and the conversation is not busy — ask it once
  useEffect(() => {
    if (!pr || !autoFix || !idle || !acts()) return;
    const fs = newFailures(pr, asked).filter((x) => !sentFix.has(fixKey(pr, x)));
    if (!fs.length) return;
    const keys = fs.map((x) => fixKey(pr, x));
    keys.forEach((k) => sentFix.add(k));
    const st = useStore.getState();
    void st.setSessionMeta(sessionId, { prFixed: [...asked, ...keys].slice(-50) });
    void (async () => {
      // GitLab: the end of each failed job's log goes in the message (at most 3; one that cannot be read is skipped)
      const logs: Record<number, string> = {};
      if (pr.host === 'gitlab' && cwd) {
        for (const f of fs.filter((x) => typeof x.runId === 'number').slice(0, 3)) {
          try { logs[f.runId!] = ((await ws.request({ kind: 'vcs.failureLog', cwd, jobId: f.runId! })) as { text: string }).text; } catch { /* skipped */ }
        }
      }
      await st.send(sessionId, ciFixMessage(pr, fs, logs));
    })().catch((e) => st.toast(String(e?.message ?? e)));
  }, [pr, autoFix, idle, asked, sessionId, acts, cwd]);

  // 自动处理评论: trusted reviewers' new comments, five at a time, while idle and no batch is waiting for its push.
  // Marked handled only once the conversation took the message; the local HEAD then is what the turn's end compares to.
  useEffect(() => {
    if (!pr || !cwd || pr.state !== 'open' || !autoComments || !idle || (sent && sent.ids.length > 0) || !acts()) return;
    const batch = nextBatch(autoCandidates(cs, done, autoComments), sentComments);
    if (!batch.length) return;
    const ids = batch.map((c) => c.id);
    ids.forEach((id) => sentComments.add(id));
    const st = useStore.getState();
    void (async () => {
      const head = await localHead(cwd);
      await st.send(sessionId, commentsMessage(pr, batch));
      const doneNow = useStore.getState().sessionMeta[sessionId]?.prCommentsDone ?? done;
      await st.setSessionMeta(sessionId, { prCommentsDone: rememberDone(doneNow, ids), prCommentsSent: { ids, sha: pr.sha, at: Date.now(), head } });
    })().catch((e) => {
      ids.forEach((id) => sentComments.delete(id));
      st.toast(String(e?.message ?? e));
    });
  }, [pr, cwd, autoComments, idle, sent, cs, done, sessionId, acts]);

  // a turn ended while a batch waits (fix E-I2): no new local commit → let the batch go (nothing will be pushed for
  // it, and later pushes are not its fix); a new commit → the reply waits for that commit to reach the PR
  useEffect(() => {
    if (!idle || !cwd || !sent || !sent.ids.length || !acts()) return;
    void (async () => {
      const head = await localHead(cwd);
      const next = afterTurn(useStore.getState().sessionMeta[sessionId]?.prCommentsSent, head);
      if (next) await useStore.getState().setSessionMeta(sessionId, { prCommentsSent: next });
    })();
  }, [idle, cwd, sent, sessionId, acts]);

  // 自动处理评论 turned off: a batch still waiting is let go (no late replies)
  useEffect(() => {
    if (autoComments || !sent || !sent.ids.length || owners.get(sessionId) !== me) return;
    void useStore.getState().setSessionMeta(sessionId, { prCommentsSent: NO_BATCH });
  }, [autoComments, sent, sessionId, me]);

  // after the push (the head moved to one containing the conversation's commit): a reply under each handled comment,
  // once; a failure is said once, not retried
  useEffect(() => {
    if (!pr || !cwd || !idle || !shouldReply(sent, pr) || !acts() || replying.has(sessionId)) return;
    replying.add(sessionId);
    const st = useStore.getState();
    void (async () => {
      const commit = sent!.commit!;
      if (pr.sha !== commit) {
        const log = await ws.request<{ hash: string }[]>({ kind: 'git.log', cwd, n: 200, rev: pr.sha }).catch(() => []);
        if (!log?.some((e) => e.hash === commit)) return; // not pushed yet (or someone else's head): keep waiting
      }
      let failed = '';
      for (const id of sent!.ids) {
        const c = cs.find((x) => x.id === id);
        if (!c) continue;
        const ref = { id: c.id, kind: c.kind, ...(c.threadId ? { threadId: c.threadId } : {}), ...(c.replyTo ? { replyTo: c.replyTo } : {}) };
        try {
          await ws.request({ kind: 'vcs.replyComment', cwd, number: pr.number, comment: ref, body: replyText(pr.sha) });
          if (resolveOnReply && c.kind === 'thread') await ws.request({ kind: 'vcs.resolveComment', cwd, number: pr.number, comment: ref });
        } catch (e: any) { failed ||= String(e?.message ?? e); }
      }
      await st.setSessionMeta(sessionId, { prCommentsSent: NO_BATCH });
      if (failed) st.toast(tr('没能回复评论：{msg}', { msg: failed }));
    })().finally(() => replying.delete(sessionId));
  }, [pr, cwd, idle, sent, cs, resolveOnReply, sessionId, acts]);

  // 自动归档: a PR seen open here is now merged / closed, nothing running
  useEffect(() => {
    if (!autoArchive || !idle || !prSettled(pr) || !sawOpen.has(sessionId) || !acts()) return;
    sawOpen.delete(sessionId);
    const merged = pr!.state === 'merged';
    ws.request({ kind: 'library.archive', sessionIds: [sessionId], archived: true })
      .then(() => useStore.getState().toast(merged ? tr('PR #{n} 已合并，对话已归档', { n: pr!.number }) : tr('PR #{n} 已关闭，对话已归档', { n: pr!.number }), true))
      .catch((e) => useStore.getState().toast(String(e?.message ?? e)));
  }, [autoArchive, idle, pr, sessionId, acts]);

  if (!pr || remote) return null;
  const c = pr.checks;
  const gitlab = pr.host === 'gitlab';
  const setAutoMerge = async (on: boolean) => {
    if (!cwd) return;
    setBusy(true);
    try { await ws.request({ kind: 'vcs.autoMerge', cwd, prId: pr.id, on }); await refresh(); }
    catch (e: any) {
      const msg = String(e?.message ?? e);
      useStore.getState().toast(gitlab ? tr('没能设置流水线通过后合并：{msg}', { msg }) : tr('没能设置自动合并：{msg}（仓库要先在 GitHub 设置里允许 auto-merge）', { msg }));
    }
    setBusy(false);
  };
  const handOver = (one: PrComment) => {
    const st = useStore.getState();
    void st.setSessionMeta(sessionId, { prCommentsDone: rememberDone(done, [one.id]) });
    st.send(sessionId, commentsMessage(pr, [one])).catch((e) => st.toast(String(e?.message ?? e)));
  };
  const stateWord = pr.state === 'merged' ? tr('已合并') : pr.state === 'closed' ? tr('已关闭') : pr.draft ? tr('草稿') : pr.mergeable === false ? tr('有冲突') : '';
  return (
    <div className={clsx('pr-bar', pr.state)} role="status" data-host={pr.host ?? 'github'}>
      <Icon name="branch" size={13} />
      <a className="pr-n" href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>{prLabel(pr)}</a>
      <span className="pr-t">{pr.title}</span>
      {stateWord && <span className="pr-state">{stateWord}</span>}
      {pr.state === 'open' && c.total > 0 && (
        <span className="pr-checks" title={c.failures.map((f) => f.name).join('\n') || undefined}>
          {c.passed > 0 && <span className="ok"><Icon name="check" size={11} />{c.passed}</span>}
          {c.failed > 0 && <span className="bad"><Icon name="close" size={11} />{c.failed}</span>}
          {c.pending > 0 && <span className="wait"><Icon name="circle" size={10} />{c.pending}</span>}
        </span>
      )}
      {pr.state === 'open' && ext.length > 0 && (
        <PrComments pr={pr} items={ext} label={autoComments ? tr('还有 {n} 条外部评论', { n: ext.length }) : tr('{n} 条评论', { n: ext.length })} open={list} setOpen={setList} onSend={handOver} />
      )}
      {pr.state === 'open' && (
        <button ref={ciBtn} className={clsx('pr-ci', (autoFix || pr.autoMerge || !!autoComments) && 'on')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          CI <Icon name="chevronDown" size={10} />
        </button>
      )}
      {menu && (
        <Popover anchor={ciBtn} onClose={() => setMenu(false)} prefer="down" align="right" className="pr-menu" label="CI">
          <button role="menuitemcheckbox" data-mi aria-checked={autoFix} className="cm-it" onClick={() => { void useStore.getState().setSessionMeta(sessionId, { prAutoFix: !autoFix }); }}>
            <span className="cm-ck">{autoFix && <Icon name="check" size={13} />}</span>
            <span className="cm-tx"><span className="cm-l">{gitlab ? tr('自动修流水线') : tr('自动修 CI')}</span><span className="cm-d">{tr('检查失败时让这个对话看日志、修好、推送（每次推送只问一次）')}</span></span>
          </button>
          <button role="menuitemcheckbox" data-mi aria-checked={pr.autoMerge} className="cm-it" disabled={busy} onClick={() => void setAutoMerge(!pr.autoMerge)}>
            <span className="cm-ck">{pr.autoMerge && <Icon name="check" size={13} />}</span>
            <span className="cm-tx"><span className="cm-l">{gitlab ? tr('流水线通过后合并') : tr('就绪后自动合并')}</span><span className="cm-d">{gitlab ? tr('流水线都通过后由 GitLab 合并') : tr('检查都通过后由 GitHub 自动 squash 合并')}</span></span>
          </button>
          <button role="menuitemcheckbox" data-mi aria-checked={!!autoComments} className="cm-it pr-auto-comments" onClick={() => { void useStore.getState().setSessionMeta(sessionId, { prAutoComments: autoComments ? 0 : Date.now() }); }}>
            <span className="cm-ck">{!!autoComments && <Icon name="check" size={13} />}</span>
            <span className="cm-tx"><span className="cm-l">{tr('自动处理评论')}</span><span className="cm-d">{tr('有写权限的人留的评论，在对话空闲时交给这个对话处理（一次最多 5 条）')}</span></span>
          </button>
        </Popover>
      )}
    </div>
  );
}
