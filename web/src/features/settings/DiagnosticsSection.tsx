import { useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { desktop } from '@/desktop';

export function DiagnosticsSection() {
  const [r, setR] = useState<{ dir: string; tar: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const engine = useStore((s) => s.engine);
  const make = async () => {
    setBusy(true);
    try { setR(await ws.request({ kind: 'diag.bundle' })); } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  return (
    <div className="section">
      <h5>诊断包</h5>
      <div className="sub">打包版本信息、引擎、日志尾部、脱敏后的 meta.json 与 settings.json，方便反馈问题。密钥会被打码。</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn sm primary" disabled={busy} onClick={make}>{busy ? '生成中…' : '生成诊断包'}</button>
        {r && <button className="btn sm" onClick={() => ws.request({ kind: 'shell.open', path: r.dir })}>打开目录</button>}
        {r?.tar && <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(r.tar!)}>复制 tar 路径</button>}
      </div>
      {r && <div className="mono sub" style={{ marginTop: 6 }}>{r.tar ?? r.dir}</div>}
      <div className="kv" style={{ marginTop: 10 }}>
        <span className="k">引擎</span><span>{engine ? `${engine.runtime} ${engine.version ?? ''}` : '-'}</span>
        <span className="k">壳</span><span>{desktop ? `桌面 ${desktop.version}` : '浏览器'}</span>
        <span className="k">日志</span><span className="mono">{desktop ? '%APPDATA%\\claude-web\\server.log · main.log' : '服务终端输出'}</span>
      </div>
    </div>
  );
}
