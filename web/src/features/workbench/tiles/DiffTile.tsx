import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { DiffView } from '@/features/chat/DiffView';
import { CodeBlock } from '@/features/chat/CodeBlock';
import { langFromPath } from '@/features/chat/highlight';
import { basename } from '@/util';
import type { Tile } from '@/model/layout';

type DiffResult = { kind: 'diff'; text: string } | { kind: 'content'; text: string } | { kind: 'new'; text: string } | { kind: 'clean' } | { kind: 'error'; text: string };

/** `git diff HEAD -- <file>` (or the whole file when untracked / not a repo) as a tile. */
export function DiffTile({ tile }: { tile: Extract<Tile, { kind: 'diff' }> }) {
  const [r, setR] = useState<DiffResult | null>(null);
  const load = () => ws.request<DiffResult>({ kind: 'files.diff', sessionId: tile.sessionId, path: tile.path }).then(setR).catch((e) => setR({ kind: 'error', text: e.message }));
  useEffect(() => { void load(); }, [tile.path, tile.sessionId]);
  return (
    <div className="doc-tile">
      <div className="doc-head">
        <b>± {basename(tile.path)}</b>
        <span className="mono path" title={tile.path}>{tile.path}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={load}>刷新</button>
      </div>
      <div className="doc-body">
        {!r && <div className="empty">加载中…</div>}
        {r?.kind === 'diff' && <DiffView unified={r.text} title={tile.path} collapse />}
        {(r?.kind === 'content' || r?.kind === 'new') && <CodeBlock code={r.text} lang={langFromPath(tile.path)} title={`${r.kind === 'new' ? '新文件 · ' : ''}${tile.path}`} lineNumbers className="tall" />}
        {r?.kind === 'clean' && <div className="empty">相对 HEAD 无改动</div>}
        {r?.kind === 'error' && <div className="empty" style={{ color: 'var(--red)' }}>{r.text}</div>}
      </div>
    </div>
  );
}
