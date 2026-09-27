import type { ToolUseBlock } from '@/model/conversation';
import { useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { CodeBlock } from '../CodeBlock';
import { DiffView, type Hunk } from '../DiffView';
import { Expandable } from '../Expandable';
import { langFromPath } from '../highlight';
import { ErrorPre, ImageGrid } from './McpTool';

export function ReadBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  const st = r?.structured as any;
  const path = String(inp.file_path ?? '');
  if (r?.isError) return <ErrorPre text={r.content} />;
  if (r?.images?.length) {
    const f = st?.file ?? {};
    return (
      <>
        <ImageGrid images={r.images} />
        <div className="tool-meta">{f.type ?? ''}{f.originalSize ? ` · ${(f.originalSize / 1024).toFixed(1)} KB` : ''}{f.dimensions?.originalWidth ? ` · ${f.dimensions.originalWidth}×${f.dimensions.originalHeight}` : ''}</div>
      </>
    );
  }
  if (st?.type === 'notebook' && Array.isArray(st.file?.cells)) {
    return (
      <>
        {st.file.cells.map((c: any, i: number) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <div className="lbl">cell {c.cell_id ?? i} · {c.cell_type}</div>
            {c.cell_type === 'markdown' ? <pre>{c.source}</pre> : <CodeBlock code={String(c.source ?? '')} lang={st.file.language ?? 'python'} maxLines={60} />}
          </div>
        ))}
      </>
    );
  }
  if (!r) return <div className="tool-meta">读取中…</div>;
  const file = st?.type === 'text' ? st.file : undefined;
  const content: string = file?.content ?? stripLineNumbers(r.content);
  const startLine = file?.startLine ?? (inp.offset ? Number(inp.offset) : 1);
  const footer = file ? (
    <span>{file.numLines} / {file.totalLines} 行{file.truncatedByTokenCap ? ' · 已按 token 上限截断' : ''}{inp.limit ? ` · limit ${inp.limit}` : ''}</span>
  ) : null;
  return <CodeBlock code={content} lang={langFromPath(path)} title={path} startLine={startLine} lineNumbers maxLines={80} footer={footer} />;
}

/** The text tool_result of Read is "   12→line" formatted; strip the gutter when we have no structured output. */
function stripLineNumbers(s: string): string {
  if (!/^\s*\d+→/.test(s)) return s;
  return s.split('\n').map((l) => l.replace(/^\s*\d+→/, '')).join('\n');
}

export function WriteBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  const st = r?.structured as any;
  const path = String(inp.file_path ?? '');
  const patch: Hunk[] | undefined = Array.isArray(st?.structuredPatch) && st.structuredPatch.length ? st.structuredPatch : undefined;
  return (
    <>
      {patch ? (
        <DiffView patch={patch} title={`${st.type === 'create' ? '新建' : '更新'} ${path}`} />
      ) : (
        <CodeBlock code={String(inp.content ?? '')} lang={langFromPath(path)} title={path} maxLines={120} />
      )}
      {r?.isError && <ErrorPre text={r.content} />}
    </>
  );
}

export function EditBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  const st = r?.structured as any;
  const path = String(inp.file_path ?? '');
  const patch: Hunk[] | undefined = Array.isArray(st?.structuredPatch) && st.structuredPatch.length ? st.structuredPatch : undefined;
  const edits: any[] = t.name === 'MultiEdit' ? inp.edits ?? [] : [inp];
  return (
    <>
      {patch ? (
        <DiffView patch={patch} title={path} />
      ) : (
        edits.map((e, i) => <DiffView key={i} oldText={String(e.old_string ?? '')} newText={String(e.new_string ?? '')} title={edits.length > 1 ? `${path} · #${i + 1}` : path} collapse={false} />)
      )}
      {st?.userModified && <div className="tool-meta">用户在权限对话框里修改过内容</div>}
      {r?.isError && <ErrorPre text={r.content} />}
    </>
  );
}

export function NotebookBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  const st = r?.structured as any;
  const lang = st?.language ?? 'python';
  const newSrc = String(st?.new_source ?? inp.new_source ?? '');
  const oldSrc = st?.old_source;
  return (
    <>
      <div className="tool-meta">{inp.edit_mode ?? st?.edit_mode ?? 'replace'} · {st?.cell_type ?? inp.cell_type ?? 'code'}{st?.cell_id ? ` · ${st.cell_id}` : ''}</div>
      {oldSrc !== undefined ? <DiffView oldText={String(oldSrc)} newText={newSrc} collapse={false} /> : <CodeBlock code={newSrc} lang={lang} maxLines={80} />}
      {(r?.isError || st?.error) && <ErrorPre text={st?.error ?? r?.content ?? ''} />}
    </>
  );
}

/** Small helper used by search cards: open a path in the inspector. */
export function FileLink({ path, line, children }: { path: string; line?: number; children?: React.ReactNode }) {
  const ctx = usePaneCtx();
  const open = (e: React.MouseEvent) => {
    const st = useStore.getState();
    const sid = ctx?.sessionId ?? st.activeId;
    // plain click → editor tab at the line; Alt+click → inspector (read-only quick look)
    if (e.altKey) { if (sid) useStore.setState({ inspect: { sessionId: sid, file: { path, line } } }); return; }
    st.openTile({ id: `d${Date.now().toString(36)}`, kind: 'doc', path, line }, 'tab');
  };
  return <button className="file-link" onClick={open} title={`${path}
Alt+点击 在详情面板查看`}>{children ?? path}</button>;
}

export function FileContentPreview({ text, path }: { text: string; path?: string }) {
  return (
    <Expandable text={text} lines={40}>
      {(v) => <CodeBlock code={v} lang={langFromPath(path)} title={path} lineNumbers />}
    </Expandable>
  );
}
