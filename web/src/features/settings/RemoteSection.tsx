import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import { desktop } from '@/desktop';
import type { RemoteHost, RemoteStatus, TunnelInfo } from '@shared';
import { Icon } from '@/ui/icons';

function ago(t: number) { const s = Math.max(0, Date.now() - t) / 1000; return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`; }

/** LAN / phone access: second listener + pairing QR + device table. */
export function RemoteSection() {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [port, setPort] = useState('');
  const [pair, setPair] = useState<{ code: string; expiresAt: number; url: string } | null>(null);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => ws.request<RemoteStatus>({ kind: 'remote.status' }).then((s) => { setSt(s); setPort(String(s.port)); }).catch((e) => toast(e.message));
  useEffect(() => { void load(); const off = ws.on((e) => { if (e.kind === 'remote.changed') void load(); }); return () => { off(); }; }, []);
  useEffect(() => { if (!pair) { setQr(''); return; } QRCode.toDataURL(pair.url, { margin: 1, width: 220, color: { dark: '#ece9e2', light: '#00000000' } }).then(setQr).catch(() => setQr('')); }, [pair?.url]);
  const [, tickState] = useState(0);
  useEffect(() => { if (!pair) return; const i = setInterval(() => tickState((x) => x + 1), 1000); return () => clearInterval(i); }, [pair]);
  const set = async (patch: { enabled?: boolean; port?: number }) => { setBusy(true); try { const s = await ws.request<RemoteStatus>({ kind: 'remote.set', ...patch }); setSt(s); setPort(String(s.port)); } catch (e: any) { toast(e.message); } finally { setBusy(false); } };
  const newPair = async () => { try { setPair(await ws.request({ kind: 'remote.pairCode' })); } catch (e: any) { toast(e.message); } };
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - Date.now()) / 1000)) : 0;
  if (!st) return <div className="section"><div className="empty">读取中…</div></div>;
  return (
    <div className="section">
      <h5>局域网 / 手机访问</h5>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <label className="chip"><input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => set({ enabled: e.target.checked })} /> 允许其它设备访问（监听 0.0.0.0）</label>
        <label className="chip">端口 <input className="field" style={{ width: 80 }} value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => { const p = Number(port); if (p && p !== st.port) void set({ port: p }); }} /></label>
        <span className={clsx('badge', st.running ? 'ok' : st.error ? 'err' : '')}>{st.running ? '运行中' : st.enabled ? (st.error || '未运行') : '关闭'}</span>
      </div>
      <div className="sub" style={{ marginTop: 6 }}>
        手机和电脑连同一个 Wi-Fi；每台设备用一次性配对码换取自己的访问令牌（可随时吊销）。局域网是明文 HTTP，别在公共网络上开。
        {st.addresses.length > 0 && <> 本机地址：{st.addresses.map((a) => <code key={a} style={{ marginLeft: 6 }}>{a}:{st.port}</code>)}</>}
      </div>
      {st.enabled && (
        <div className="pair-box">
          <div>
            <button className="btn sm" onClick={newPair} disabled={!st.running}>{pair && left > 0 ? '重新生成配对码' : '生成配对码'}</button>
            {pair && left > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="pair-code">{pair.code}</div>
                <div className="sub">{left}s 后失效 · 手机扫码，或打开 <code>{pair.url.split('#')[0]}</code> 手动输入</div>
              </div>
            )}
            {pair && left <= 0 && <div className="sub" style={{ marginTop: 8 }}>配对码已过期</div>}
          </div>
          {qr && left > 0 && <img className="pair-qr" src={qr} alt="配对二维码" />}
        </div>
      )}
      <h5 style={{ marginTop: 16 }}>已配对设备</h5>
      <div className="list">
        {st.devices.map((d) => (
          <div key={d.id} className="row">
            <span className={clsx('dot', Date.now() - d.lastSeenAt < 120_000 ? 'running' : 'idle')} />
            <div className="grow">
              <div>{d.name} <span className="muted" style={{ fontSize: 11.5 }}>{d.ip}</span></div>
              <div className="sub">最近 {ago(d.lastSeenAt)} · 配对于 {new Date(d.createdAt).toLocaleDateString()} · {d.ua?.slice(0, 60)}</div>
            </div>
            <button className="btn sm ghost" onClick={async () => { const n = await dlg.prompt('设备名称', d.name); if (n && n !== d.name) await ws.request({ kind: 'remote.devices.rename', id: d.id, name: n }); }}>改名</button>
            <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(`吊销「${d.name}」？`, { message: '该设备需要重新配对才能访问。', danger: true, okLabel: '吊销' })) await ws.request({ kind: 'remote.devices.revoke', id: d.id }); }}>吊销</button>
          </div>
        ))}
        {st.devices.length === 0 && <div className="empty">还没有配对的设备</div>}
      </div>
      <HostsSection />
    </div>
  );
}

/** Remote machines running claude-web, reached through ssh port-forwards. */
function HostsSection() {
  const toast = useStore((s) => s.toast);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [editing, setEditing] = useState<RemoteHost | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => Promise.all([ws.request<RemoteHost[]>({ kind: 'remote.hosts.list' }), ws.request<TunnelInfo[]>({ kind: 'tunnel.list' })]).then(([h, t]) => { setHosts(h); setTunnels(t); }).catch((e) => toast(e.message));
  useEffect(() => { void load(); const off = ws.on((e) => { if (e.kind === 'tunnel.changed') void load(); }); return () => { off(); }; }, []);
  const save = async () => {
    if (!editing) return;
    if (!editing.target.trim()) { toast('需要 user@host'); return; }
    await ws.request({ kind: 'remote.hosts.set', host: { ...editing, name: editing.name.trim() || editing.target, remotePort: Number(editing.remotePort) || 3090, sshPort: Number(editing.sshPort) || undefined } });
    setEditing(null);
    void load();
  };
  const connect = async (h: RemoteHost) => {
    setBusy(h.id);
    try {
      const t = await ws.request<TunnelInfo>({ kind: 'tunnel.open', hostId: h.id });
      if (t.state === 'up') { if (desktop?.newWindow) await (desktop as any).openExternal?.(t.url) ?? window.open(t.url, '_blank'); else window.open(t.url, '_blank'); }
      else toast(t.error || '连接失败');
    } catch (e: any) { toast(e.message); } finally { setBusy(null); void load(); }
  };
  const tOf = (id: string) => tunnels.find((t) => t.hostId === id);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18, marginBottom: 6 }}>
        <h5 style={{ margin: 0 }}>远程主机（SSH 隧道）</h5>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setEditing({ id: Math.random().toString(36).slice(2, 10), name: '', target: '', remotePort: 3090, token: '', startCommand: '' })}><Icon name="plus" size={12} /> 添加主机</button>
      </div>
      <div className="sub">在另一台机器上跑 claude-web，这里用系统 ssh 打一条端口转发，然后在新窗口打开它。需要免密登录（密钥 / agent / ssh config）。</div>
      <div className="list" style={{ marginTop: 6 }}>
        {hosts.map((h) => { const t = tOf(h.id); return (
          <div key={h.id} className="row">
            <span className={clsx('dot', t?.state === 'up' ? 'running' : t?.state === 'connecting' ? 'waiting' : t?.state === 'down' ? 'error' : 'idle')} />
            <div className="grow">
              <div>{h.name} <span className="mono muted" style={{ fontSize: 11.5 }}>{h.target}{h.sshPort ? `:${h.sshPort}` : ''} → :{h.remotePort}</span></div>
              <div className="sub">{t?.state === 'up' ? <>已连接 <code>{t.url.split('?')[0]}</code></> : t?.error || '未连接'}</div>
            </div>
            {t?.state === 'up' ? <>
              <button className="btn sm" onClick={() => window.open(t.url, '_blank')}>打开</button>
              <button className="btn sm ghost" onClick={() => ws.request({ kind: 'tunnel.close', hostId: h.id }).then(load)}>断开</button>
            </> : <button className="btn sm" disabled={busy === h.id} onClick={() => connect(h)}>{busy === h.id ? '连接中…' : '连接'}</button>}
            <button className="btn sm ghost" onClick={() => setEditing({ ...h })}>编辑</button>
            <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(`删除主机「${h.name}」？`, { danger: true, okLabel: '删除' })) { await ws.request({ kind: 'remote.hosts.remove', id: h.id }); void load(); } }}>删除</button>
          </div>); })}
        {hosts.length === 0 && <div className="empty">还没有远程主机</div>}
      </div>
      {editing && (
        <div className="agent-form" style={{ padding: '10px 0 0' }}>
          <label>名称<input className="field" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="办公室台式机" /></label>
          <label>SSH 目标<input className="field" value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })} placeholder="user@host 或 ssh config 里的别名" /></label>
          <label>SSH 端口<input className="field" value={editing.sshPort ?? ''} onChange={(e) => setEditing({ ...editing, sshPort: Number(e.target.value) || undefined })} placeholder="22" /></label>
          <label>远端 claude-web 端口<input className="field" value={editing.remotePort} onChange={(e) => setEditing({ ...editing, remotePort: Number(e.target.value) })} /></label>
          <label>远端令牌（CLAUDE_WEB_TOKEN，可空）<input className="field" value={editing.token ?? ''} onChange={(e) => setEditing({ ...editing, token: e.target.value })} /></label>
          <label>私钥文件（可空）<input className="field" value={editing.identityFile ?? ''} onChange={(e) => setEditing({ ...editing, identityFile: e.target.value })} placeholder="~/.ssh/id_ed25519" /></label>
          <label style={{ gridColumn: '1 / -1' }}>连接前在远端执行（可空，例如启动服务）<input className="field" value={editing.startCommand ?? ''} onChange={(e) => setEditing({ ...editing, startCommand: e.target.value })} placeholder="cd ~/claude-web && (pgrep -f server/dist/index.js || PORT=3090 CLAUDE_WEB_TOKEN=xxx nohup node server/dist/index.js >/tmp/cw.log 2>&1 &)" /></label>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', gridColumn: '1 / -1' }}>
            <button className="btn sm ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn sm" onClick={save}>保存</button>
          </div>
        </div>
      )}
    </>
  );
}
