import { useEffect, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import { desktop } from '@/desktop';
import type { RemoteHost, RemotePairCode, RemoteStatus, TunnelInfo } from '@shared';
import { Icon } from '@/ui/icons';
import { agoText } from '@/features/home/model';
import { Row } from './controls';
import { pairQr, type PairQr } from './pair-qr';
import { tr, dateLocale } from '@/i18n';
import { SwitchChip } from '@/ui/Switch';

/** Remote access status, reloaded on every remote.changed (the listener, devices). */
export function useRemoteStatus(): [RemoteStatus | null, (s: RemoteStatus) => void] {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<RemoteStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => ws.request<RemoteStatus>({ kind: 'remote.status' }).then((s) => live && setSt(s)).catch((e) => live && toast(e.message));
    void load();
    const off = ws.on((e) => { if (e.kind === 'remote.changed') void load(); });
    return () => { live = false; off(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [st, setSt];
}

/**
 * LAN / phone access: second listener, the pairing QR, 不让电脑睡眠, and the device table. Settings → 手机与其它电脑
 * shows it with `PeersSection` (other computers) and, under 更多选项, `HostsSection` (SSH tunnels).
 */
export function RemoteSection() {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useRemoteStatus();
  const [port, setPort] = useState('');
  const [pair, setPair] = useState<RemotePairCode | null>(null);
  const [qr, setQr] = useState<PairQr | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  useEffect(() => { if (st) setPort(String(st.port)); }, [st?.port]); // eslint-disable-line react-hooks/exhaustive-deps
  // the port changed (here or in another window): the code on screen points at the old address
  const ranOn = useRef(0);
  useEffect(() => {
    if (!st) return;
    if (ranOn.current && ranOn.current !== st.port) setPair(null);
    ranOn.current = st.port;
  }, [st?.port]); // eslint-disable-line react-hooks/exhaustive-deps
  const qrUrl = pair?.url ?? '';
  useEffect(() => {
    let live = true;
    setQr(null);
    if (qrUrl) pairQr(qrUrl).then((q) => live && setQr(q), () => {});
    return () => { live = false; };
  }, [qrUrl]);
  const [, tickState] = useState(0);
  useEffect(() => { if (!pair) return; const i = setInterval(() => tickState((x) => x + 1), 1000); return () => clearInterval(i); }, [pair]);
  const set = async (patch: { enabled?: boolean; port?: number; keepAwake?: boolean }) => {
    setBusy(true);
    try {
      setSt(await ws.request<RemoteStatus>({ kind: 'remote.set', ...patch }));
      // a paired phone keeps its token at the old address (port and all): it has to pair again
      if (patch.port !== undefined) toast(tr('端口已改：配对过的手机要重新扫码'), true);
      if (patch.keepAwake !== undefined) useStore.setState((x) => ({ settings: { ...x.settings, 'remote.keepAwake': patch.keepAwake } }));
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const newPair = async () => {
    setPairing(true);
    try { setPair(await ws.request<RemotePairCode>({ kind: 'remote.pairCode' })); } catch (e: any) { toast(e.message); } finally { setPairing(false); }
  };
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - Date.now()) / 1000)) : 0;
  if (!st) return <div className="section"><div className="empty">{tr('读取中…')}</div></div>;
  return (
    <div className="section">
      <h5>{tr('局域网 / 手机访问')}</h5>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <SwitchChip data-id="remote-enabled" on={st.enabled} disabled={busy} onChange={(on) => set({ enabled: on })}>{tr('允许其它设备访问（监听 0.0.0.0）')}</SwitchChip>
        <label className="switch-inline">{tr('端口')} <input className="field" aria-label={tr('端口')} style={{ width: 80 }} value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => { const p = Number(port); if (p && p !== st.port) void set({ port: p }); }} /></label>
        <span className={clsx('badge', st.running ? 'ok' : st.error ? 'err' : '')}>{st.running ? tr('运行中') : st.enabled ? (st.error || tr('未运行')) : tr('关闭')}</span>
      </div>
      <div className="sub" style={{ marginTop: 6 }}>
        {tr('每台设备用一次性配对码换取自己的访问令牌（可随时吊销）。同一个 Wi-Fi 里走局域网，是明文 HTTP，别在公共网络上开。')}
        {st.addresses.length > 0 && <> {tr('本机地址：')}{st.addresses.map((a) => <code key={a} style={{ marginLeft: 6 }}>{a}:{st.port}</code>)}</>}
      </div>
      {st.enabled && (
        <div className="sp-card aw-card">
          {desktop ? (
            <Row label={tr('不让电脑睡眠')} hint={tr('远程访问开着时，电脑不会自己睡着。屏幕照样会关；笔记本合盖照样会睡。')}>
              <button className={clsx('toggle', st.keepAwake && 'on')} role="switch" aria-checked={st.keepAwake} aria-label={tr('不让电脑睡眠')} data-id="keep-awake" disabled={busy} onClick={() => void set({ keepAwake: !st.keepAwake })} />
            </Row>
          ) : (
            <Row label={tr('不让电脑睡眠')} hint={<span data-id="keep-awake-note">{tr('网页版做不到，去系统电源设置里关掉睡眠。')}</span>} />
          )}
        </div>
      )}
      {st.enabled && (
        <div className="pair-box">
          <div className="pair-side">
            <button className="btn sm" data-id="pair-new" onClick={newPair} disabled={!st.running || pairing}>{pairing ? tr('生成中…') : pair && left > 0 ? tr('重新生成配对码') : tr('生成配对码')}</button>
            {pair && left > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="pair-code">{pair.code}</div>
                <div className="sub">{tr('{left}s 后失效 · 手机连同一个 Wi-Fi 扫码，或打开', { left })} <code>{pair.url.split('#')[0]}</code> {tr('手动输入')}</div>
              </div>
            )}
            {pair && left <= 0 && <div className="sub" style={{ marginTop: 8 }}>{tr('配对码已过期')}</div>}
          </div>
          {qr && left > 0 && <img className="pair-qr" src={qr.src} style={{ width: qr.size }} alt={tr('配对二维码（只在局域网）')} />}
        </div>
      )}
      <h5 style={{ marginTop: 16 }}>{tr('已配对设备')}</h5>
      <div className="list">
        {st.devices.map((d) => (
          <div key={d.id} className="row" data-device={d.id}>
            <span className={clsx('dot', Date.now() - d.lastSeenAt < 120_000 ? 'running' : 'idle')} />
            <div className="grow">
              <div>{d.name} {d.ip && <span className="muted" style={{ fontSize: 12 }}>{d.ip.replace(/^::ffff:/i, '')}</span>}</div>
              <div className="sub">{tr('最近 {agoText} · 配对于 {toLocaleDateString} · {ua}', { agoText: agoText(d.lastSeenAt), toLocaleDateString: new Date(d.createdAt).toLocaleDateString(dateLocale()), ua: d.ua?.slice(0, 60) })}</div>
            </div>
            <button className="btn sm ghost" onClick={async () => { const n = await dlg.prompt(tr('设备名称'), d.name); if (n && n !== d.name) await ws.request({ kind: 'remote.devices.rename', id: d.id, name: n }); }}>{tr('改名')}</button>
            <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(tr('吊销「{name}」？', { name: d.name }), { message: tr('该设备需要重新配对才能访问。'), danger: true, okLabel: tr('吊销') })) await ws.request({ kind: 'remote.devices.revoke', id: d.id }); }}>{tr('吊销')}</button>
          </div>
        ))}
        {st.devices.length === 0 && <div className="empty">{tr('还没有配对的设备')}</div>}
      </div>
    </div>
  );
}

/** Remote machines running claude-web, reached through ssh port-forwards. */
export function HostsSection() {
  const toast = useStore((s) => s.toast);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [editing, setEditing] = useState<RemoteHost | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => Promise.all([ws.request<RemoteHost[]>({ kind: 'remote.hosts.list' }), ws.request<TunnelInfo[]>({ kind: 'tunnel.list' })]).then(([h, t]) => { setHosts(h); setTunnels(t); }).catch((e) => toast(e.message));
  useEffect(() => { void load(); const off = ws.on((e) => { if (e.kind === 'tunnel.changed') void load(); }); return () => { off(); }; }, []);
  const save = async () => {
    if (!editing) return;
    if (!editing.target.trim()) { toast(tr('需要 user@host')); return; }
    try {
      await ws.request({ kind: 'remote.hosts.set', host: { ...editing, name: editing.name.trim() || editing.target, remotePort: Number(editing.remotePort) || 3090, sshPort: Number(editing.sshPort) || undefined } });
    } catch (e: any) { toast(e.message); return; }
    setEditing(null);
    void load();
  };
  const connect = async (h: RemoteHost) => {
    setBusy(h.id);
    try {
      const t = await ws.request<TunnelInfo>({ kind: 'tunnel.open', hostId: h.id });
      // openExternal resolves to undefined, so the old `await openExternal() ?? window.open()` opened it twice
      if (t.state === 'up') { if (desktop?.openExternal) await desktop.openExternal(t.url); else window.open(t.url, '_blank'); }
      else toast(t.error || tr('连接失败'));
    } catch (e: any) { toast(e.message); } finally { setBusy(null); void load(); }
  };
  const tOf = (id: string) => tunnels.find((t) => t.hostId === id);
  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h5 style={{ margin: 0 }}>{tr('远程主机（SSH 隧道）')}</h5>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setEditing({ id: Math.random().toString(36).slice(2, 10), name: '', target: '', remotePort: 3090, token: '', startCommand: '' })}><Icon name="plus" size={12} /> {tr('添加主机')}</button>
      </div>
      <div className="sub">{tr('在另一台机器上跑 claude-web，这里用系统 ssh 打一条端口转发，然后在新窗口打开它。需要免密登录（密钥 / agent / ssh config）。')}</div>
      <div className="list" style={{ marginTop: 6 }}>
        {hosts.map((h) => { const t = tOf(h.id); return (
          <div key={h.id} className="row">
            <span className={clsx('dot', t?.state === 'up' ? 'running' : t?.state === 'connecting' ? 'waiting' : t?.state === 'down' ? 'error' : 'idle')} />
            <div className="grow">
              <div>{h.name} <span className="mono muted" style={{ fontSize: 12 }}>{h.target}{h.sshPort ? `:${h.sshPort}` : ''} → :{h.remotePort}</span></div>
              <div className="sub">{t?.state === 'up' ? <>{tr('已连接')} <code>{t.url.split('?')[0]}</code></> : t?.error || tr('未连接')}</div>
            </div>
            {t?.state === 'up' ? <>
              <button className="btn sm" onClick={() => window.open(t.url, '_blank')}>{tr('打开')}</button>
              <button className="btn sm ghost" onClick={() => ws.request({ kind: 'tunnel.close', hostId: h.id }).then(load)}>{tr('断开')}</button>
            </> : <button className="btn sm" disabled={busy === h.id} onClick={() => connect(h)}>{busy === h.id ? tr('连接中…') : tr('连接')}</button>}
            <button className="btn sm ghost" onClick={() => setEditing({ ...h })}>{tr('编辑')}</button>
            <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(tr('删除主机「{name}」？', { name: h.name }), { danger: true, okLabel: tr('删除') })) { await ws.request({ kind: 'remote.hosts.remove', id: h.id }); void load(); } }}>{tr('删除')}</button>
          </div>); })}
        {hosts.length === 0 && <div className="empty">{tr('还没有远程主机')}</div>}
      </div>
      {editing && (
        <div className="agent-form" style={{ padding: '10px 0 0' }}>
          <label>{tr('名称')}<input className="field" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder={tr('办公室台式机')} /></label>
          <label>{tr('SSH 目标')}<input className="field" value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })} placeholder={tr('user@host 或 ssh config 里的别名')} /></label>
          <label>{tr('SSH 端口')}<input className="field" value={editing.sshPort ?? ''} onChange={(e) => setEditing({ ...editing, sshPort: Number(e.target.value) || undefined })} placeholder="22" /></label>
          <label>{tr('远端 claude-web 端口')}<input className="field" value={editing.remotePort} onChange={(e) => setEditing({ ...editing, remotePort: Number(e.target.value) })} /></label>
          <label>{tr('远端令牌（CLAUDE_WEB_TOKEN，可空）')}<input className="field" value={editing.token ?? ''} onChange={(e) => setEditing({ ...editing, token: e.target.value })} /></label>
          <label>{tr('私钥文件（可空）')}<input className="field" value={editing.identityFile ?? ''} onChange={(e) => setEditing({ ...editing, identityFile: e.target.value })} placeholder="~/.ssh/id_ed25519" /></label>
          <label style={{ gridColumn: '1 / -1' }}>{tr('连接前在远端执行（可空，例如启动服务）')}<input className="field" value={editing.startCommand ?? ''} onChange={(e) => setEditing({ ...editing, startCommand: e.target.value })} placeholder="cd ~/claude-web && (pgrep -f server/dist/index.js || PORT=3090 CLAUDE_WEB_TOKEN=xxx nohup node server/dist/index.js >/tmp/cw.log 2>&1 &)" /></label>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', gridColumn: '1 / -1' }}>
            <button className="btn sm ghost" onClick={() => setEditing(null)}>{tr('取消')}</button>
            <button className="btn sm" onClick={save}>{tr('保存')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
