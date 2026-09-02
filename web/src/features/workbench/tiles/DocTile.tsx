import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { CodeBlock } from '@/features/chat/CodeBlock';
import { Markdown } from '@/features/chat/Markdown';
import { langFromPath } from '@/features/chat/highlight';
import { basename } from '@/util';
import type { Tile } from '@/model/layout';

/** Read-only document tile (Monaco editing lands in phase 3). */
export function DocTile({ tile }: { tile: Extract<Tile, { kind: 'doc' }> }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'source' | 'preview'>(/\.(md|mdx|markdown)$/i.test(tile.path) ? 'preview' : 'source');
  const load = () => { setErr(''); ws.request<string>({ kind: 'fs.read', path: tile.path }).then(setText).catch((e) => setErr(e.message)); };
  useEffect(load, [tile.path]);
  const isMd = /\.(md|mdx|markdown)$/i.test(tile.path);
  return (
    <div className="doc-tile">
      <div className="doc-head">
        <b>{basename(tile.path)}</b>
        <span className="mono path" title={tile.path}>{tile.path}</span>
        <span className="grow" />
        {isMd && (
          <span className="seg mini">
            <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>预览</button>
            <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')}>源码</button>
          </span>
        )}
        <button className="btn sm ghost" onClick={load}>刷新</button>
        <button className="btn sm ghost" onClick={() => ws.request({ kind: 'shell.open', path: tile.path, app: 'code' }).catch(() => {})}>VS Code</button>
      </div>
      <div className="doc-body">
        {err && <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>}
        {text === null && !err && <div className="empty">读取中…</div>}
        {text !== null && (mode === 'preview' && isMd ? <div className="md-doc"><Markdown text={text} /></div> : <CodeBlock code={text} lang={langFromPath(tile.path)} title={tile.path} lineNumbers className="tall" />)}
      </div>
    </div>
  );
}
