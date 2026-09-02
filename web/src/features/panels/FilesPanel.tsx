import { useEffect, useState } from 'react';
import { useScopedSession } from '@/store';
import { ws } from '@/ws/client';
import { basename } from '@/util';
import { DiffView } from '@/features/chat/Markdown';

interface Changed { path: string; ops: number; tools: string[]; lastTs?: string }

export function FilesPanel() {
  const active = useScopedSession();
  const [files, setFiles] = useState<Changed[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ kind: string; text: string } | null>(null);
  const lastResultId = active?.conv.lastResult?.id;

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => ws.request<Changed[]>({ kind: 'files.changed', sessionId: active.sessionId }).then(setFiles).catch(() => setFiles([])), 800);
    return () => clearTimeout(t);
  }, [active?.sessionId, lastResultId]);

  useEffect(() => {
    if (!sel) return setDiff(null);
    ws.request<{ kind: string; text: string }>({ kind: 'files.diff', sessionId: active!.sessionId, path: sel }).then(setDiff).catch((e) => setDiff({ kind: 'error', text: e.message }));
  }, [sel, lastResultId]);

  if (!active) return <div className="empty">没有活动会话</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="list" style={{ maxHeight: sel ? '40%' : undefined, overflow: 'auto', flex: sel ? undefined : 1 }}>
        {files.map((f) => (
          <div key={f.path} className={`row clickable ${sel === f.path ? 'sel' : ''}`} style={{ background: sel === f.path ? 'var(--bg-3)' : undefined }} onClick={() => setSel(sel === f.path ? null : f.path)} title={f.path}>
            <span>✎</span>
            <div className="grow">
              <div>{basename(f.path)}</div>
              <div className="sub">{f.path}</div>
            </div>
            <span className="badge">{f.ops}</span>
          </div>
        ))}
        {!files.length && <div className="empty">本会话没有改动文件</div>}
      </div>
      {sel && (
        <div style={{ flex: 1, overflow: 'auto', borderTop: '1px solid var(--line)', padding: 8 }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-2)', marginBottom: 6 }}>
            {diff?.kind === 'diff' ? 'git diff HEAD' : diff?.kind === 'new' ? '新文件（未跟踪）' : diff?.kind === 'unchanged' ? '相对 HEAD 无改动' : diff?.kind === 'content' ? '当前内容（不在 git 仓库）' : diff?.kind}
          </div>
          {diff?.kind === 'diff' ? <DiffView unified={diff.text} /> : <pre className="mono" style={{ fontSize: 12 }}>{diff?.text}</pre>}
        </div>
      )}
    </div>
  );
}
