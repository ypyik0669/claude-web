import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import type { ImGatewayInfo, ImKind, ImKindDef } from '@shared';
import { Icon } from '@/ui/icons';
import { MODE_LABEL } from '@/ui/terms';

const MODES = (['default', 'acceptEdits', 'bypassPermissions'] as const).map((m) => [m, MODE_LABEL[m]] as const);

function GatewayCard({ g, def, onChange }: { g: ImGatewayInfo; def: ImKindDef; onChange: () => void }) {
  const toast = useStore((s) => s.toast);
  const agents = useStore((s) => s.agents);
  const workspaces = useStore((s) => s.workspaces);
  const [open, setOpen] = useState(!g.config || Object.values(g.config).every((v) => !v));
  const [f, setF] = useState<Record<string, string>>({ ...g.config });
  const [name, setName] = useState(g.name);
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(g.pairCode ? { code: g.pairCode, expiresAt: g.pairExpiresAt } : null);
  const [, tick] = useState(0);
  // `im.changed` fires on every connection state change and hands us a new `g`; only reset the form
  // when the saved name / config actually changed, or typing a token gets wiped mid-way
  const savedKey = JSON.stringify([g.name, g.config]);
  useEffect(() => { setF({ ...g.config }); setName(g.name); }, [savedKey]);
  useEffect(() => { if (g.pairCode) setPair({ code: g.pairCode, expiresAt: g.pairExpiresAt }); }, [g.pairCode, g.pairExpiresAt]);
  useEffect(() => { if (!pair) return; const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, [pair]);
  const patch = async (p: any) => { setBusy(true); try { await ws.request({ kind: 'im.set', id: g.id, patch: p }); onChange(); } catch (e: any) { toast(e.message); } finally { setBusy(false); } };
  const save = () => patch({ name, config: f });
  const test = async () => { setBusy(true); try { toast(await ws.request<string>({ kind: 'im.test', id: g.id }), true); } catch (e: any) { toast(e.message); } finally { setBusy(false); } };
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - Date.now()) / 1000)) : 0;
  return (
    <div className={clsx('row agent-card', !g.enabled && 'muted')} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={clsx('dot', g.state === 'running' ? 'running' : g.state === 'error' ? 'error' : g.state === 'starting' ? 'waiting' : 'idle')} />
        <span style={{ fontSize: 16 }}>{def.icon}</span>
        <div className="grow">
          <div>{g.name} <span className="muted" style={{ fontSize: 11.5 }}>{def.name}{g.botName ? ` · ${g.botName}` : ''}</span> {!def.inbound && <span className="badge" style={{ marginLeft: 4 }}>仅通知</span>}</div>
          <div className={clsx('sub', g.state === 'error' && 'err')}>{g.state === 'running' ? `已连接 · ${g.allowUsers.length} 个授权用户 · ${g.bindings.length} 个聊天` : g.state === 'error' ? g.error : g.state === 'starting' ? '连接中…' : '已停止'}</div>
        </div>
        <label className="chip"><input type="checkbox" checked={g.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> 启用</label>
        <button className="btn sm ghost" disabled={busy || g.state !== 'running'} onClick={test}>测试</button>
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '配置'}</button>
      </div>
      {open && (
        <div className="agent-form">
          <label>名称<input className="field" value={name} onChange={(e) => setName(e.target.value)} /></label>
          {def.fields.map((fl) => <label key={fl.key}>{fl.label}<input className="field" type={fl.secret ? 'password' : 'text'} value={f[fl.key] ?? ''} onChange={(e) => setF({ ...f, [fl.key]: e.target.value })} placeholder={fl.hint ?? ''} autoComplete="off" /></label>)}
          <label>默认项目<select className="field" value={g.defaultCwd} onChange={(e) => patch({ defaultCwd: e.target.value })}><option value="">第一个项目</option>{workspaces.map((w) => <option key={w.id} value={w.path}>{w.name} · {w.path}</option>)}</select></label>
          <label>权限模式<select className="field" value={g.permissionMode} onChange={(e) => patch({ permissionMode: e.target.value })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>用哪个 Agent<select className="field" value={g.agent} onChange={(e) => patch({ agent: e.target.value })}><option value="">Claude Code</option>{agents.filter((a) => a.kind !== 'claude' && a.installed && a.enabled).map((a) => <option key={a.kind} value={a.kind}>{a.name}</option>)}</select></label>
          <label className="chip" style={{ alignSelf: 'end' }}><input type="checkbox" checked={g.verbose} onChange={(e) => patch({ verbose: e.target.checked })} /> 推送工具调用过程</label>
          <div style={{ gridColumn: '1 / -1' }} className="sub">{def.help}</div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', gridColumn: '1 / -1' }}>
            <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(`删除机器人「${g.name}」？`, { danger: true, okLabel: '删除' })) await patch(null); }}>删除</button>
            <span className="grow" />
            <button className="btn sm" disabled={busy} onClick={save}>保存并连接</button>
          </div>
          {def.inbound && (
            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b style={{ fontSize: 12.5 }}>授权用户</b>
                <span className="sub">在 IM 里给机器人发 <code>/pair 配对码</code> 即可加入</span>
                <span className="grow" />
                <label className="chip" title="危险：任何能和机器人说话的人都能操作"><input type="checkbox" checked={g.openAccess} onChange={(e) => patch({ openAccess: e.target.checked })} /> 不限制用户</label>
                <button className="btn sm" onClick={async () => { try { setPair(await ws.request({ kind: 'im.pairCode', id: g.id })); } catch (e: any) { toast(e.message); } }}>生成配对码</button>
              </div>
              {pair && left > 0 && <div style={{ marginTop: 6 }}><span className="pair-code" style={{ fontSize: 22 }}>{pair.code}</span> <span className="sub">{left}s 后失效 · 发送 <code>/pair {pair.code}</code></span></div>}
              <div className="chips" style={{ marginTop: 6 }}>
                {g.allowUsers.map((u) => <span key={u} className="chip">{g.allowNames?.[u] ?? u} <button className="x" title="移除" aria-label="移除" onClick={() => patch({ allowUsers: g.allowUsers.filter((x) => x !== u) })}><Icon name="close" size={10} /></button></span>)}
                {g.allowUsers.length === 0 && <span className="sub">还没有授权用户</span>}
              </div>
              {g.bindings.length > 0 && <div className="sub" style={{ marginTop: 6 }}>聊天绑定：{g.bindings.map((b) => <span key={b.chatId} className="chip" style={{ marginRight: 4 }}>{b.chatId} → {b.sessionId.slice(0, 8)} <button className="x" title="解除绑定" aria-label="解除绑定" onClick={() => ws.request({ kind: 'im.unbind', gatewayId: g.id, chatId: b.chatId }).then(onChange).catch((e) => toast(e.message))}><Icon name="close" size={10} /></button></span>)}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** IM gateways: drive sessions from Telegram / Discord / Slack / Feishu / DingTalk; WeCom notifications. */
export function ImSection() {
  const toast = useStore((s) => s.toast);
  const [kinds, setKinds] = useState<ImKindDef[]>([]);
  const [list, setList] = useState<ImGatewayInfo[]>([]);
  const load = () => ws.request<ImGatewayInfo[]>({ kind: 'im.list' }).then(setList).catch((e) => toast(e.message));
  useEffect(() => { ws.request<ImKindDef[]>({ kind: 'im.kinds' }).then(setKinds).catch(() => {}); void load(); const off = ws.on((e) => { if (e.kind === 'im.changed') void load(); }); return () => { off(); }; }, []);
  const add = async (kind: ImKind) => {
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    try { await ws.request({ kind: 'im.set', id, patch: { kind, enabled: false, name: kinds.find((k) => k.kind === kind)?.name ?? kind } }); void load(); } catch (e: any) { toast(e.message); }
  };
  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <h5 style={{ margin: 0 }}>机器人</h5>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>添加</span>
        {kinds.map((k) => <button key={k.kind} className="btn sm ghost" onClick={() => add(k.kind)} title={k.help}><Icon name="plus" size={12} /> {k.name}</button>)}
      </div>
      <div className="list">
        {list.map((g) => { const def = kinds.find((k) => k.kind === g.kind); return def ? <GatewayCard key={g.id} g={g} def={def} onChange={load} /> : null; })}
        {list.length === 0 && <div className="empty">还没有机器人。点上面的按钮添加一个：Telegram 最简单（找 @BotFather 要个 token）。</div>}
      </div>
      <div className="sub" style={{ marginTop: 8 }}>
        每个聊天绑定一个对话：直接发文字就是提问；<code>/new</code> 开新对话、<code>/sessions</code> + <code>/use</code> 切换、<code>/stop</code> 中断、<code>/allow</code> / <code>/deny</code> 或按钮处理权限；其它 <code>/命令</code> 原样转给 Claude。
        微信没有开放的机器人接口，暂不支持；企业微信只能推送通知。
      </div>
    </div>
  );
}
