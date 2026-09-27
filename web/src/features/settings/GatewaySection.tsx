import { useEffect, useMemo, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { ago, clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import type { GatewayGroup, GatewayMember, GatewayMemberState, GatewayProtocol, GatewayStatus, GatewayTestResult, Provider } from '@shared';

const PROTOCOLS: { id: GatewayProtocol; l: string }[] = [
  { id: 'anthropic', l: 'Anthropic' },
  { id: 'openai', l: 'OpenAI Chat' },
  { id: 'responses', l: 'OpenAI Responses' },
  { id: 'gemini', l: 'Gemini' },
];
const TYPE_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', grok: 'Grok' };

function left(until?: number) {
  if (!until) return '';
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

const since = (t: number) => { const a = ago(t); return a === '刚刚' ? a : `${a}前`; };

/** Settings → 模型网关: switch, endpoint + key, failover groups with live member health. */
export function GatewaySection() {
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.providers);
  const loadProviders = useStore((s) => s.loadProviders);
  const [st, setSt] = useState<GatewayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const load = () => ws.request<GatewayStatus>({ kind: 'gateway.status' }).then(setSt).catch((e) => toast(e.message));
  useEffect(() => {
    void load();
    void loadProviders();
    const off = ws.on((e) => { if (e.kind === 'gateway.changed') void load(); });
    const i = setInterval(() => tick((x) => x + 1), 1000); // cooldown countdowns
    return () => { off(); clearInterval(i); };
  }, []);
  if (!st) return <div className="section"><div className="empty">读取中…</div></div>;

  const setEnabled = async (on: boolean) => { setBusy(true); try { setSt(await ws.request<GatewayStatus>({ kind: 'gateway.set', enabled: on })); } catch (e: any) { toast(e.message); } finally { setBusy(false); } };
  const copyKey = async () => { try { const k = await ws.request<string>({ kind: 'gateway.revealKey' }); await navigator.clipboard.writeText(k); toast('已复制网关密钥', true); } catch (e: any) { toast(e.message); } };
  const regen = async () => {
    if (!(await dlg.confirm('重新生成网关密钥？', { message: '旧密钥立即失效。已经在跑的会话要重开才会拿到新密钥；手动配置过的外部工具需要换成新的。', danger: true, okLabel: '重新生成' }))) return;
    try { setSt(await ws.request<GatewayStatus>({ kind: 'gateway.regenerateKey' })); toast('已生成新密钥', true); } catch (e: any) { toast(e.message); }
  };
  const addGroup = async () => {
    const name = await dlg.prompt('组名称', '默认组');
    if (!name) return;
    try { await ws.request({ kind: 'gateway.groups.upsert', group: { name, strategy: 'failover', members: [] } }); } catch (e: any) { toast(e.message); }
  };
  const members = providers.filter((p) => p.type !== 'gateway');

  return (
    <div className="section gateway">
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <label className="chip"><input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} /> 启用本机模型网关</label>
        <span className={clsx('badge', st.enabled && 'ok')}>{st.enabled ? '运行中' : '关闭'}</span>
      </div>
      <div className="sub" style={{ marginTop: 6 }}>
        在本机对 agent 同时提供 Anthropic / OpenAI / Gemini 三种接口，后面接你自己的供应商档案：同协议原样透传（中转的指纹检查照样通过），跨协议自动转换；一个组里的成员按顺序故障转移，额度用尽或限流的成员自动冷却。只接受本机回环连接，局域网监听器上不可见。
        不转发任何订阅登录（claude.ai / ChatGPT / Google 账号）—— 只用你配置的 API 档案。
      </div>
      {st.enabled && (
        <div className="gw-endpoint">
          <div className="gw-kv"><span className="muted">地址</span><code>{st.baseUrl}/&lt;组 id&gt;</code></div>
          <div className="gw-kv">
            <span className="muted">密钥</span><code>{st.keyMasked}</code>
            <button className="btn sm ghost" onClick={copyKey}><Icon name="copy" size={12} /> 复制</button>
            <button className="btn sm ghost danger" onClick={regen}>重新生成</button>
          </div>
          <div className="sub">会话里用：在「供应商 / 环境」新建类型为「模型网关」的档案并选组，Claude / Codex / Gemini 会话开的时候自动拿到地址和密钥（桌面版端口每次启动会变，所以别手抄地址）。</div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 6 }}>
        <h5 style={{ margin: 0 }}>故障转移组</h5>
        <span className="grow" />
        <button className="btn sm ghost" onClick={addGroup}><Icon name="plus" size={12} /> 新建组</button>
      </div>
      {!st.groups.length && <div className="empty">还没有组。新建一个，把几个供应商档案按优先级拖进去。</div>}
      {st.groups.map((g) => <GroupCard key={g.id} group={g} states={st.states[g.id] ?? []} providers={members} enabled={st.enabled} baseUrl={st.baseUrl} />)}
    </div>
  );
}

function GroupCard({ group, states, providers, enabled, baseUrl }: { group: GatewayGroup; states: GatewayMemberState[]; providers: Provider[]; enabled: boolean; baseUrl: string }) {
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState<GatewayGroup>(group);
  const [dirty, setDirty] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [proto, setProto] = useState<GatewayProtocol>('anthropic');
  const [test, setTest] = useState<GatewayTestResult | 'running' | null>(null);
  const [mapRows, setMapRows] = useState<[string, string][]>(Object.entries(group.modelMap ?? {}));
  useEffect(() => { if (!dirty) { setDraft(group); setMapRows(Object.entries(group.modelMap ?? {})); } }, [group]);
  const edit = (patch: Partial<GatewayGroup>) => { setDraft((d) => ({ ...d, ...patch })); setDirty(true); };
  const setMember = (i: number, patch: Partial<GatewayMember>) => edit({ members: draft.members.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const byId = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const stateOf = (pid: string) => states.find((s) => s.providerId === pid);
  const addable = providers.filter((p) => !draft.members.some((m) => m.providerId === p.id));

  const save = async () => {
    try {
      const modelMap = Object.fromEntries(mapRows.filter(([k, v]) => k.trim() && v.trim()));
      await ws.request({ kind: 'gateway.groups.upsert', group: { ...draft, modelMap } });
      setDirty(false);
      toast(`已保存「${draft.name}」`, true);
    } catch (e: any) { toast(e.message); }
  };
  const remove = async () => {
    if (!(await dlg.confirm(`删除组「${group.name}」？`, { message: '引用它的「模型网关」档案会失效，用它的新会话会报错。', danger: true, okLabel: '删除' }))) return;
    await ws.request({ kind: 'gateway.groups.remove', id: group.id }).catch((e) => toast(e.message));
  };
  const runTest = async () => {
    if (dirty) await save();
    setTest('running');
    try { setTest(await ws.request<GatewayTestResult>({ kind: 'gateway.test', groupId: group.id, protocol: proto })); } catch (e: any) { setTest({ ok: false, status: 0, ms: 0, error: e.message }); }
  };
  const drop = (to: number) => {
    if (dragFrom === null || dragFrom === to) return;
    const list = [...draft.members];
    const [m] = list.splice(dragFrom, 1);
    list.splice(to, 0, m);
    edit({ members: list });
    setDragFrom(null);
  };

  return (
    <div className="gw-group">
      <div className="gw-group-head">
        <input className="field" style={{ width: 180 }} value={draft.name} onChange={(e) => edit({ name: e.target.value })} aria-label="组名称" />
        <select className="field" value={draft.strategy} onChange={(e) => edit({ strategy: e.target.value as GatewayGroup['strategy'] })} aria-label="策略">
          <option value="failover">按顺序故障转移</option>
          <option value="round-robin">加权轮询</option>
        </select>
        <code className="muted" title="这个组的入口地址">{baseUrl}/{group.id}</code>
        <span className="grow" />
        <button className="btn sm ghost danger" onClick={remove}>删除</button>
      </div>

      <div className="gw-members">
        {draft.members.map((m, i) => {
          const p = byId.get(m.providerId);
          const s = stateOf(m.providerId);
          const health = !p ? 'disabled' : s?.health ?? 'unknown';
          return (
            <div key={m.providerId} className={clsx('gw-member', dragFrom === i && 'dragging')} draggable onDragStart={() => setDragFrom(i)} onDragEnd={() => setDragFrom(null)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(i)}>
              <span className="gw-grip" title="拖动调整顺序"><Icon name="grip" size={14} /></span>
              <span className="gw-order">{i + 1}</span>
              <span className={clsx('dot', health === 'ok' ? 'running' : health === 'cooling' ? 'waiting' : health === 'disabled' ? 'error' : 'idle')} />
              <div className="grow">
                <div>{p?.name ?? '（档案已删除）'} <span className="muted" style={{ fontSize: 11 }}>{p ? TYPE_LABEL[p.type] ?? p.type : ''}</span></div>
                <div className="sub">
                  {health === 'cooling' ? `冷却中 · 还剩 ${left(s?.cooldownUntil)}` : health === 'disabled' ? '已停用' : health === 'ok' ? `正常${s?.lastOkAt ? ` · ${since(s.lastOkAt)}` : ''}` : '未使用'}
                  {s?.lastError ? ` · ${s.lastError}` : ''}
                </div>
              </div>
              <input className="field" style={{ width: 150 }} placeholder="固定模型（可选）" value={m.model ?? ''} onChange={(e) => setMember(i, { model: e.target.value })} list={`gw-models-${m.providerId}`} aria-label="固定模型" />
              <datalist id={`gw-models-${m.providerId}`}>{(p?.models ?? []).map((x) => <option key={x} value={x} />)}</datalist>
              {draft.strategy === 'round-robin' && <input className="field" style={{ width: 52 }} type="number" min={1} value={m.weight ?? 1} onChange={(e) => setMember(i, { weight: Math.max(1, Number(e.target.value) || 1) })} title="权重" aria-label="权重" />}
              {(health === 'cooling' || health === 'disabled') && p && <button className="btn sm ghost" onClick={() => ws.request({ kind: 'gateway.reset', groupId: group.id, providerId: m.providerId }).catch((e) => toast(e.message))}>恢复</button>}
              <button className="icon-btn xs" onClick={() => edit({ members: draft.members.filter((_, j) => j !== i) })} aria-label="移出组"><Icon name="close" size={12} /></button>
            </div>
          );
        })}
        {!draft.members.length && <div className="empty">组里还没有成员</div>}
        {addable.length > 0 && (
          <select className="field gw-add" value="" onChange={(e) => { if (e.target.value) edit({ members: [...draft.members, { providerId: e.target.value }] }); }}>
            <option value="">＋ 添加供应商档案…</option>
            {addable.map((p) => <option key={p.id} value={p.id}>{p.name}（{TYPE_LABEL[p.type] ?? p.type}）</option>)}
          </select>
        )}
      </div>

      <div className="gw-map">
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>模型映射（入口模型 → 出口模型，支持 <code>*</code> 通配；成员的「固定模型」优先）</div>
        {mapRows.map(([k, v], i) => (
          <div key={i} className="gw-map-row">
            <input className="field" value={k} placeholder="claude-*sonnet*" onChange={(e) => { setMapRows(mapRows.map((r, j) => (j === i ? [e.target.value, r[1]] : r))); setDirty(true); }} aria-label="入口模型" />
            <Icon name="arrowRight" size={12} />
            <input className="field" value={v} placeholder="gpt-4.1" onChange={(e) => { setMapRows(mapRows.map((r, j) => (j === i ? [r[0], e.target.value] : r))); setDirty(true); }} aria-label="出口模型" />
            <button className="icon-btn xs" onClick={() => { setMapRows(mapRows.filter((_, j) => j !== i)); setDirty(true); }} aria-label="删除映射"><Icon name="close" size={12} /></button>
          </div>
        ))}
        <button className="btn sm ghost" onClick={() => setMapRows([...mapRows, ['', '']])}><Icon name="plus" size={12} /> 添加映射</button>
      </div>

      <div className="gw-actions">
        <button className="btn sm primary" disabled={!dirty} onClick={save}>{dirty ? '保存' : '已保存'}</button>
        <span className="grow" />
        <select className="field" value={proto} onChange={(e) => setProto(e.target.value as GatewayProtocol)} aria-label="测试入口协议">{PROTOCOLS.map((p) => <option key={p.id} value={p.id}>{p.l} 入口</option>)}</select>
        <button className="btn sm" disabled={!enabled || !draft.members.length || test === 'running'} onClick={runTest}>{test === 'running' ? '测试中…' : '测试'}</button>
      </div>
      {test && test !== 'running' && (
        <div className={clsx('gw-test', test.ok ? 'ok' : 'err')}>
          {test.ok ? `通过 · 走了「${test.member}」${test.switches ? `（切换 ${test.switches} 次）` : ''} · ${(test.ms / 1000).toFixed(1)}s · 回复：${test.text}` : `失败${test.status ? ` HTTP ${test.status}` : ''}：${test.error}${test.member ? `（最后尝试「${test.member}」）` : ''}`}
        </div>
      )}
    </div>
  );
}
