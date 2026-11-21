// 交给常开机器继续 (stage F1): pick an always-on machine (and, optionally, what it should do next); the work —
// committed or not — goes there on a `cw/handoff-<id>` branch of the project's remote and the conversation goes on
// there. This conversation then reads 已交给 <机器> (HandedOffBar, in place of the input box) with 打开那边的对话 and
// 取回: the machine's work comes back as a NEW local branch and its diff (FetchBackDialog) — nothing is merged.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { HandoffInfo, PeerInfo, SessionSummary } from '@shared';
import { peerSessionId } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { tr } from '@/i18n';
import { useDialogFocus } from './logic';
import { SwitchLine } from '@/ui/Switch';

type Target = Pick<SessionSummary, 'sessionId' | 'cwd' | 'title'>;
const useHandoff = create<{ s: Target | null; back: { sessionId: string; cwd: string } | null }>(() => ({ s: null, back: null }));
export const openHandoffDialog = (s: Target) => useHandoff.setState({ s: { sessionId: s.sessionId, cwd: s.cwd, title: s.title } });
export const openFetchBack = (sessionId: string, cwd: string) => useHandoff.setState({ back: { sessionId, cwd } });
const closeAll = () => useHandoff.setState({ s: null, back: null });
const toast = (t: string, ok = false) => useStore.getState().toast(t, ok);

export function HandoffDialogHost() {
  const s = useHandoff((x) => x.s);
  const back = useHandoff((x) => x.back);
  return <>{s && <HandoffDialog key={s.sessionId} s={s} />}{back && <FetchBackDialog key={back.sessionId} sessionId={back.sessionId} />}</>;
}

function Shell({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  const box = useDialogFocus();
  return (
    <div className="modal-bg dialog-bg" data-id={id} onMouseDown={(e) => e.target === e.currentTarget && closeAll()} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); closeAll(); } }}>
      <div ref={box} tabIndex={-1} className="modal dialog cloud-dialog" role="dialog" aria-modal="true" aria-label={label}>
        <h3>{label}</h3>
        {children}
      </div>
    </div>
  );
}

/** handoff.check: the new files Git does not track (carried only when ticked) and the key files never carried. */
interface Untracked { count: number; bytes: number; files: { path: string; size: number }[]; skipped: string[] }
type Check = { ok: boolean; reason?: string; remote?: string; untracked?: Untracked };
const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

function HandoffDialog({ s }: { s: Target }) {
  const [peers, setPeers] = useState<PeerInfo[] | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [peer, setPeer] = useState('');
  const [prompt, setPrompt] = useState('');
  const [withNew, setWithNew] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ws.request<PeerInfo[]>({ kind: 'peers.list' }).then((l) => {
      const usable = l.filter((p) => p.enabled).sort((a, b) => Number(!!b.alwaysOn) - Number(!!a.alwaysOn));
      setPeers(usable);
      setPeer(usable.find((p) => p.state === 'online')?.id ?? '');
    }, (e) => { setPeers([]); toast(e.message); });
    ws.request<Check>({ kind: 'handoff.check', sessionId: s.sessionId }).then(setCheck, (e) => setCheck({ ok: false, reason: e.message }));
  }, [s.sessionId]);
  const go = async () => {
    if (!peer || busy) return;
    setBusy(true);
    try {
      const info = await ws.request<HandoffInfo & { skipped?: string[] }>({ kind: 'handoff.start', sessionId: s.sessionId, peerId: peer, ...(prompt.trim() ? { prompt: prompt.trim() } : {}), ...(withNew ? { includeUntracked: true } : {}) });
      toast(tr('已交给「{name}」，分支 {branch}', { name: info.peerName, branch: info.branch }), true);
      void useStore.getState().loadMeta().catch(() => {});
      closeAll();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const can = !!check?.ok && !!peer && !busy;
  return (
    <Shell id="handoff-dialog" label={tr('交给常开机器继续')}>
      <div className="dialog-msg">{tr('这个对话和它的改动（包括还没提交的）会推到项目远端的一个新分支，常开机器在那里接着做。你本地的分支、暂存区和文件都不会动。')}</div>
      {check && !check.ok && <div className="dialog-msg cloud-warn" data-act="reason"><Icon name="alert" size={13} /> {check.reason}</div>}
      {peers && !peers.length && <div className="dialog-msg cloud-warn">{tr('还没有其它机器：先在 设置 → 手机与远程 → 其它电脑 里加一台，并勾上「常开」。')}</div>}
      {!!peers?.length && (
        <div className="cloud-peers" role="radiogroup" aria-label={tr('交给哪台机器')}>
          {peers.map((p) => {
            const online = p.state === 'online';
            return (
              <label key={p.id} className={`cloud-peer${online ? '' : ' off'}`}>
                <input type="radio" name="handoff-peer" value={p.id} disabled={!online} checked={peer === p.id} onChange={() => setPeer(p.id)} />
                <Icon name="monitor" size={14} />
                <span className="grow">{p.name}</span>
                <span className="pj-tag">{!online ? tr('现在连不上') : p.alwaysOn ? tr('常开') : tr('已连接')}</span>
              </label>
            );
          })}
        </div>
      )}
      {check?.ok && !!check.untracked?.count && (
        <div className="dialog-msg" data-id="handoff-untracked">
          <SwitchLine className="cloud-check" data-act="include-untracked" on={withNew} onChange={setWithNew}>
            {tr('也带上 {n} 个新文件（Git 还没跟踪的，共 {size}）', { n: check.untracked.count, size: sizeText(check.untracked.bytes) })}
          </SwitchLine>
          <details>
            <summary>{tr('看看是哪些文件')}</summary>
            <pre className="cloud-diff mono">{check.untracked.files.map((f) => `${f.path}  ${sizeText(f.size)}`).join('\n')}{check.untracked.count > check.untracked.files.length ? `\n…` : ''}</pre>
          </details>
        </div>
      )}
      {check?.ok && !!check.untracked?.skipped.length && (
        <div className="dialog-msg cloud-warn" data-id="handoff-skipped"><Icon name="alert" size={13} /> {tr('这些像密钥的文件不会带过去：{files}', { files: check.untracked.skipped.slice(0, 8).join('、') + (check.untracked.skipped.length > 8 ? '…' : '') })}</div>
      )}
      <label className="pj-label" htmlFor="handoff-next">{tr('接着做什么（可不填）')}</label>
      <textarea id="handoff-next" className="field" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={tr('不填的话，对话在那台机器上等你打开')} />
      <div className="actions">
        <span className="grow" />
        <button className="btn" onClick={closeAll}>{tr('取消')}</button>
        <button className="btn primary" data-act="handoff" disabled={!can} onClick={() => void go()}>{busy ? tr('正在交接…') : tr('交接')}</button>
      </div>
    </Shell>
  );
}

function FetchBackDialog({ sessionId }: { sessionId: string }) {
  const [r, setR] = useState<{ branch: string; stat: string; diff: string; files: number; saved: boolean; saveError?: string } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    ws.request<{ branch: string; stat: string; diff: string; files: number; saved: boolean; saveError?: string }>({ kind: 'handoff.fetchBack', sessionId }).then((x) => { setR(x); void useStore.getState().loadMeta().catch(() => {}); }, (e) => setErr(e.message));
  }, [sessionId]);
  return (
    <Shell id="fetch-back-dialog" label={tr('取回')}>
      {!r && !err && <div className="dialog-msg">{tr('正在取回…')}</div>}
      {err && <div className="dialog-msg cloud-warn">{err}</div>}
      {r && (
        <>
          <div className="dialog-msg">{tr('已取回到本地分支 {branch}（{n} 个文件有改动）。不会自动合并：看过之后自己决定合并、挑选还是丢掉。', { branch: r.branch, n: r.files })}</div>
          {!r.saved && <div className="dialog-msg cloud-warn" data-id="fetch-back-unsaved">{tr('那台机器没能先保存它的改动（{why}），取回的是远端上已有的内容。', { why: r.saveError || tr('那台机器连不上') })}</div>}
          <pre className="cloud-diff mono" data-id="fetch-back-diff">{r.stat ? `${r.stat}\n\n${r.diff}` : tr('没有改动')}</pre>
          <div className="actions">
            <button className="btn sm ghost" onClick={() => { void navigator.clipboard.writeText(`git merge ${r.branch}`); toast(tr('已复制'), true); }}>{tr('复制合并命令')}</button>
            <span className="grow" />
            <button className="btn primary" onClick={closeAll}>{tr('关闭')}</button>
          </div>
        </>
      )}
    </Shell>
  );
}

function openRemote(id: string) {
  const row = useStore.getState().sessions.find((x) => x.sessionId === id);
  if (!row) { toast(tr('那边的对话还没出现在列表里，稍后再试')); return; }
  void useStore.getState().openSession({ sessionId: id, cwd: row.cwd });
}

/** In place of the input box of a conversation handed to another machine: read-only here. */
export function HandedOffBar({ sessionId, cwd, info }: { sessionId: string; cwd: string; info: HandoffInfo }) {
  const remoteId = useMemo(() => (info.remoteSessionId ? peerSessionId(info.peerId, info.remoteSessionId) : null), [info]);
  return (
    <div className="handed-off-bar" data-id="handed-off-bar">
      <Icon name="monitor" size={14} />
      <span className="grow">{tr('已交给「{name}」继续（分支 {branch}），这里只读。', { name: info.peerName, branch: info.branch })}</span>
      {remoteId && <button className="btn sm" data-act="open-remote" onClick={() => openRemote(remoteId)}>{tr('打开那边的对话')}</button>}
      <button className="btn sm primary" data-act="fetch-back" onClick={() => openFetchBack(sessionId, cwd)}>{tr('取回')}</button>
    </div>
  );
}
