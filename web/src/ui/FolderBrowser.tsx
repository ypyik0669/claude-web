import { useCallback, useEffect, useRef, useState } from 'react';
import type { FsDirs } from '@shared';
import { Icon } from './icons';
import { SwitchChip } from './Switch';
import { imeComposing } from './ime';
import { tr } from '@/i18n';

/** Where the folder browser reads folders and makes new ones (the server the page talks to: ui/pick-folder.ts). */
export interface FolderApi {
  dirs(path?: string): Promise<FsDirs>;
  mkdir(path: string): Promise<void>;
}

/** The parent folder joined with a new name, in the server's separator. */
export function joinDir(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) || dir.endsWith('/') ? dir + name : dir + sep + name;
}

/**
 * A name a new folder can have: not empty, not `.` / `..`, no separators or characters Windows refuses, not a Windows
 * device name (`CON`, `nul.txt`…) and not ending in a dot (Windows makes those, then Explorer cannot open or delete them).
 */
export function folderNameOk(name: string): boolean {
  const n = name.trim();
  if (!n || n === '.' || n === '..' || n.endsWith('.')) return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return false;
  return !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(n);
}

/**
 * The page's own folder browser (issue #12): what `dlg.folder` shows when no native dialog can — a server on Linux
 * without zenity / kdialog or a display, or a browser on another machine (the native one would open on the server's
 * screen). It lists the server's folders, since that is where conversations run.
 */
export function FolderBrowser({ api, start, okLabel, cancelLabel, onDone }: { api: FolderApi; start?: string; okLabel: string; cancelLabel: string; onDone(path: string | null): void }) {
  const [cur, setCur] = useState<FsDirs | null>(null);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const go = useCallback(async (p?: string) => {
    setBusy(true);
    try {
      const d = await api.dirs(p);
      setCur(d); setTyped(d.path); setErr('');
      list.current?.scrollTo?.(0, 0);
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally { setBusy(false); }
  }, [api]);

  useEffect(() => {
    // a start folder that is gone falls back to the home folder
    void api.dirs(start || undefined).catch(() => api.dirs()).then((d) => { setCur(d); setTyped(d.path); }, (e) => setErr((e as Error)?.message || String(e)));
  }, [api, start]);

  const makeDir = async () => {
    if (!cur || naming === null) return;
    if (!folderNameOk(naming)) { setErr(tr('这个名字不能用作文件夹名：不能为空、不能以 . 结尾、不能含 \\ / : * ? " < > |，也不能是 CON、NUL 这类设备名')); return; }
    const p = joinDir(cur.path, naming.trim(), cur.sep);
    try {
      await api.mkdir(p);
      setNaming(null);
      await go(p);
    } catch (e) { setErr((e as Error)?.message || String(e)); }
  };

  // a path typed but not confirmed with Enter is what the user means: go there first, choose it when it opens
  const choose = async () => {
    if (!cur) return;
    const t = typed.trim();
    if (!t || t === cur.path) { onDone(cur.path); return; }
    setBusy(true);
    try { onDone((await api.dirs(t)).path); } catch (e) { setErr((e as Error)?.message || String(e)); } finally { setBusy(false); }
  };

  // the opener (a sidebar button…) keeps the focus otherwise, and Esc pressed there never reaches the dialog
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);

  const shown = cur ? cur.dirs.filter((d) => hidden || !d.startsWith('.')) : [];
  return (
    <div className="folder-browser" ref={root} tabIndex={-1}>
      <div className="fb-bar">
        <button className="icon-btn" title={tr('上一级')} aria-label={tr('上一级')} disabled={!cur?.parent || busy} onClick={() => cur?.parent && void go(cur.parent)}><Icon name="arrowUp" /></button>
        <button className="icon-btn" title={tr('主文件夹')} aria-label={tr('主文件夹')} disabled={!cur || busy} onClick={() => cur && void go(cur.home)}><Icon name="user" /></button>
        <input className="field fb-path" value={typed} spellCheck={false} aria-label={tr('路径')} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) { e.preventDefault(); void go(typed.trim()); } }} />
      </div>
      {cur && cur.roots.length > 1 && (
        <div className="fb-roots">{cur.roots.map((r) => <button key={r} className={`chip${cur.path.toLowerCase().startsWith(r.toLowerCase()) ? ' active' : ''}`} onClick={() => void go(r)}>{r.replace(/\\$/, '')}</button>)}</div>
      )}
      <div className="fb-list" ref={list} role="listbox" aria-label={tr('文件夹')} aria-busy={busy || undefined}>
        {naming !== null && (
          <div className="fb-row fb-new">
            <Icon name="folder" />
            <input className="field" autoFocus value={naming} placeholder={tr('新文件夹的名字')} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => {
              if (imeComposing(e.nativeEvent)) return;
              if (e.key === 'Enter') { e.preventDefault(); void makeDir(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(null); }
            }} />
            <button className="btn" onClick={() => void makeDir()}>{tr('新建')}</button>
          </div>
        )}
        {shown.map((d) => (
          <button key={d} className="fb-row" role="option" aria-selected={false} title={d} onClick={() => cur && void go(joinDir(cur.path, d, cur.sep))}>
            <Icon name="folder" /><span className="fb-name">{d}</span><Icon name="chevronRight" className="fb-go" />
          </button>
        ))}
        {cur && !shown.length && naming === null && <div className="fb-empty">{tr('这里没有子文件夹')}</div>}
      </div>
      {err && <div className="fb-err" role="alert">{err}</div>}
      {/* the tools on the left, the two answers on the right; a narrow dialog puts each pair on its own line (phone.css) */}
      <div className="actions">
        <div className="fb-tools">
          <button className="btn" disabled={!cur || naming !== null} onClick={() => setNaming('')}><Icon name="plus" size={14} /> {tr('新建文件夹')}</button>
          <SwitchChip on={hidden} onChange={setHidden}>{tr('显示隐藏的')}</SwitchChip>
        </div>
        <button className="btn" onClick={() => onDone(null)}>{cancelLabel}</button>
        <button className="btn primary" disabled={!cur || busy} onClick={() => void choose()}>{okLabel}</button>
      </div>
    </div>
  );
}
