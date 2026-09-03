import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { DiffView } from '@/features/chat/DiffView';
import { CodeBlock } from '@/features/chat/CodeBlock';
import { langFromPath } from '@/features/chat/highlight';
import { useStore } from '@/store';
import { basename } from '@/util';
import type { Tile } from '@/model/layout';

type DiffResult = { kind: 'diff'; text: string } | { kind: 'content'; text: string } | { kind: 'new'; text: string } | { kind: 'unchanged' | 'clean' | 'binary' } | { kind: 'error'; text: string } | { kind: 'commit'; text: string; stat: string };

const dirOf = (p: string) => p.replace(/[\\/][^\\/]+$/, '');

/**
 * Diff tile. Three sources: a commit (`rev`), the index / working tree of a file (`staged`), or the session view
 * (`files.diff` = HEAD vs working tree, full content outside a repo).
 */
export function DiffTile({ tile }: { tile: Extract<Tile, { kind: 'diff' }> }) {
  const [r, setR] = useState<DiffResult | null>(null);
  const openTile = useStore((s) => s.openTile);
  const cwd = tile.cwd ?? dirOf(tile.path);
  const load = () => {
    setR(null);
    const p = tile.rev
      ? ws.request<{ text: string; stat: string }>({ kind: 'git.show', cwd, rev: tile.rev }).then((x) => ({ kind: 'commit', ...x }) as DiffResult)
      : tile.staged !== undefined
        ? ws.request<DiffResult>({ kind: 'git.diff', cwd, path: tile.path.replace(/\\/g, '/').replace(cwd.replace(/\\/g, '/') + '/', ''), staged: tile.staged })
        : ws.request<DiffResult>({ kind: 'files.diff', sessionId: tile.sessionId, path: tile.path });
    p.then(setR).catch((e) => setR({ kind: 'error', text: e.message }));
  };
  useEffect(load, [tile.path, tile.sessionId, tile.staged, tile.rev]);
  // live refresh when git state moves
  useEffect(() => {
    const off = ws.on((e) => { if (e.kind === 'git.changed' || (e.kind === 'fs.changed' && e.path.toLowerCase().replace(/\//g, '\\') === tile.path.toLowerCase().replace(/\//g, '\\'))) load(); });
    return () => { off(); };
  }, [tile.path, tile.staged, tile.rev]);
  const title = tile.rev ? `提交 ${tile.rev.slice(0, 7)}` : `${tile.staged ? '已暂存 · ' : ''}${basename(tile.path)}`;
  return (
    <div className="doc-tile">
      <div className="doc-head">
        <b>± {title}</b>
        <span className="mono path" title={tile.path}>{tile.rev ? cwd : tile.path}</span>
        <span className="grow" />
        {!tile.rev && <button className="btn sm ghost" onClick={() => openTile({ id: `d${Date.now()}`, kind: 'doc', path: tile.path }, 'tab')}>编辑</button>}
        <button className="btn sm ghost" onClick={load}>刷新</button>
      </div>
      <div className="doc-body">
        {!r && <div className="empty">加载中…</div>}
        {r?.kind === 'commit' && (
          <>
            <pre className="commit-stat">{r.stat}</pre>
            {r.text.trim() ? <DiffView unified={r.text} title={tile.rev} collapse /> : <div className="empty">空提交</div>}
          </>
        )}
        {r?.kind === 'diff' && <DiffView unified={r.text} title={tile.path} collapse />}
        {(r?.kind === 'content' || r?.kind === 'new') && <CodeBlock code={r.text} lang={langFromPath(tile.path)} title={`${r.kind === 'new' ? '新文件 · ' : ''}${tile.path}`} lineNumbers className="tall" />}
        {(r?.kind === 'unchanged' || r?.kind === 'clean') && <div className="empty">{tile.staged ? '没有已暂存的改动' : '相对 HEAD 无改动'}</div>}
        {r?.kind === 'binary' && <div className="empty">二进制文件</div>}
        {r?.kind === 'error' && <div className="empty" style={{ color: 'var(--red)' }}>{r.text}</div>}
      </div>
    </div>
  );
}
