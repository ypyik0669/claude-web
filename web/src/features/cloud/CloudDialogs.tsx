// Stage F dialogs, mounted once (App): 派活 (a task from the phone → a new conversation on a computer, in a project),
// 导入 claude.ai 数据 (the export zip → the library + projects), 发布 (a file → a sandboxed /p/<id>/ link) and 已发布.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeAiImportResult, ClaudeAiScan, PeerInfo, PublishedItem, PublishExpiry } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { tr } from '@/i18n';
import { openExternal } from '@/features/chat/link-route';
import { expiryText, publishLinks, uploadTo, useDialogFocus } from './logic';

import { useCloud, closeCloud as close } from './cloud-open';
import { Select } from '@/ui/Select';
import { pickFolder as chooseFolder } from '@/ui/pick-folder';
// the open* functions live in cloud-open.ts (this module is loaded on first open — review X1)
export { openDispatch, openClaudeAiImport, openPublish, openPublished } from './cloud-open';
const toast = (t: string, ok = false) => useStore.getState().toast(t, ok);
const copy = (s: string) => { void navigator.clipboard.writeText(s); toast(tr('已复制链接'), true); };
type View = PublishedItem & { localUrl?: string; lanUrl?: string | null };

export function CloudDialogsHost() {
  const d = useCloud((s) => s.d);
  if (!d) return null;
  if (d.kind === 'dispatch') return <DispatchDialog />;
  if (d.kind === 'claudeai') return <ClaudeAiImportDialog />;
  if (d.kind === 'publish') return <PublishDialog key={d.path} path={d.path} />;
  return <PublishedDialog />;
}

function Shell({ id, label, children, wide }: { id: string; label: string; children: React.ReactNode; wide?: boolean }) {
  const box = useDialogFocus();
  return (
    <div className="modal-bg dialog-bg" data-id={id} onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); close(); } }}>
      <div ref={box} tabIndex={-1} className={`modal dialog cloud-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
        <h3>{label}</h3>
        {children}
      </div>
    </div>
  );
}

// ---- 派活 ----

interface Defaults { workspaces: { id: string; name: string; path: string }[]; peers: { id: string; name: string; online: boolean }[]; last: { peer?: string; workspaceId?: string } }

function DispatchDialog() {
  const mobile = useStore((s) => s.mobile);
  const [task, setTask] = useState('');
  const [peer, setPeer] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [d, setD] = useState<Defaults | null>(null);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setTimeout(() => ta.current?.focus(), 0); }, []);
  // first load: this machine's projects + 上次的 pick; picking a machine loads that machine's projects
  useEffect(() => {
    ws.request<Defaults>({ kind: 'dispatch.defaults', ...(peer ? { peer } : {}) }).then((r) => {
      setD((old) => ({ ...r, peers: old?.peers?.length ? old.peers : r.peers }));
      if (peer === null) { setPeer(r.last.peer ?? ''); setWorkspaceId(r.last.workspaceId ?? ''); }
      else if (!r.workspaces.some((w) => w.id === workspaceId)) setWorkspaceId('');
    }, (e) => toast(e.message));
  }, [peer]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    if (!task.trim() || busy) return;
    setBusy(true);
    try {
      const r = await ws.request<{ sessionId: string }>({ kind: 'dispatch.start', prompt: task.trim(), ...(peer ? { peer } : {}), ...(workspaceId ? { workspaceId } : {}), from: mobile ? 'phone' : 'app' });
      toast(tr('已派出'), true);
      close();
      const cwd = d?.workspaces.find((w) => w.id === workspaceId)?.path;
      await useStore.getState().refreshSessions().catch(() => {});
      const row = useStore.getState().sessions.find((x) => x.sessionId === r.sessionId);
      void useStore.getState().openSession({ sessionId: r.sessionId, cwd: row?.cwd ?? cwd ?? '' });
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell id="dispatch-dialog" label={tr('派活')}>
      <div className="dialog-msg">{tr('一句话交代任务，电脑上开一个新对话去做；做完或需要你回答时会通知你。')}</div>
      <textarea ref={ta} className="field" rows={4} value={task} placeholder={tr('比如：把首页的按钮改成蓝色，跑一遍测试')} onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !imeComposing(e.nativeEvent)) { e.preventDefault(); void go(); } }} />
      <div className="cloud-row">
        <label className="pj-label" htmlFor="dispatch-peer">{tr('机器')}</label>
        <Select id="dispatch-peer" className="field" label={tr('机器')} value={peer ?? ''} onValueChange={(v) => setPeer(String(v))}>
          <option value="">{tr('本机')}</option>
          {d?.peers.map((p) => <option key={p.id} value={p.id} disabled={!p.online}>{p.online ? p.name : tr('{name}（现在连不上）', { name: p.name })}</option>)}
        </Select>
      </div>
      <div className="cloud-row">
        <label className="pj-label" htmlFor="dispatch-project">{tr('项目')}</label>
        <Select id="dispatch-project" className="field" label={tr('项目')} value={workspaceId} onValueChange={(v) => setWorkspaceId(String(v))}>
          <option value="">{tr('不放进项目（主目录）')}</option>
          {d?.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </div>
      <div className="dialog-msg pj-note"><div>{tr('权限模式按项目原来的设置；需要你允许的操作会推到这里。')}</div></div>
      <div className="actions">
        <span className="grow" />
        <button className="btn" onClick={close}>{tr('取消')}</button>
        <button className="btn primary" data-act="dispatch" disabled={!task.trim() || busy} onClick={() => void go()}><Icon name="send" size={13} /> {tr('派出')}</button>
      </div>
    </Shell>
  );
}

// ---- 导入 claude.ai 数据 ----

function ClaudeAiImportDialog() {
  const [zip, setZip] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [scan, setScan] = useState<ClaudeAiScan | null>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ClaudeAiImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pick = async (f: File) => {
    setBusy(true); setScan(null); setProgress(0);
    try {
      const r = await uploadTo<{ path: string }>('api/import/claude-ai', f, setProgress);
      setZip(r.path);
      setScan(await ws.request<ClaudeAiScan>({ kind: 'claudeai.scan', path: r.path }));
    } catch (e: any) { toast(e.message); }
    setBusy(false); setProgress(null);
  };
  const pickFolder = async () => {
    const p = await chooseFolder({ start: folder || undefined }).catch((e) => { toast(e.message); return null; });
    if (p) setFolder(p);
  };
  const run = async () => {
    if (!zip || busy) return;
    setBusy(true);
    try {
      const r = await ws.request<ClaudeAiImportResult>({ kind: 'claudeai.import', path: zip, ...(folder ? { folder } : {}) });
      setDone(r);
      void useStore.getState().loadMeta();
      void useStore.getState().refreshSessions();
    } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  return (
    <Shell id="claudeai-import" label={tr('导入 claude.ai 数据')}>
      {done ? (
        <>
          <div className="dialog-msg" data-act="result">{tr('导入完成：新对话 {add} 个、更新 {update} 个、跳过重复 {same} 个；新项目 {pc} 个、更新 {pu} 个；写入资料 {fw} 个（已有的 {fk} 个没动）。', { add: done.add, update: done.update, same: done.same, pc: done.projectsCreated, pu: done.projectsUpdated, fw: done.filesWritten, fk: done.filesKept })}{done.instructionsShortened ? ' ' + tr('{n} 个项目的说明超过 20000 个字，只导入了前 20000 个字。', { n: done.instructionsShortened }) : ''}</div>
          <div className="dialog-msg pj-note"><div>{tr('导入的对话在对话库的「claude.ai」来源里，可以搜索，也可以「接着聊」（在 Claude 里开新对话）。')}</div></div>
          <div className="actions"><span className="grow" /><button className="btn primary" onClick={close}>{tr('完成')}</button></div>
        </>
      ) : (
        <>
          <div className="dialog-msg">{tr('在 claude.ai 的 设置 → 隐私 → 导出数据 拿到 zip，选在这里。这是一次性导入，不是实时同步；不会连接 claude.ai。')}</div>
          <div className="cloud-row">
            <button className="btn" data-act="pick-zip" disabled={busy} onClick={() => input.current?.click()}><Icon name="attach" size={13} /> {zip ? tr('换一个 zip…') : tr('选择 zip…')}</button>
            {progress !== null && <span className="pj-tag">{tr('上传中 {p}%', { p: Math.round(progress * 100) })}</span>}
            <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
          </div>
          {scan && (
            <>
              <div className="dialog-msg" data-act="scan">{tr('里面有 {c} 个对话（{add} 个新的、{update} 个更新过、{same} 个已经导入过）、{p} 个项目、{docs} 份项目资料。', { c: scan.conversations, add: scan.add, update: scan.update, same: scan.same, p: scan.projects, docs: scan.docs })}{scan.skipped ? ` ${tr('{n} 条格式不对，会跳过。', { n: scan.skipped })}` : ''}</div>
              {scan.projects > 0 && (
                <div className="cloud-row">
                  <button className="btn sm" data-act="pick-folder" onClick={() => void pickFolder()}><Icon name="folder" size={13} /> {tr('项目资料放到…')}</button>
                  <span className="pj-path" title={folder}>{folder || tr('不选就只导入对话')}</span>
                </div>
              )}
              {scan.projects > 0 && <div className="dialog-msg pj-note"><div>{tr('每个项目在这个文件夹里建一个子文件夹，资料写进去（已有的文件不覆盖），项目说明变成这里的项目说明。')}</div></div>}
            </>
          )}
          <div className="actions">
            <span className="grow" />
            <button className="btn" onClick={close}>{tr('取消')}</button>
            <button className="btn primary" data-act="import" disabled={!scan || busy} onClick={() => void run()}>{busy && scan ? tr('正在导入…') : tr('导入')}</button>
          </div>
        </>
      )}
    </Shell>
  );
}

// ---- 发布 ----

function Links({ it }: { it: View }) {
  const l = publishLinks(it);
  const rows: [string, string | null, string][] = [[tr('本机'), l.local, 'local'], [tr('局域网'), l.lan, 'lan'], [tr('常开机器'), l.peer, 'peer']];
  return (
    <div className="cloud-links">
      {rows.filter(([, u]) => u).map(([label, u, k]) => (
        <div key={k} className="cloud-link" data-link={k}>
          <span className="pj-tag">{label}</span>
          <code className="pj-path" title={u!}>{u}</code>
          <button className="icon-btn" aria-label={tr('复制链接')} title={tr('复制链接')} onClick={() => copy(u!)}><Icon name="copy" size={13} /></button>
          <button className="icon-btn" aria-label={tr('打开')} title={tr('打开')} onClick={() => openExternal(u!)}><Icon name="external" size={13} /></button>
        </div>
      ))}
      {!it.peerId && !l.lan && <div className="dialog-msg pj-note"><div>{tr('局域网链接要先在 设置 → 手机与远程 打开远程监听。')}</div></div>}
    </div>
  );
}

function PublishDialog({ path }: { path: string }) {
  const [expiry, setExpiry] = useState<PublishExpiry>('7d');
  const [it, setIt] = useState<View | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [busy, setBusy] = useState(false);
  // F7: exactly what 发布 copies (the page and its own assets), shown before it is published
  const [files, setFiles] = useState<{ files: { rel: string; size: number }[]; bytes: number } | null>(null);
  const name = useMemo(() => path.split(/[\\/]/).pop() ?? path, [path]);
  const html = /\.html?$/i.test(path);
  useEffect(() => { ws.request<PeerInfo[]>({ kind: 'peers.list' }).then((l) => setPeers(l.filter((p) => p.enabled && p.state === 'online')), () => {}); }, []);
  useEffect(() => { ws.request<{ files: { rel: string; size: number }[]; bytes: number }>({ kind: 'publish.files', path }).then(setFiles, () => {}); }, [path]);
  const run = async (fn: () => Promise<View>) => {
    setBusy(true);
    try { setIt(await fn()); } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const exportOne = async () => {
    try {
      const r = await ws.request<{ path: string }>({ kind: 'publish.inline', path });
      await navigator.clipboard.writeText(r.path).catch(() => {});
      toast(tr('已导出成单个 HTML：{path}（路径已复制）', { path: r.path }), true);
    } catch (e: any) { toast(e.message); }
  };
  const EXP: [PublishExpiry, string][] = [['1d', tr('1 天')], ['7d', tr('7 天')], ['never', tr('永久')]];
  return (
    <Shell id="publish-dialog" label={tr('发布「{name}」', { name })}>
      <div className="dialog-msg">{tr('发布的是现在这一刻的快照，打开链接不需要登录；网页在沙箱里运行，碰不到 Claude Web。改了文件要再发布一次。')}</div>
      <div className="seg cloud-exp" role="radiogroup" aria-label={tr('有效期')}>
        {EXP.map(([v, l]) => <button key={v} role="radio" aria-checked={expiry === v} className={expiry === v ? 'active' : ''} data-exp={v} onClick={() => setExpiry(v)}>{l}</button>)}
      </div>
      {files && files.files.length > 1 && (
        <details className="dialog-msg" data-id="publish-files">
          <summary>{tr('会一起发布 {n} 个文件（共 {size} KB）', { n: files.files.length, size: Math.max(1, Math.round(files.bytes / 1024)) })}</summary>
          <pre className="cloud-diff mono">{files.files.map((f) => f.rel).join('\n')}</pre>
        </details>
      )}
      {it && <Links it={it} />}
      <div className="actions">
        {html && <button className="btn sm ghost" data-act="inline" onClick={() => void exportOne()}>{tr('导出成单个 HTML')}</button>}
        {peers.length > 0 && <button className="btn sm ghost" data-act="to-peer" disabled={busy} onClick={() => void run(() => ws.request<View>({ kind: 'publish.toPeer', path, expiry, peerId: (peers.find((p) => p.alwaysOn) ?? peers[0]).id }))}>{tr('发布到常开机器')}</button>}
        <span className="grow" />
        <button className="btn" onClick={close}>{tr('关闭')}</button>
        <button className="btn primary" data-act="publish" disabled={busy} onClick={() => void run(() => ws.request<View>({ kind: 'publish.create', path, expiry, ...(it && !it.peerId ? { id: it.id } : {}) }))}>{it && !it.peerId ? tr('重新发布') : tr('发布')}</button>
      </div>
    </Shell>
  );
}

function PublishedDialog() {
  const [items, setItems] = useState<View[] | null>(null);
  const load = () => ws.request<{ items: View[] }>({ kind: 'publish.list' }).then((r) => setItems(r.items), (e) => { setItems([]); toast(e.message); });
  useEffect(() => { void load(); }, []);
  const revoke = async (it: View) => {
    if (!(await dlg.confirm(tr('撤回「{name}」？', { name: it.name }), { message: tr('链接马上失效，快照会删除。'), danger: true }))) return;
    await ws.request<{ pending?: boolean } | null>({ kind: 'publish.revoke', id: it.id }).then((r) => {
      // F6: the machine is offline — the copy there is removed once it is back (the row stays, marked)
      if (r?.pending) toast(tr('「{name}」现在连不上，等它连上后自动撤回', { name: it.peerName ?? '' }));
      void load();
    }, (e) => toast(e.message));
  };
  const republish = async (it: View) => {
    await ws.request({ kind: 'publish.create', path: it.source, expiry: it.expiresAt === null ? 'never' : '7d', id: it.id }).then(() => { toast(tr('已重新发布'), true); void load(); }, (e) => toast(e.message));
  };
  return (
    <Shell id="published-dialog" label={tr('已发布')} wide>
      {items === null ? <div className="dialog-msg">{tr('加载中…')}</div> : !items.length ? <div className="dialog-msg">{tr('还没有发布过文件。在文件上右键 → 发布…')}</div> : (
        <ul className="cloud-published">
          {items.map((it) => (
            <li key={it.id} data-pub={it.id}>
              <div className="cloud-pub-head">
                <strong className="pj-path" title={it.source}>{it.name}</strong>
                <span className="pj-tag">{it.peerName ? tr('在 {name} 上', { name: it.peerName }) : ''} {it.revokePending ? tr('撤回待完成') : expiryText(it.expiresAt)}</span>
                {!it.peerId && <button className="btn sm ghost" onClick={() => void republish(it)}>{tr('重新发布')}</button>}
                <button className="btn sm ghost danger" data-act="revoke" onClick={() => void revoke(it)}>{tr('撤回')}</button>
              </div>
              <Links it={it} />
            </li>
          ))}
        </ul>
      )}
      <div className="actions"><span className="grow" /><button className="btn primary" onClick={close}>{tr('关闭')}</button></div>
    </Shell>
  );
}
