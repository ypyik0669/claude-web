import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import type { ImGatewayInfo, ImKind, ImKindDef } from '@shared';
import { ProviderSelect } from '@/features/providers/ProviderSelect';
import { Icon } from '@/ui/icons';
import { MODE_LABEL } from '@/ui/terms';
import { tr } from '@/i18n';
import { Select } from '@/ui/Select';
import { SwitchChip } from '@/ui/Switch';

const MODES = (['default', 'acceptEdits', 'bypassPermissions'] as const).map((m) => [m, MODE_LABEL[m]] as const);

function GatewayCard({ g, def, onChange }: { g: ImGatewayInfo; def: ImKindDef; onChange: () => void }) {
  const toast = useStore((s) => s.toast);
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
  // what 「跟新对话一样」 resolves to right now (the server's RunnerPool.defaultProviderFor)
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const defId = settings.defaultProviderId as string | undefined;
  const sameAsNew = providers.find((p) => p.id === defId)?.name ?? tr('Claude 账号');
  return (
    <div className={clsx('row agent-card', !g.enabled && 'muted')} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={clsx('dot', g.state === 'running' ? 'running' : g.state === 'error' ? 'error' : g.state === 'starting' ? 'waiting' : 'idle')} />
        <span style={{ fontSize: 16 }}>{def.icon}</span>
        <div className="grow">
          <div>{g.name} <span className="muted" style={{ fontSize: 12 }}>{def.name}{g.botName ? ` · ${g.botName}` : ''}</span> {!def.inbound && <span className="badge" style={{ marginLeft: 4 }}>{tr('仅通知')}</span>}</div>
          <div className={clsx('sub', g.state === 'error' && 'err')}>{g.state === 'running' ? tr('已连接 · {allowUsersCount} 个授权用户 · {bindingsCount} 个聊天', { allowUsersCount: g.allowUsers.length, bindingsCount: g.bindings.length }) : g.state === 'error' ? g.error : g.state === 'starting' ? tr('连接中…') : tr('已停止')}</div>
        </div>
        <SwitchChip on={g.enabled} onChange={(on) => patch({ enabled: on })}>{tr('启用')}</SwitchChip>
        <button className="btn sm ghost" disabled={busy || g.state !== 'running'} onClick={test}>{tr('测试')}</button>
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? tr('收起') : tr('配置')}</button>
      </div>
      {open && (
        <div className="agent-form">
          <label>{tr('名称')}<input className="field" value={name} onChange={(e) => setName(e.target.value)} /></label>
          {def.fields.map((fl) => <label key={fl.key}>{fl.label}<input className="field" type={fl.secret ? 'password' : 'text'} value={f[fl.key] ?? ''} onChange={(e) => setF({ ...f, [fl.key]: e.target.value })} placeholder={fl.hint ?? ''} autoComplete="off" /></label>)}
          <label>{tr('默认项目')}<Select className="field" value={g.defaultCwd} onValueChange={(value) => patch({ defaultCwd: String(value) })} aria-label={tr('默认项目')} searchable={workspaces.length > 8} options={[{ value: '', label: tr('第一个项目') }, ...workspaces.map((w) => ({ value: w.path, label: w.name, description: w.path }))]} /></label>
          <label>{tr('权限模式')}<Select className="field" value={g.permissionMode} onValueChange={(value) => patch({ permissionMode: String(value) })} aria-label={tr('权限模式')} options={MODES.map(([v, l]) => ({ value: v, label: l }))} /></label>
          {/* the bot's new conversations: a relay, the account, or whatever a new conversation in the window gets */}
          <label>{tr('用哪个供应商')}<ProviderSelect agent="claude" value={g.providerId ?? ''} onChange={(v) => patch({ providerId: v })} first={{ label: tr('跟新对话一样（{sameAsNew}）', { sameAsNew }), title: tr('和在窗口里开新对话时用的一样') }} own={tr('Claude 账号')} /></label>
          <SwitchChip style={{ alignSelf: 'end' }} on={g.verbose} onChange={(on) => patch({ verbose: on })}>{tr('推送工具调用过程')}</SwitchChip>
          <div style={{ gridColumn: '1 / -1' }} className="sub">{def.help}</div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', gridColumn: '1 / -1' }}>
            <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(tr('删除机器人「{name}」？', { name: g.name }), { danger: true, okLabel: tr('删除') })) await patch(null); }}>{tr('删除')}</button>
            <span className="grow" />
            <button className="btn sm" disabled={busy} onClick={save}>{tr('保存并连接')}</button>
          </div>
          {def.inbound && (
            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b style={{ fontSize: 13 }}>{tr('授权用户')}</b>
                <span className="sub">{tr('在 IM 里给机器人发')} <code>{tr('/pair 配对码')}</code> {tr('即可加入')}</span>
                <span className="grow" />
                <SwitchChip title={tr('危险：任何能和机器人说话的人都能操作')} on={g.openAccess} onChange={(on) => patch({ openAccess: on })}>{tr('不限制用户')}</SwitchChip>
                <button className="btn sm" onClick={async () => { try { setPair(await ws.request({ kind: 'im.pairCode', id: g.id })); } catch (e: any) { toast(e.message); } }}>{tr('生成配对码')}</button>
              </div>
              {pair && left > 0 && <div style={{ marginTop: 6 }}><span className="pair-code" style={{ fontSize: 22 }}>{pair.code}</span> <span className="sub">{tr('{left}s 后失效 · 发送', { left })} <code>/pair {pair.code}</code></span></div>}
              <div className="chips" style={{ marginTop: 6 }}>
                {g.allowUsers.map((u) => <span key={u} className="chip">{g.allowNames?.[u] ?? u} <button className="x" title={tr('移除')} aria-label={tr('移除')} onClick={() => patch({ allowUsers: g.allowUsers.filter((x) => x !== u) })}><Icon name="close" size={10} /></button></span>)}
                {g.allowUsers.length === 0 && <span className="sub">{tr('还没有授权用户')}</span>}
              </div>
              {g.bindings.length > 0 && <div className="sub" style={{ marginTop: 6 }}>{tr('聊天绑定：')}{g.bindings.map((b) => <span key={b.chatId} className="chip" style={{ marginRight: 4 }}>{b.chatId} → {b.sessionId.slice(0, 8)} <button className="x" title={tr('解除绑定')} aria-label={tr('解除绑定')} onClick={() => ws.request({ kind: 'im.unbind', gatewayId: g.id, chatId: b.chatId }).then(onChange).catch((e) => toast(e.message))}><Icon name="close" size={10} /></button></span>)}</div>}
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
        <h5 style={{ margin: 0 }}>{tr('机器人')}</h5>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 13 }}>{tr('添加')}</span>
        {kinds.map((k) => <button key={k.kind} className="btn sm ghost" onClick={() => add(k.kind)} title={k.help}><Icon name="plus" size={12} /> {k.name}</button>)}
      </div>
      <div className="list">
        {list.map((g) => { const def = kinds.find((k) => k.kind === g.kind); return def ? <GatewayCard key={g.id} g={g} def={def} onChange={load} /> : null; })}
        {list.length === 0 && <div className="empty">{tr('还没有机器人。点上面的按钮添加一个：Telegram 最简单（找 @BotFather 要个 token）。')}</div>}
      </div>
      <div className="sub" style={{ marginTop: 8 }}>
        {tr('每个聊天绑定一个对话：直接发文字就是提问；')}<code>/new</code> {tr('开新对话、')}<code>/sessions</code> + <code>/use</code> {tr('切换、')}<code>/stop</code> {tr('中断、')}<code>/allow</code> / <code>/deny</code> {tr('或按钮处理权限；其它')} <code>{tr('/命令')}</code> {tr('原样转给 Claude。 微信没有开放的机器人接口，暂不支持；企业微信只能推送通知。')}
      </div>
    </div>
  );
}
