import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import type { ProxyStatus } from '@shared';
import { imeComposing } from '@/ui/ime';
import { Row } from './controls';

// 设置 → 供应商 → 网络代理 (server net/proxy.ts). A ladder in rule / PAC mode only sets the system proxy, which Node
// never looks at (user report: 403「所在地区」with the ladder on); the server reads it — or HTTP(S)_PROXY — and hands it
// to every Agent it starts and to its own requests (provider tests, model lists, IM).

type Mode = ProxyStatus['setting'];
const MODES: { id: Mode; l: string }[] = [{ id: 'system', l: '跟随系统' }, { id: 'off', l: '不使用' }, { id: 'custom', l: '自定义' }];
const SOURCE: Record<NonNullable<ProxyStatus['source']>, string> = {
  setting: '你填的地址',
  env: '启动时的环境变量 HTTPS_PROXY',
  system: '系统代理',
  pac: '系统代理的 PAC 脚本',
};

/** The one line under the choice: what is in use now. */
export function proxyLine(st: ProxyStatus): string {
  if (st.active) return `正在使用 ${st.active}（${SOURCE[st.source ?? 'system']}）`;
  if (st.setting === 'off') return '不使用代理：所有请求直连。';
  return '没有检测到代理：所有请求直连。';
}

export function ProxySection() {
  const stored = useStore((s) => s.settings['network.proxy']) as string | undefined;
  const toast = useStore((s) => s.toast);
  const storedMode: Mode = stored === 'off' ? 'off' : stored ? 'custom' : 'system';
  const [picked, setPicked] = useState<Mode>(storedMode);
  const [addr, setAddr] = useState(storedMode === 'custom' ? stored ?? '' : '');
  const [st, setSt] = useState<ProxyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void ws.request<ProxyStatus>({ kind: 'network.proxy' }).then(setSt).catch(() => setSt(null)); }, []);
  useEffect(() => { setPicked(storedMode); if (storedMode === 'custom') setAddr(stored ?? ''); }, [stored]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (value: string) => {
    setBusy(true);
    try {
      const r = await ws.request<ProxyStatus>({ kind: 'settings.set', key: 'network.proxy', value });
      useStore.setState((s) => ({ settings: { ...s.settings, 'network.proxy': value === 'system' ? undefined : value } }));
      setSt(r);
    } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const recheck = async () => {
    setBusy(true);
    try { setSt(await ws.request<ProxyStatus>({ kind: 'network.proxy', refresh: true })); } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const pick = (m: Mode) => { setPicked(m); if (m !== 'custom') void save(m); };

  return (
    <div className="section" data-id="proxy">
      <h5>网络代理</h5>
      <Row label="代理" hint="跟随系统：先看启动时的 HTTPS_PROXY 环境变量，再看系统代理（梯子的「系统代理」开关）。用在所有 Agent 和本机发出的请求上；改动对新开的对话生效，已经在跑的对话重开后才用上。">
        <div className="sp-seg" role="radiogroup" aria-label="代理">
          {MODES.map((o) => <button key={o.id} role="radio" aria-checked={picked === o.id} className={clsx(picked === o.id && 'on')} disabled={busy} onClick={() => pick(o.id)}>{o.l}</button>)}
        </div>
      </Row>
      {picked === 'custom' && (
        <Row label="代理地址" hint="梯子的 HTTP 代理端口，比如 Clash 的 http://127.0.0.1:7890（SOCKS 端口不行）。">
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="field" style={{ width: 220 }} placeholder="http://127.0.0.1:7890" value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && addr.trim()) void save(addr.trim()); }} />
            <button className="btn sm" disabled={busy || !addr.trim()} onClick={() => void save(addr.trim())}>保存</button>
          </div>
        </Row>
      )}
      <div className="sub" style={{ marginTop: 6 }} data-id="proxy-status">
        {st ? proxyLine(st) : '读取中…'}
        {st?.note && <div style={{ color: 'var(--warn)' }}>{st.note}</div>}
        {' '}<button className="link" disabled={busy} onClick={() => void recheck()}>重新检测</button>
      </div>
    </div>
  );
}
