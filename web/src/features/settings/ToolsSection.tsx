import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import type { ToolInfo } from '@shared';

/** Detects the CLI tools agents lean on (git / gh / node / python / uv / docker / VS Code …) with install hints. */
export function ToolsSection() {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // without the catch a failed detect left 「检测中…」 up forever (tools stayed null)
  const load = () => { setBusy(true); setErr(''); ws.request<ToolInfo[]>({ kind: 'tools.detect' }).then(setTools).catch((e) => { setErr(e.message); setTools((t) => t ?? []); }).finally(() => setBusy(false)); };
  useEffect(load, []);
  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h5 style={{ margin: 0 }}>命令行工具</h5>
        <span className="grow" />
        <button className="btn sm ghost" disabled={busy} onClick={load}>{busy ? '检测中…' : '重新检测'}</button>
      </div>
      <div className="list">
        {(tools ?? []).map((t) => (
          <div key={t.id} className="row" title={t.path}>
            <span className={clsx('dot', t.ok ? 'idle' : 'error')} />
            <div className="grow">
              <div>{t.label} {t.ok && <span className="mono muted" style={{ fontSize: 12 }}>{t.version}</span>}</div>
              <div className="sub">{t.ok ? t.path || '在 PATH 中' : `未安装 · ${t.hint}`}</div>
            </div>
            {!t.ok && <a className="btn sm ghost" href={t.url} target="_blank" rel="noreferrer">下载</a>}
            {!t.ok && /^winget /.test(t.hint) && <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(t.hint.split('，')[0])}>复制命令</button>}
          </div>
        ))}
        {!tools && <div className="empty">检测中…</div>}
        {err && <div className="empty" style={{ color: 'var(--red)' }}>检测失败：{err}</div>}
      </div>
    </div>
  );
}
