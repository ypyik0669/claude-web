import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import type { GatewayStatus } from '@shared';
import { openHub } from '@/features/model-hub/state';
import { tr } from '@/i18n';
import { SwitchChip } from '@/ui/Switch';

/**
 * 设置 → 模型 → 路由 (the old 模型网关 page): the switch, the address and the key, and a way into the section that manages accounts,
 * route groups, keys, the LAN listener and the audit log. Group editing moved there (embedded gateway phase A).
 */
export function GatewaySection() {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<GatewayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => ws.request<GatewayStatus>({ kind: 'gateway.status' }).then(setSt).catch((e) => toast(e.message));
  useEffect(() => {
    void load();
    const off = ws.on((e) => { if (e.kind === 'gateway.changed') void load(); });
    return () => { off(); };
  }, []);
  if (!st) return <div className="section"><div className="empty">{tr('读取中…')}</div></div>;
  const setEnabled = async (on: boolean) => {
    setBusy(true);
    try { setSt(await ws.request<GatewayStatus>({ kind: 'gateway.set', enabled: on })); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const copyKey = async () => {
    try {
      const k = await ws.request<string>({ kind: 'gateway.revealKey' });
      await navigator.clipboard.writeText(k);
      toast(tr('已复制网关密钥'), true);
    } catch (e: any) { toast(e.message); }
  };
  const regen = async () => {
    if (!(await dlg.confirm(tr('重新生成网关密钥？'), { message: tr('旧密钥立即失效。已经在跑的对话要重开才会拿到新密钥；手动配置过的外部工具需要换成新的。'), danger: true, okLabel: tr('重新生成') }))) return;
    try {
      setSt(await ws.request<GatewayStatus>({ kind: 'gateway.regenerateKey' }));
      toast(tr('已生成新密钥。运行中的对话还拿着旧密钥，需要重开才能继续走网关'), true);
    } catch (e: any) { toast(e.message); }
  };
  const members = Object.values(st.states).flat();
  const healthy = members.filter((m) => m.health === 'ok').length;
  const cooling = members.filter((m) => m.health === 'cooling').length;
  return (
    <div className="section gateway">
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <SwitchChip on={st.enabled} disabled={busy} onChange={(on) => void setEnabled(on)}>{tr('启用本机模型网关')}</SwitchChip>
        <span className={clsx('badge', st.enabled && 'ok')}>{st.enabled ? tr('运行中') : tr('关闭')}</span>
      </div>
      <div className="sub" style={{ marginTop: 6 }}>
        {tr('在本机对各个 Agent 同时提供 Anthropic / OpenAI / Gemini 三种接口，后面接你自己的供应商和订阅账号：同协议原样透传，跨协议自动转换；一个组里的成员按顺序故障转移，额度用尽或限流的成员自动冷却。')}
      </div>
      {st.enabled && (
        <div className="gw-endpoint">
          <div className="gw-kv"><span className="muted">{tr('地址')}</span><code>{st.localBaseUrl ?? st.baseUrl.replace(/\/gateway$/, '')}/v1</code></div>
          <div className="gw-kv">
            <span className="muted">{tr('密钥')}</span><code>{st.keyMasked}</code>
            <button className="btn sm ghost" onClick={() => void copyKey()}><Icon name="copy" size={12} /> {tr('复制')}</button>
            <button className="btn sm ghost danger" onClick={() => void regen()}>{tr('重新生成')}</button>
          </div>
          <div className="sub">
            {st.localError
              ? st.localError
              : tr('这是固定地址，重启应用不变。对话里用：在「设置 → 模型 → 来源」新建一个类型为「模型网关」的供应商并选组，Claude / Codex / Gemini 的对话开始时自动拿到地址和密钥。')}
          </div>
        </div>
      )}
      <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 14 }}>
        <span className="sub">{tr('组 {groups} · 正常 {ok} · 冷却 {cooling}', { groups: st.groups.length, ok: healthy, cooling })}</span>
        <span className="grow" />
        <button className="btn sm" onClick={() => { useStore.setState({ settingsOpen: null }); openHub('sources'); }}>{tr('打开上游')}</button>
      </div>
    </div>
  );
}
