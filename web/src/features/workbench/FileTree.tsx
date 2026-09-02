import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';

interface Entry { name: string; dir: boolean }

function join(dir: string, name: string) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function Node({ path, name, depth, filter }: { path: string; name: string; depth: number; filter: string }) {
  const [open, setOpen] = useState(depth === 0);
  const [kids, setKids] = useState<Entry[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open || kids) return;
    ws.request<Entry[]>({ kind: 'fs.list', path }).then(setKids).catch((e) => setErr(e.message));
  }, [open, path]);
  const visible = kids?.filter((k) => !filter || k.dir || k.name.toLowerCase().includes(filter));
  return (
    <div>
      {depth > 0 && (
        <div className="ft-row" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => setOpen(!open)}>
          <span className="chev" style={{ transform: open ? 'rotate(90deg)' : undefined }}>▶</span>
          <span className="ic">{open ? '📂' : '📁'}</span>
          <span className="t">{name}</span>
        </div>
      )}
      {open && err && <div className="ft-row" style={{ paddingLeft: 6 + (depth + 1) * 12, color: 'var(--red)' }}>{err}</div>}
      {open && visible?.map((k) => (k.dir ? (
        <Node key={k.name} path={join(path, k.name)} name={k.name} depth={depth + 1} filter={filter} />
      ) : (
        <FileRow key={k.name} path={join(path, k.name)} name={k.name} depth={depth + 1} />
      )))}
    </div>
  );
}

function FileRow({ path, name, depth }: { path: string; name: string; depth: number }) {
  const openTile = useStore((s) => s.openTile);
  const [menu, setMenu] = useState(false);
  return (
    <div className={clsx('ft-row file')} style={{ paddingLeft: 6 + depth * 12 }} onClick={(e) => openTile({ id: `d${Date.now()}`, kind: 'doc', path }, e.ctrlKey ? 'tab' : 'tab')} onContextMenu={(e) => { e.preventDefault(); setMenu(!menu); }} title={path}>
      <span className="ic">📄</span>
      <span className="t">{name}</span>
      {menu && (
        <div className="menu" style={{ right: 8, top: 22 }} onMouseLeave={() => setMenu(false)} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setMenu(false); openTile({ id: `d${Date.now()}`, kind: 'doc', path }, 'tab'); }}>打开</button>
          <button onClick={() => { setMenu(false); ws.request({ kind: 'shell.open', path, app: 'code' }).catch(() => {}); }}>在 VS Code 打开</button>
          <button onClick={() => { setMenu(false); navigator.clipboard.writeText(path); }}>复制路径</button>
        </div>
      )}
    </div>
  );
}

/** Workspace file explorer (read-only in phase 2; file operations and search land in phase 3). */
export function FileTree({ root }: { root: string }) {
  const [filter, setFilter] = useState('');
  if (!root) return <div className="empty">没有工作目录</div>;
  return (
    <div className="filetree">
      <div className="ft-head">
        <input className="field" placeholder="筛选文件名…" value={filter} onChange={(e) => setFilter(e.target.value.toLowerCase())} />
      </div>
      <div className="ft-body">
        <Node path={root} name={root} depth={0} filter={filter} />
      </div>
    </div>
  );
}
