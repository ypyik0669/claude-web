import { useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import type { FsEntry, GitFileStatus, GitStatus } from '@shared';
import { MIME_SESSION } from './dnd';
import { dlg } from '@/ui/dialog';

function join(dir: string, name: string) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
const parentOf = (p: string) => p.replace(/[\\/][^\\/]+$/, '');
const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

interface Ctx {
  root: string;
  filter: string;
  git: Map<string, GitFileStatus>; // normalized abs path -> status
  gitDirs: Set<string>; // normalized dirs that contain changes
  reload: (dir: string) => void;
  tick: Record<string, number>; // dir -> reload counter
  menu: { path: string; dir: boolean; x: number; y: number } | null;
  setMenu: (m: Ctx['menu']) => void;
  editing: { path: string; mode: 'rename' | 'newFile' | 'newDir' } | null;
  setEditing: (e: Ctx['editing']) => void;
  selected: string | null;
  setSelected: (p: string) => void;
}

const BADGE: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!', typechange: 'T' };

function InlineInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); const dot = initial.lastIndexOf('.'); ref.current?.setSelectionRange(0, dot > 0 ? dot : initial.length); }, []);
  return <input ref={ref} className="ft-input" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v.trim() || null)} onKeyDown={(e) => { if (e.key === 'Enter') onDone(v.trim() || null); if (e.key === 'Escape') onDone(null); }} onClick={(e) => e.stopPropagation()} />;
}

function Node({ path, name, depth, ctx, forceOpen }: { path: string; name: string; depth: number; ctx: Ctx; forceOpen?: boolean }) {
  const [open, setOpen] = useState(depth === 0);
  const [kids, setKids] = useState<FsEntry[] | null>(null);
  const [err, setErr] = useState('');
  const isOpen = open || !!forceOpen || (!!ctx.filter && ctx.gitDirs.size === 0 ? open : open);
  const load = () => ws.request<FsEntry[]>({ kind: 'fs.list', path }).then(setKids).catch((e) => setErr(e.message));
  useEffect(() => { if (isOpen) void load(); }, [isOpen, path, ctx.tick[norm(path)]]);
  const visible = useMemo(() => kids?.filter((k) => !ctx.filter || k.dir || k.name.toLowerCase().includes(ctx.filter)), [kids, ctx.filter]);
  const changed = ctx.gitDirs.has(norm(path));
  const sel = ctx.selected === path;
  return (
    <div>
      {depth > 0 && (
        <div className={clsx('ft-row', sel && 'sel', changed && 'changed')} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => { setOpen(!open); ctx.setSelected(path); }} onContextMenu={(e) => { e.preventDefault(); ctx.setSelected(path); ctx.setMenu({ path, dir: true, x: e.clientX, y: e.clientY }); }} title={path}>
          <span className="chev" style={{ transform: isOpen ? 'rotate(90deg)' : undefined }}>▶</span>
          <span className="ic">{isOpen ? '📂' : '📁'}</span>
          {ctx.editing?.path === path && ctx.editing.mode === 'rename' ? (
            <InlineInput initial={name} onDone={async (v) => { ctx.setEditing(null); if (v && v !== name) { await ws.request({ kind: 'fs.rename', from: path, to: join(parentOf(path), v) }).catch((e) => useStore.getState().toast(e.message)); ctx.reload(parentOf(path)); } }} />
          ) : <span className="t">{name}</span>}
        </div>
      )}
      {isOpen && ctx.editing && ctx.editing.path === path && ctx.editing.mode !== 'rename' && (
        <div className="ft-row" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>
          <span className="chev" style={{ visibility: 'hidden' }}>▶</span>
          <span className="ic">{ctx.editing.mode === 'newDir' ? '📁' : '📄'}</span>
          <InlineInput initial="" onDone={async (v) => { const mode = ctx.editing!.mode; ctx.setEditing(null); if (!v) return; const target = join(path, v); await ws.request(mode === 'newDir' ? { kind: 'fs.mkdir', path: target } : { kind: 'fs.create', path: target }).catch((e) => useStore.getState().toast(e.message)); ctx.reload(path); if (mode === 'newFile') useStore.getState().openTile({ id: `d${Date.now()}`, kind: 'doc', path: target }, 'tab'); }} />
        </div>
      )}
      {isOpen && err && <div className="ft-row" style={{ paddingLeft: 6 + (depth + 1) * 12, color: 'var(--red)' }}>{err}</div>}
      {isOpen && visible?.map((k) => (k.dir ? (
        <Node key={k.name} path={join(path, k.name)} name={k.name} depth={depth + 1} ctx={ctx} />
      ) : (
        <FileRow key={k.name} entry={k} path={join(path, k.name)} depth={depth + 1} ctx={ctx} />
      )))}
      {isOpen && visible && !visible.length && !err && depth > 0 && <div className="ft-row muted" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>（空）</div>}
    </div>
  );
}

function FileRow({ entry, path, depth, ctx }: { entry: FsEntry; path: string; depth: number; ctx: Ctx }) {
  const openTile = useStore((s) => s.openTile);
  const g = ctx.git.get(norm(path));
  const sel = ctx.selected === path;
  return (
    <div
      className={clsx('ft-row file', sel && 'sel', g && `git-${g.status}`)}
      style={{ paddingLeft: 6 + depth * 12 }}
      onClick={(e) => { ctx.setSelected(path); openTile({ id: `d${Date.now()}`, kind: 'doc', path }, e.ctrlKey || e.metaKey ? 'tab' : 'tab'); }}
      onContextMenu={(e) => { e.preventDefault(); ctx.setSelected(path); ctx.setMenu({ path, dir: false, x: e.clientX, y: e.clientY }); }}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', path); e.dataTransfer.setData(MIME_SESSION + '-file', path); }}
      title={`${path}${entry.size !== undefined ? ` · ${entry.size.toLocaleString()} B` : ''}`}
    >
      <span className="chev" style={{ visibility: 'hidden' }}>▶</span>
      <span className="ic">📄</span>
      {ctx.editing?.path === path && ctx.editing.mode === 'rename' ? (
        <InlineInput initial={entry.name} onDone={async (v) => { ctx.setEditing(null); if (v && v !== entry.name) { await ws.request({ kind: 'fs.rename', from: path, to: join(parentOf(path), v) }).catch((e) => useStore.getState().toast(e.message)); ctx.reload(parentOf(path)); } }} />
      ) : <span className="t">{entry.name}</span>}
      {g && <span className="gb" title={g.status}>{BADGE[g.status]}</span>}
    </div>
  );
}

function ContextMenu({ m, ctx, onClose }: { m: NonNullable<Ctx['menu']>; ctx: Ctx; onClose: () => void }) {
  const st = useStore.getState();
  useEffect(() => {
    const k = () => onClose();
    window.addEventListener('click', k);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('click', k); window.removeEventListener('keydown', k); };
  }, [onClose]);
  const dir = m.dir ? m.path : parentOf(m.path);
  const act = (fn: () => unknown) => (e: React.MouseEvent) => { e.stopPropagation(); onClose(); void fn(); };
  const copyPath = async () => {
    const base = join(dir, `${m.path.split(/[\\/]/).pop()!.replace(/(\.[^.]*)?$/, ' copy$1')}`);
    await ws.request({ kind: 'fs.copy', from: m.path, to: base }).catch((e) => st.toast(e.message));
    ctx.reload(dir);
  };
  const trash = async () => {
    if (!(await dlg.confirm('移到回收站？', { message: m.path, danger: true, okLabel: '移到回收站' }))) return;
    await ws.request({ kind: 'fs.trash', paths: [m.path] }).catch((e) => st.toast(e.message));
    ctx.reload(parentOf(m.path));
  };
  return (
    <div className="menu" style={{ position: 'fixed', left: Math.min(m.x, window.innerWidth - 220), top: Math.min(m.y, window.innerHeight - 320) }} onClick={(e) => e.stopPropagation()}>
      {!m.dir && <button onClick={act(() => st.openTile({ id: `d${Date.now()}`, kind: 'doc', path: m.path }, 'tab'))}>打开</button>}
      {!m.dir && <button onClick={act(() => { const before = st.layout; st.dispatchLayout({ t: 'pane.split', paneId: (st.layout.groups.find((g) => g.id === st.layout.activeGroupId) ?? st.layout.groups[0]).focusedPaneId, dir: 'row' }); if (useStore.getState().layout !== before) useStore.getState().openTile({ id: `d${Date.now()}`, kind: 'doc', path: m.path }, 'replace'); })}>在右侧分屏打开</button>}
      {!m.dir && ctx.git.get(norm(m.path)) && <button onClick={act(() => st.openTile({ id: `df${Date.now()}`, kind: 'diff', sessionId: '', path: m.path }, 'tab'))}>查看改动 (diff)</button>}
      <button onClick={act(() => ctx.setEditing({ path: dir, mode: 'newFile' }))}>新建文件</button>
      <button onClick={act(() => ctx.setEditing({ path: dir, mode: 'newDir' }))}>新建文件夹</button>
      <button onClick={act(() => ctx.setEditing({ path: m.path, mode: 'rename' }))}>重命名 (F2)</button>
      {!m.dir && <button onClick={act(copyPath)}>创建副本</button>}
      <button onClick={act(() => navigator.clipboard.writeText(m.path))}>复制路径</button>
      <button onClick={act(() => navigator.clipboard.writeText(m.path.slice(ctx.root.length).replace(/^[\\/]/, '')))}>复制相对路径</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: m.dir ? m.path : parentOf(m.path) }))}>在资源管理器显示</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: m.path, app: 'code' }))}>在 VS Code 打开</button>
      {m.dir && <button onClick={act(() => st.openTile({ id: `t${Date.now()}`, kind: 'term', cwd: m.path }, 'tab'))}>在这里开终端</button>}
      <button className="danger" onClick={act(trash)}>移到回收站</button>
    </div>
  );
}

/** Workspace explorer: lazy directory nodes, git status badges, inline create / rename, recycle-bin delete, live refresh. */
export function FileTree({ root, gitStatus }: { root: string; gitStatus?: GitStatus | null }) {
  const [filter, setFilter] = useState('');
  const [tick, setTick] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<Ctx['menu']>(null);
  const [editing, setEditing] = useState<Ctx['editing']>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const reload = (dir: string) => setTick((t) => ({ ...t, [norm(dir)]: (t[norm(dir)] ?? 0) + 1 }));

  // watch the root shallowly + any dir we reloaded; fs.changed for a path → reload its parent
  useEffect(() => {
    if (!root) return;
    void ws.request({ kind: 'fs.watch', path: root }).catch(() => {});
    const off = ws.on((e) => { if (e.kind === 'fs.changed' && norm(e.path).startsWith(norm(root))) reload(parentOf(e.path)); });
    return () => { off(); void ws.request({ kind: 'fs.unwatch', path: root }).catch(() => {}); };
  }, [root]);

  // F2 renames the selected entry
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'F2' && selected && !editing && (e.target as HTMLElement)?.closest('.filetree')) { e.preventDefault(); setEditing({ path: selected, mode: 'rename' }); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [selected, editing]);

  const { git, gitDirs } = useMemo(() => {
    const git = new Map<string, GitFileStatus>();
    const gitDirs = new Set<string>();
    if (gitStatus?.root) {
      for (const f of gitStatus.files) {
        const abs = join(gitStatus.root, f.path.replace(/\//g, gitStatus.root.includes('\\') ? '\\' : '/'));
        git.set(norm(abs), f);
        let d = parentOf(abs);
        while (d && d.length >= gitStatus.root.length) { gitDirs.add(norm(d)); const p = parentOf(d); if (p === d) break; d = p; }
      }
    }
    return { git, gitDirs };
  }, [gitStatus]);

  if (!root) return <div className="empty">没有工作目录</div>;
  const ctx: Ctx = { root, filter, git, gitDirs, reload, tick, menu, setMenu, editing, setEditing, selected, setSelected };
  return (
    <div className="filetree">
      <div className="ft-head">
        <input className="field" placeholder="筛选文件名…" value={filter} onChange={(e) => setFilter(e.target.value.toLowerCase())} />
        <button className="icon-btn" title="新建文件" onClick={() => setEditing({ path: selected && git ? (selected && !selected.includes('.') ? selected : parentOf(selected)) : root, mode: 'newFile' })}>＋</button>
        <button className="icon-btn" title="刷新" onClick={() => reload(root)}>↻</button>
      </div>
      <div className="ft-body" onContextMenu={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); setMenu({ path: root, dir: true, x: e.clientX, y: e.clientY }); } }}>
        <Node path={root} name={root} depth={0} ctx={ctx} forceOpen />
      </div>
      {menu && <ContextMenu m={menu} ctx={ctx} onClose={() => setMenu(null)} />}
    </div>
  );
}
