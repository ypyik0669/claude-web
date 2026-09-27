import { useEffect, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { Markdown } from '@/features/chat/Markdown';
import { basename, clsx } from '@/util';
import type { Tile } from '@/model/layout';
import type { FsOpenResult } from '@shared';
import { MonacoEditor, type EditorHandle } from '@/features/editor/MonacoEditor';
import { fileUrl, previewKind } from '@/features/editor/preview';
import { isWithin } from '@/features/paths';

type DocTileModel = Extract<Tile, { kind: 'doc' }>;

const isMd = (p: string) => /\.(md|mdx|markdown)$/i.test(p);
/** Same file? Separator-agnostic; case-folded only for Windows-style paths (macOS / Linux names can differ by case alone). */
const samePath = (a: string, b: string) => isWithin(a, b) && isWithin(b, a);

/** Editable document tile: Monaco + autosave + disk-change detection; images / pdf / media get a preview instead. */
export function DocTile({ tile }: { tile: DocTileModel }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const setDirty = useStore((s) => s.setDocDirty);
  const dirty = useStore((s) => !!s.dirtyDocs[tile.id]);
  const autoSave = useStore((s) => s.settings['ui.autoSave'] !== false);
  const toast = useStore((s) => s.toast);
  const [doc, setDoc] = useState<FsOpenResult | null>(null);
  const [version, setVersion] = useState(0);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>(isMd(tile.path) ? 'preview' : 'edit');
  const [diskChanged, setDiskChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const handle = useRef<EditorHandle | null>(null);
  const latest = useRef(''); // editor text
  const mtime = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kind = previewKind(tile.path);

  const load = async (keepDirty = false) => {
    setErr('');
    try {
      const d = await ws.request<FsOpenResult>({ kind: 'fs.open', path: tile.path });
      mtime.current = d.mtime;
      setDoc(d);
      if (!keepDirty) { latest.current = d.text; setVersion((v) => v + 1); setDirty(tile.id, false); }
      setDiskChanged(false);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => { void load(); }, [tile.path]);

  // disk watcher: silent reload when clean, banner when dirty
  useEffect(() => {
    if (kind !== 'text') return;
    void ws.request({ kind: 'fs.watch', path: tile.path }).catch(() => {});
    const off = ws.on((e) => {
      if (e.kind !== 'fs.changed' || !samePath(e.path, tile.path)) return;
      if (e.type === 'unlink') { setDiskChanged(true); return; }
      ws.request<any>({ kind: 'fs.stat', path: tile.path }).then((st) => {
        if (Math.abs(st.mtime - mtime.current) < 1) return; // our own save
        if (useStore.getState().dirtyDocs[tile.id]) setDiskChanged(true);
        else void load();
      }).catch(() => {});
    });
    return () => { off(); void ws.request({ kind: 'fs.unwatch', path: tile.path }).catch(() => {}); };
  }, [tile.path, kind]);

  const save = async () => {
    if (!doc || saving) return;
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    setSaving(true);
    const text = latest.current;
    try {
      const r = await ws.request<{ mtime: number }>({ kind: 'fs.write', path: tile.path, text, expectMtime: diskChanged ? undefined : mtime.current });
      mtime.current = r.mtime;
      // what is on disk now is the clean baseline — otherwise undoing back to the text as first loaded reads as
      // "clean" (no autosave) while the disk still holds the saved edit
      setDoc((d) => (d ? { ...d, text } : d));
      setDirty(tile.id, latest.current !== text); // keystrokes that landed while the write was in flight stay dirty
      setDiskChanged(false);
    } catch (e: any) {
      if (/磁盘上已被修改/.test(e.message)) setDiskChanged(true);
      else toast(`保存失败：${e.message}`);
    }
    setSaving(false);
  };
  const onChange = (text: string) => {
    latest.current = text;
    const d = text !== doc?.text;
    setDirty(tile.id, d);
    if (autoSave && d && !diskChanged) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save(), 800);
    }
  };
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); setDirty(tile.id, false); }, [tile.id]);

  const title = basename(tile.path);
  if (kind !== 'text') {
    return (
      <div className="doc-tile">
        <div className="doc-head"><b>{title}</b><span className="mono path" title={tile.path}>{tile.path}</span><span className="grow" /><button className="btn sm ghost" onClick={() => ws.request({ kind: 'shell.open', path: tile.path }).catch(() => {})}>系统打开</button></div>
        <div className="doc-body preview">
          {kind === 'image' && <img src={fileUrl(tile.path)} alt={title} onClick={() => useStore.getState().openViewer([fileUrl(tile.path)], 0)} />}
          {kind === 'pdf' && <iframe src={fileUrl(tile.path)} title={title} />}
          {kind === 'video' && <video src={fileUrl(tile.path)} controls />}
          {kind === 'audio' && <audio src={fileUrl(tile.path)} controls />}
          {kind === 'binary' && <div className="empty">二进制文件，无法在这里预览。</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="doc-tile">
      <div className="doc-head">
        <b className={clsx(dirty && 'dirty')}>{title}{dirty ? ' •' : ''}</b>
        <span className="mono path" title={tile.path}>{tile.path}</span>
        <span className="grow" />
        {isMd(tile.path) && (
          <span className="seg mini">
            <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>预览</button>
            <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>编辑</button>
          </span>
        )}
        {!autoSave || dirty ? <button className="btn sm" disabled={!dirty || saving} onClick={save} title="Ctrl+S">{saving ? '保存中…' : '保存'}</button> : null}
        <button className="btn sm ghost" onClick={() => load()} title="从磁盘重新加载">刷新</button>
        <button className="btn sm ghost" onClick={() => ws.request({ kind: 'shell.open', path: tile.path, app: 'code' }).catch(() => {})}>VS Code</button>
      </div>
      {diskChanged && (
        <div className="doc-banner">
          <span>文件在磁盘上被修改了（或被删除）。</span>
          <button className="btn sm" onClick={() => load()}>重新加载（丢弃本地改动）</button>
          <button className="btn sm ghost" onClick={() => { setDiskChanged(false); void save(); }}>用我的版本覆盖</button>
        </div>
      )}
      <div className="doc-body editor">
        {err && <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>}
        {!doc && !err && <div className="empty">读取中…</div>}
        {doc?.binary && <div className="empty">二进制文件，无法编辑。</div>}
        {doc && !doc.binary && (mode === 'preview' && isMd(tile.path) ? (
          <div className="md-doc"><Markdown text={latest.current || doc.text} /></div>
        ) : (
          <MonacoEditor path={tile.path} value={latest.current} version={version} line={tile.line} readOnly={!!doc.truncated} onChange={onChange} onSave={save} onCursor={(line, col) => setPos({ line, col })} onReady={(h) => { handle.current = h; }} />
        ))}
      </div>
      <div className="doc-foot">
        <span>{doc?.truncated ? '文件过大，只读显示前 4MB' : `行 ${pos.line}，列 ${pos.col}`}</span>
        <span className="grow" />
        <span>{autoSave ? (dirty ? '未保存 · 自动保存中' : '已保存') : dirty ? '未保存 (Ctrl+S)' : '已保存'}</span>
        {doc && <span>{doc.size.toLocaleString()} B</span>}
      </div>
    </div>
  );
}
