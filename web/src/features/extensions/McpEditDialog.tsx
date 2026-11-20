import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { trapTab } from '@/ui/focus-trap';
import { Select } from '@/ui/Select';
import { mcpChanged } from '@/features/settings/config-parts';
import { tr } from '@/i18n';

import { buildMcpConfig, renamesOf, toPairs, type McpKind as Kind, type Pair } from './mcp-edit-model';

const SCOPE: Record<string, string> = { user: tr('所有项目'), project: tr('这个项目（.mcp.json）'), local: tr('这个项目（只在这台电脑）') };

function Pairs({ label, rows, set, keyHint }: { label: string; rows: Pair[]; set: (r: Pair[]) => void; keyHint: string }) {
  const upd = (i: number, p: Partial<Pair>) => set(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="mcp-edit-pairs" data-field={label}>
      <div className="mcp-edit-l">{label}</div>
      {rows.map((r, i) => (
        <div key={i} className="mcp-edit-pair">
          <input className="field" value={r.k} placeholder={keyHint} aria-label={tr('名称')} onChange={(e) => upd(i, { k: e.target.value })} />
          <input className="field" value={r.v} placeholder={tr('值')} aria-label={tr('值')} onChange={(e) => upd(i, { v: e.target.value })} onFocus={(e) => { if (e.target.value === '••••••') e.target.select(); }} />
          <button type="button" className="icon-btn xs" title={tr('删除')} aria-label={tr('删除')} onClick={() => set(rows.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>
        </div>
      ))}
      <button type="button" className="link" onClick={() => set([...rows, { k: '', v: '' }])}>{tr('＋ 添加一项')}</button>
    </div>
  );
}

/** 编辑 an installed MCP server: command, arguments, environment variables (or URL and headers), saved where it is. */
export function McpEditDialog({ name, cwd, onClose }: { name: string; cwd?: string; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const box = useRef<HTMLDivElement>(null);
  const [orig, setOrig] = useState<Record<string, any> | null>(null);
  const [scope, setScope] = useState('');
  const [missing, setMissing] = useState('');
  const [kind, setKind] = useState<Kind>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState<Pair[]>([]);
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<Pair[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ws.request<{ scope: string; config: Record<string, any> } | null>({ kind: 'config.mcp.get', name, cwd })
      .then((r) => {
        if (!r) { setMissing(tr('这个 MCP 不在可以修改的配置文件里（比如是插件带的），这里改不了。')); return; }
        const c = r.config;
        setOrig(c); setScope(r.scope);
        setKind(c.type === 'http' || c.type === 'sse' ? c.type : c.url && !c.command ? 'http' : 'stdio');
        setCommand(String(c.command ?? '')); setArgs(Array.isArray(c.args) ? c.args.join('\n') : '');
        setEnv(toPairs(c.env)); setUrl(String(c.url ?? '')); setHeaders(toPairs(c.headers));
      })
      .catch((e) => setMissing(e.message));
  }, [name, cwd]);

  const save = async () => {
    if (!orig) return;
    if (kind === 'stdio' ? !command.trim() : !url.trim()) { toast(kind === 'stdio' ? tr('命令不能为空') : tr('地址不能为空')); return; }
    setBusy(true);
    try {
      const from = kind === 'stdio' ? renamesOf(env) : renamesOf(headers);
      await ws.request({ kind: 'config.mcp.update', name, cwd, from, json: JSON.stringify(buildMcpConfig(orig, { kind, command, args, env, url, headers })) });
      toast(tr('已保存 {name}，新对话起生效', { name }), true);
      mcpChanged();
      onClose();
    } catch (e: any) { toast(e.message); }
    setBusy(false);
  };

  return createPortal(
    <div className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); if (!busy) onClose(); } else trapTab(e, box.current); }}>
      <div ref={box} className="modal dialog mcp-edit" role="dialog" aria-modal="true" aria-label={tr('编辑 {name}', { name })} data-id="mcp-edit">
        <h3>{tr('编辑 {name}', { name })}</h3>
        {missing && <p className="sub">{missing}</p>}
        {!missing && !orig && <p className="sub">{tr('加载中…')}</p>}
        {orig && (
          <>
            <p className="sub">{tr('保存在：{scope}。带密钥的值显示成圆点，不改就保持原样。', { scope: SCOPE[scope] ?? scope })}</p>
            <label className="mcp-edit-row">
              <span className="mcp-edit-l">{tr('连接方式')}</span>
              <Select className="field" value={kind} onValueChange={(v) => setKind(String(v) as Kind)} aria-label={tr('连接方式')} options={[{ value: 'stdio', label: tr('本机命令（stdio）') }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }]} />
            </label>
            {kind === 'stdio' ? (
              <>
                <label className="mcp-edit-row"><span className="mcp-edit-l">{tr('命令')}</span><input className="field" data-field="command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></label>
                <label className="mcp-edit-row"><span className="mcp-edit-l">{tr('参数（一行一个）')}</span><textarea className="field code" data-field="args" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} /></label>
                <Pairs label={tr('环境变量')} rows={env} set={setEnv} keyHint="API_KEY" />
              </>
            ) : (
              <>
                <label className="mcp-edit-row"><span className="mcp-edit-l">{tr('地址')}</span><input className="field" data-field="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
                <Pairs label={tr('请求头')} rows={headers} set={setHeaders} keyHint="Authorization" />
              </>
            )}
          </>
        )}
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{tr('取消')}</button>
          {orig && <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? tr('保存中…') : tr('保存')}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
