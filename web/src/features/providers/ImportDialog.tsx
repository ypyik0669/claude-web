import { useEffect, useMemo, useState } from 'react';
import type { ImportItem, ImportResult, ImportScan } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { tr } from '@/i18n';

/** What each tool is called here (server/src/import/scan.ts SourceId). */
const TOOL: Record<string, string> = {
  hermes: 'Hermes Agent', 'cc-switch': 'CC Switch', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', qwen: 'Qwen Code',
  cursor: 'Cursor', windsurf: 'Windsurf', kiro: 'Kiro', 'claude-desktop': 'Claude Desktop', vscode: 'VS Code', cline: 'Cline', roo: 'Roo Code',
  continue: 'Continue', zed: 'Zed', goose: 'Goose', ollama: 'Ollama', mirasim: 'Mirasim', 'cherry-studio': 'Cherry Studio',
  cliproxyapi: 'CLIProxyAPI', magpie: 'Magpie',
  'vscode-insiders': 'VS Code Insiders', vscodium: 'VSCodium', trae: 'Trae', antigravity: 'Antigravity', lmstudio: 'LM Studio', pencil: 'Pencil',
};
export const toolName = (id: string) => TOOL[id] ?? id;

/** Which items start ticked: everything this app does not have yet, of the kind the dialog was opened for — not a server whose program is gone. */
export function initialPicks(items: ImportItem[], only?: ImportItem['kind']): Set<string> {
  return new Set(items.filter((i) => !i.already && !i.missing && (!only || i.kind === only)).map((i) => i.key));
}

/**
 * 从其它工具导入 (2026-10-17 user request: Hermes, Mirasim, every other IDE / agent): what other tools on this computer
 * have configured — providers and MCP servers — ticked unless this app has them already; 导入 takes the ticked ones.
 * Opened from 设置 → 模型 → 来源 (providers first) and 自定义 → 连接器 (MCP servers first).
 */
export function ImportDialog({ only, onClose }: { only?: ImportItem['kind']; onClose: () => void }) {
  const loadProviders = useStore((s) => s.loadProviders);
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);
  useEffect(() => {
    ws.request<ImportScan>({ kind: 'import.scan' }).then((s) => { setScan(s); setPicked(initialPicks(s.items, only)); }).catch((e) => setErr(String(e?.message ?? e)));
  }, [only]);
  const groups = useMemo(() => {
    const m = new Map<string, ImportItem[]>();
    for (const it of scan?.items ?? []) { const g = m.get(it.from) ?? []; g.push(it); m.set(it.from, g); }
    const rank = (items: ImportItem[]) => (only && !items.some((i) => i.kind === only) ? 1 : 0);
    return [...m.entries()].sort((a, b) => rank(a[1]) - rank(b[1]));
  }, [scan, only]);
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const run = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await ws.request<ImportResult>({ kind: 'import.run', keys: [...picked] });
      setDone(r);
      if (r.providers.length) await loadProviders().catch(() => {});
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setBusy(false);
  };
  const nameOf = (key: string) => scan?.items.find((i) => i.key === key)?.name ?? key;
  return (
    <div className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); onClose(); } }}>
      <div className="modal import-dialog" role="dialog" aria-modal="true" aria-label={tr('从其它工具导入')}>
        <h3>{tr('从其它工具导入')}</h3>
        <p className="sub">{tr('读取这台电脑上其它工具（Hermes、CC Switch、Codex、OpenCode、Cursor、Claude Desktop、VS Code、Trae、Pencil、CLIProxyAPI、Magpie…）里配好的供应商和 MCP 服务器。只读它们的文件，不改动；密钥只在本机。')}</p>
        {err && <div className="imp-err">{err}</div>}
        {!scan && !err && <div className="imp-wait"><span className="spin" aria-hidden /> {tr('正在查找…')}</div>}
        {scan && !done && (
          <>
            {groups.length === 0 && <div className="imp-empty">{tr('没找到其它工具的配置。')}</div>}
            <div className="imp-list">
              {groups.map(([from, items]) => (
                <section key={from} className="imp-group" data-from={from}>
                  <h4>{toolName(from)}</h4>
                  {items.map((it) => (
                    <label key={it.key} className={`imp-row${it.already ? ' already' : ''}`} title={it.detail}>
                      <input type="checkbox" checked={picked.has(it.key)} disabled={it.already} onChange={() => toggle(it.key)} />
                      <Icon name={it.kind === 'provider' ? 'cloud' : 'mcp'} size={14} />
                      <span className="nm">{it.name}</span>
                      <span className="kd">{it.kind === 'provider' ? tr('供应商') : 'MCP'}</span>
                      <span className="dt">{it.detail}</span>
                      {it.already ? <span className="tag">{tr('已有')}</span> : it.missing ? <span className="tag warn" title={tr('配置里的程序已经不在这个位置了（多半是插件升级后换了目录），导进来也连不上')}>{tr('程序不在了')}</span> : it.kind === 'provider' && it.models ? <span className="tag">{tr('{n} 个模型', { n: it.models })}</span> : null}
                    </label>
                  ))}
                </section>
              ))}
            </div>
            {scan.unreadable.length > 0 && (
              <div className="imp-note">
                {scan.unreadable.map((u) => (
                  <div key={u.from}>{tr('{tool}：', { tool: toolName(u.from) })}{u.reason === 'encrypted' ? tr('它把设置加密存在自己的数据库里，读不出来；请在它的设置里把地址和密钥复制过来，用「快速添加」。') : tr('它把设置存在浏览器数据库里，不能按文件读取；请在它的设置里把地址和密钥复制过来，用「快速添加」。')}</div>
                ))}
              </div>
            )}
          </>
        )}
        {done && (
          <div className="imp-done" role="status">
            <div>{tr('导入了 {p} 个供应商、{m} 个 MCP 服务器。', { p: done.providers.length, m: done.mcp.length })}</div>
            {done.mcp.length > 0 && <div className="sub">{tr('新的 MCP 服务器从下一个对话起可用。')}</div>}
            {done.skipped.length > 0 && <div className="sub">{tr('已经有的跳过了：{names}', { names: done.skipped.map(nameOf).join('、') })}</div>}
            {done.failed.map((f) => <div key={f.key} className="imp-err">{tr('{name} 没导入：{error}', { name: nameOf(f.key), error: f.error === 'gone' ? tr('在那个工具里已经没有了') : f.error })}</div>)}
          </div>
        )}
        <div className="qc-foot">
          <span className="grow" />
          {done
            ? <button type="button" className="btn primary" onClick={onClose}>{tr('完成')}</button>
            : <>
              <button type="button" className="btn ghost" onClick={onClose}>{tr('取消')}</button>
              <button type="button" className="btn primary" data-act="import" disabled={!scan || picked.size === 0 || busy} onClick={() => void run()}>{busy ? tr('导入中…') : tr('导入 {n} 项', { n: picked.size })}</button>
            </>}
        </div>
      </div>
    </div>
  );
}
