import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { DEFAULT_BROKERS, DEFAULT_STUN, type BrokerDef } from '@anywhere';
import type { AnywhereStatus } from '@shared';
import { useRemoteStatus } from './RemoteSection';
import {
  brokerProblem, cleanBrokers, cleanStun, recentRows, shellUrlProblem, stunProblem, type BrokerDraft,
} from './anywhere';

// 设置 → 手机与其它电脑 → 更多选项: what 在外面也能用 runs on — the signaling brokers, the STUN servers, the phone page
// the QR opens — and its last 20 connections. The network words (MQTT / WebRTC / STUN / ICE) are allowed here and in
// tooltips only (spec §10; wording.test.ts lets this file use them because it draws nothing but a 更多选项 part).
// Each list is saved as a whole with 保存 (a bad row is a sentence, nothing is saved); 恢复默认 removes the setting.

const BROKERS = 'remote.anywhere.brokers';
const STUN = 'remote.anywhere.stun';
const SHELL = 'remote.anywhere.shellUrl';

const draftsOf = (v: unknown): BrokerDraft[] =>
  (Array.isArray(v) ? (v as BrokerDef[]) : DEFAULT_BROKERS).map((d) => ({ name: d.name ?? '', url: d.url ?? '', relay: d.relay === true, ...(d.username !== undefined ? { username: d.username } : {}), ...(d.password !== undefined ? { password: d.password } : {}) }));
const stunOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : DEFAULT_STUN);

/** 通 / 不通 / 连接中… for one broker row, by name (the PC's own list, as it runs now). */
function brokerState(a: AnywhereStatus | undefined, name: string): { t: string; tone: string; title?: string } {
  if (!a?.on) return { t: '—', tone: '', title: '在外面也能用没在运行' };
  const b = a.brokers.find((x) => x.name === name.trim());
  if (!b) return { t: '—', tone: '', title: '保存后才会连接' };
  if (b.ok) return { t: '通', tone: 'ok' };
  if (b.error) return { t: '不通', tone: 'err', title: b.error };
  return { t: '连接中…', tone: '' };
}

export function AnywhereMore() {
  const [st] = useRemoteStatus();
  const toast = useStore((s) => s.toast);
  const setSetting = useStore((s) => s.setSetting);
  const storedBrokers = useStore((s) => s.settings[BROKERS]);
  const storedStun = useStore((s) => s.settings[STUN]);
  const storedShell = useStore((s) => s.settings[SHELL]);
  const [brokers, setBrokers] = useState<BrokerDraft[]>(() => draftsOf(storedBrokers));
  const [stun, setStun] = useState<string[]>(() => stunOf(storedStun));
  const [shell, setShell] = useState('');
  const [err, setErr] = useState<{ brokers?: string; stun?: string; shell?: string }>({});
  // a save, 恢复默认, or another window: the rows start over from what is stored
  useEffect(() => setBrokers(draftsOf(storedBrokers)), [storedBrokers]);
  useEffect(() => setStun(stunOf(storedStun)), [storedStun]);
  const shellNow = st?.anywhere?.shellUrl ?? (typeof storedShell === 'string' ? storedShell : '');
  useEffect(() => setShell(shellNow), [shellNow]);

  const save = async (key: string, value: unknown, which: keyof typeof err) => {
    setErr((e) => ({ ...e, [which]: undefined }));
    try { await setSetting(key, value); toast(value === undefined ? '已恢复默认' : '已保存', true); } catch (e: any) { toast(e.message); }
  };
  const saveBrokers = () => { const why = brokerProblem(brokers); if (why) return setErr((e) => ({ ...e, brokers: why })); void save(BROKERS, cleanBrokers(brokers), 'brokers'); };
  const saveStun = () => { const why = stunProblem(stun); if (why) return setErr((e) => ({ ...e, stun: why })); void save(STUN, cleanStun(stun), 'stun'); };
  const saveShell = () => { const why = shellUrlProblem(shell); if (why) return setErr((e) => ({ ...e, shell: why })); void save(SHELL, shell.trim(), 'shell'); };
  const editBroker = (i: number, patch: Partial<BrokerDraft>) => setBrokers((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const recent = recentRows(st?.anywhere?.recent, st?.devices ?? []);

  return (
    <div className="section aw-more">
      <h5>牵线服务器（MQTT）{!Array.isArray(storedBrokers) && <span className="faint aw-def">默认</span>}</h5>
      <div className="sub">手机和电脑都连这些公共服务器来找到对方（MQTT over WSS），按顺序优先。它们只看到哈希过的频道名、加密后数据的大小和时间，以及双方的 IP。直连打不通时，慢速转发只走勾了「用于转发」的那几个。</div>
      <div className="list" data-id="anywhere-brokers">
        {brokers.map((r, i) => {
          const s = brokerState(st?.anywhere, r.name);
          return (
            <div key={i} className="aw-row">
              <input className="field aw-name" data-f="name" aria-label="名称" placeholder="名称" value={r.name} onChange={(e) => editBroker(i, { name: e.target.value })} />
              <input className="field aw-url" data-f="url" aria-label="地址" placeholder="wss://broker.example:8084/mqtt" value={r.url} onChange={(e) => editBroker(i, { url: e.target.value })} title={r.username ? `用户名 ${r.username}（保存时保留）` : undefined} />
              <span className={clsx('badge aw-st', s.tone)} title={s.title}>{s.t}</span>
              <label className="aw-relay" title="直连打不通时，慢速转发经这个服务器传数据"><input type="checkbox" data-f="relay" checked={r.relay} onChange={(e) => editBroker(i, { relay: e.target.checked })} />用于转发</label>
              <button className="icon-btn xs" aria-label="删除这一行" title="删除这一行" onClick={() => setBrokers((rows) => rows.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>
            </div>
          );
        })}
      </div>
      {err.brokers && <div className="aw-err" data-id="broker-error">{err.brokers}</div>}
      <div className="aw-actions">
        <button className="btn sm ghost" data-id="broker-add" onClick={() => setBrokers((rows) => [...rows, { name: '', url: '', relay: false }])}><Icon name="plus" size={12} /> 添加</button>
        <button className="btn sm ghost" data-id="broker-default" disabled={!Array.isArray(storedBrokers)} onClick={() => void save(BROKERS, undefined, 'brokers')}>恢复默认</button>
        <button className="btn sm" data-id="broker-save" onClick={saveBrokers}>保存</button>
      </div>

      <h5>STUN 服务器{!Array.isArray(storedStun) && <span className="faint aw-def">默认</span>}</h5>
      <div className="sub">直连（WebRTC）时用它们查出两边在公网上的地址，好让 ICE 打洞。STUN 服务器看得到双方的 IP。只能填 stun: 开头的地址。</div>
      <div className="list" data-id="anywhere-stun">
        {stun.map((s, i) => (
          <div key={i} className="aw-row">
            <input className="field aw-url" aria-label="STUN 地址" placeholder="stun:stun.example.com:3478" value={s} onChange={(e) => setStun((rows) => rows.map((x, j) => (j === i ? e.target.value : x)))} />
            <button className="icon-btn xs" aria-label="删除这一行" title="删除这一行" onClick={() => setStun((rows) => rows.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>
          </div>
        ))}
        {stun.length === 0 && <div className="empty">没有 STUN 服务器：只有同一个网络里能直连，其它情况走慢速转发</div>}
      </div>
      {err.stun && <div className="aw-err" data-id="stun-error">{err.stun}</div>}
      <div className="aw-actions">
        <button className="btn sm ghost" onClick={() => setStun((rows) => [...rows, ''])}><Icon name="plus" size={12} /> 添加</button>
        <button className="btn sm ghost" disabled={!Array.isArray(storedStun)} onClick={() => void save(STUN, undefined, 'stun')}>恢复默认</button>
        <button className="btn sm" onClick={saveStun}>保存</button>
      </div>

      <h5>手机页面地址{typeof storedShell !== 'string' && <span className="faint aw-def">默认</span>}</h5>
      <div className="sub">二维码打开的页面。用自己部署的那份时改这里；已经配对的手机还用原来的页面。</div>
      <div className="aw-row" data-id="anywhere-shell">
        <input className="field aw-url" aria-label="手机页面地址" placeholder="https://example.github.io/claude-web/" value={shell} onChange={(e) => setShell(e.target.value)} />
        <button className="btn sm ghost" disabled={typeof storedShell !== 'string'} onClick={() => void save(SHELL, undefined, 'shell')}>恢复默认</button>
        <button className="btn sm" onClick={saveShell}>保存</button>
      </div>
      {err.shell && <div className="aw-err" data-id="shell-error">{err.shell}</div>}

      <h5>最近 20 次连接</h5>
      <div className="list" data-id="anywhere-recent">
        {recent.map((r) => (
          <div key={r.key} className="row aw-recent">
            <span className={clsx('dot', r.why ? 'error' : 'idle')} />
            <div className="grow">
              <div>{r.who} <span className="muted" style={{ fontSize: 11.5 }}>{r.link} · {r.time}</span></div>
              {r.why && <div className="sub">{r.why}</div>}
            </div>
          </div>
        ))}
        {recent.length === 0 && <div className="empty">还没有连接记录：手机从外面连进来之后会列在这里（只留最近 20 次，重启后清空）</div>}
      </div>
    </div>
  );
}
