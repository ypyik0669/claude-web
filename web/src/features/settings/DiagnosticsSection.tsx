import { useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { desktop } from '@/desktop';
import { tr } from '@/i18n';

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
      <h5>{tr('诊断包')}</h5>
      <div className="sub">{tr('打包版本信息、引擎、日志尾部、脱敏后的 meta.json 与 settings.json，方便反馈问题。密钥会被打码。')}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn sm primary" disabled={busy} onClick={make}>{busy ? tr('生成中…') : tr('生成诊断包')}</button>
        {r && <button className="btn sm" onClick={() => ws.request({ kind: 'shell.open', path: r.dir })}>{tr('打开目录')}</button>}
        {r?.tar && <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(r.tar!)}>{tr('复制 tar 路径')}</button>}
      </div>
      {r && <div className="mono sub" style={{ marginTop: 6 }}>{r.tar ?? r.dir}</div>}
      <div className="kv" style={{ marginTop: 10 }}>
        <span className="k">{tr('引擎')}</span><span>{engine ? `Claude Code ${engine.version ?? ''}` : '-'}</span>
        <span className="k">{tr('壳')}</span><span>{desktop ? tr('桌面 {version}', { version: desktop.version }) : tr('浏览器')}</span>
        <span className="k">{tr('日志')}</span><span className="mono">{desktop ? (desktop.platform === 'win32' ? '%APPDATA%\\claude-web\\server.log · main.log' : desktop.platform === 'darwin' ? '~/Library/Application Support/claude-web/server.log · main.log' : '~/.config/claude-web/server.log · main.log') : tr('服务终端输出')}</span>
      </div>
    </div>
  );
}
