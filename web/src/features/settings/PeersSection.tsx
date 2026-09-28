import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import type { PeerInfo, PeerState, RemoteHost } from '@shared';
import { Icon } from '@/ui/icons';

const STATE: Record<PeerState, { l: string; dot: string; badge: string }> = {
  online: { l: '在线', dot: 'running', badge: 'ok' },
  connecting: { l: '连接中', dot: 'waiting', badge: '' },
  offline: { l: '离线', dot: 'error', badge: 'err' },
  unauthorized: { l: '令牌失效', dot: 'error', badge: 'err' },
  disabled: { l: '已停用', dot: 'idle', badge: '' },
};

type Draft = { mode: 'code' | 'ssh'; url: string; code: string; name: string; hostId: string };

/**
 * 「其它机器」: other computers running claude-web whose sessions show up in this sidebar. Joining = the
 * other machine's pairing code (this server redeems it for a device token) or one of the SSH hosts below.
 */
export function PeersSection() {
  const toast = useStore((s) => s.toast);
  const [peers, setPeers] = useState<PeerInfo[] | null>(null);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => ws.request<PeerInfo[]>({ kind: 'peers.list' }).then(setPeers).catch((e) => toast(e.message));
  useEffect(() => {
    void load();
    const off = ws.on((e) => { if (e.kind === 'peers.changed') void load(); if (e.kind === 'tunnel.changed') void ws.request<RemoteHost[]>({ kind: 'remote.hosts.list' }).then(setHosts).catch(() => {}); });
    void ws.request<RemoteHost[]>({ kind: 'remote.hosts.list' }).then(setHosts).catch(() => {});
    return () => { off(); };
  }, []);
  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); try { await fn(); } catch (e: any) { toast(e.message); } finally { setBusy(null); void load(); } };
  const add = () => draft && run('add', async () => {
    const p = await ws.request<PeerInfo>(draft.mode === 'ssh' ? { kind: 'peers.add', hostId: draft.hostId, name: draft.name || undefined } : { kind: 'peers.add', url: draft.url, code: draft.code, name: draft.name || undefined });
    setDraft(null);
    toast(p.state === 'online' ? `已加入「${p.name}」` : `已加入「${p.name}」：${STATE[p.state].l}${p.error ? `（${p.error}）` : ''}`, p.state === 'online');
    void useStore.getState().refreshSessions().catch(() => {});
  });
  const repair = (p: PeerInfo) => run(p.id, async () => {
    const code = (await dlg.prompt(`重新配对「${p.name}」`, '', { message: '在那台机器的 设置 → 远程 / 手机 里生成一个新的配对码，填在这里。会话 id 保持不变。', placeholder: '6 位配对码' }))?.trim();
    if (!code) return;
    const r = await ws.request<PeerInfo>({ kind: 'peers.repair', id: p.id, code });
    toast(r.state === 'online' ? '已重新配对' : `${STATE[r.state].l}${r.error ? `：${r.error}` : ''}`, r.state === 'online');
  });
  const usedHosts = new Set((peers ?? []).filter((p) => p.via === 'ssh').map((p) => p.hostId));
  const freeHosts = hosts.filter((h) => !usedHosts.has(h.id));
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18, marginBottom: 6 }}>
        <h5 style={{ margin: 0 }}>其它机器</h5>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setDraft({ mode: 'code', url: '', code: '', name: '', hostId: freeHosts[0]?.id ?? '' })}><Icon name="plus" size={12} /> 加入一台机器</button>
      </div>
      <div className="sub">另一台电脑上也跑着 Claude Web 时，把它加进来：它的会话会出现在侧栏（带机器名），可以直接打开、续聊、审批、中断，或「交给本机 agent 继续」。连接是本机主动发起的，本机不对外开放任何新接口。</div>
      <div className="list" style={{ marginTop: 6 }}>
        {peers?.map((p) => {
          const st = STATE[p.state];
          return (
            <div key={p.id} className="row peer-row">
              <span className={clsx('dot', st.dot)} />
              <div className="grow">
                <div>{p.name} <span className="mono muted" style={{ fontSize: 11.5 }}>{p.url}</span></div>
                <div className="sub">
                  <span className={clsx('badge', st.badge)}>{st.l}</span>
                  {p.state === 'online' && p.latencyMs !== undefined && <span className="lat"> · {p.latencyMs} ms</span>}
                  {p.sessions !== undefined && <> · {p.sessions} 个会话</>}
                  {p.version && <> · v{p.version}</>}
                  {p.error && p.state !== 'online' && <> · {p.error}</>}
                </div>
              </div>
              {p.via === 'direct' && p.state === 'unauthorized' && <button className="btn sm" disabled={busy === p.id} onClick={() => repair(p)}>重新配对</button>}
              {p.enabled && (p.state === 'offline' || (p.via === 'ssh' && p.state === 'unauthorized')) && <button className="btn sm" disabled={busy === p.id} title={p.via === 'ssh' ? '改好 SSH 主机里的令牌后重连（保存主机也会自动重连）' : '立即重连'} onClick={() => run(p.id, () => ws.request({ kind: 'peers.retry', id: p.id }))}>重试</button>}
              <button className="btn sm ghost" onClick={() => run(p.id, async () => { const n = (await dlg.prompt('机器名称', p.name))?.trim(); if (n && n !== p.name) await ws.request({ kind: 'peers.update', id: p.id, patch: { name: n } }); })}>改名</button>
              <button className="btn sm ghost" disabled={busy === p.id} onClick={() => run(p.id, () => ws.request({ kind: 'peers.update', id: p.id, patch: { enabled: !p.enabled } }))}>{p.enabled ? '停用' : '启用'}</button>
              <button className="btn sm ghost danger" onClick={() => run(p.id, async () => { if (await dlg.confirm(`移除「${p.name}」？`, { message: '它的会话不再出现在这里（那台机器上的会话不受影响）。那台机器的「已配对设备」里本机的记录要在那边吊销。', danger: true, okLabel: '移除' })) await ws.request({ kind: 'peers.remove', id: p.id }); })}>移除</button>
            </div>
          );
        })}
        {peers && peers.length === 0 && <div className="empty">还没有加入其它机器</div>}
        {!peers && <div className="empty">读取中…</div>}
      </div>
      {draft && (
        <div className="peer-add">
          <div className="seg mini" style={{ gridColumn: '1 / -1', justifySelf: 'start' }}>
            <button className={clsx(draft.mode === 'code' && 'active')} onClick={() => setDraft({ ...draft, mode: 'code' })}>地址 + 配对码</button>
            <button className={clsx(draft.mode === 'ssh' && 'active')} onClick={() => setDraft({ ...draft, mode: 'ssh' })} disabled={!freeHosts.length} title={freeHosts.length ? '' : '先在下面「远程主机（SSH 隧道）」里添加主机'}>SSH 主机</button>
          </div>
          {draft.mode === 'code' ? <>
            <label>地址<input className="field" autoFocus value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="http://192.168.1.20:3091" /></label>
            <label>配对码<input className="field mono" inputMode="numeric" maxLength={6} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.replace(/\D/g, '') })} placeholder="6 位数字" title="在那台机器的 设置 → 远程 / 手机 里生成" /></label>
          </> : (
            <label>SSH 主机
              <select className="field" value={draft.hostId} onChange={(e) => setDraft({ ...draft, hostId: e.target.value })}>
                {freeHosts.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.target}</option>)}
              </select>
            </label>
          )}
          <label>名称（可空）<input className="field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="默认用那台机器的主机名" /></label>
          <div className="sub" style={{ gridColumn: '1 / -1' }}>{draft.mode === 'code' ? '那台机器要先打开「允许其它设备访问」，地址和端口就是它这一页上显示的那个。' : '经 SSH 隧道连接，用主机配置里的「远端令牌」；隧道断了会自动重开。'}</div>
          <div className="acts">
            <button className="btn sm ghost" onClick={() => setDraft(null)}>取消</button>
            <button className="btn sm primary" disabled={busy === 'add' || (draft.mode === 'code' ? !draft.url.trim() || draft.code.length !== 6 : !draft.hostId)} onClick={add}>{busy === 'add' ? '连接中…' : '加入'}</button>
          </div>
        </div>
      )}
    </>
  );
}
