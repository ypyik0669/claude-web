import { useState } from 'react';
import type { ToolUseBlock } from '@/model/conversation';
import { useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { fmtMs, fmtTok } from '@/util';
import { CodeBlock } from '../CodeBlock';
import { Expandable } from '../Expandable';
import { Markdown } from '../Markdown';
import { ErrorPre, JsonTree } from './McpTool';
import { ExtLink } from './WebTools';

/** Sub-agent: brief (prompt) → trail (progress) → result (report + totals). Children are rendered by ToolCard. */
export function AgentBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  const st = r?.structured as any;
  const [showPrompt, setShowPrompt] = useState(false);
  const running = t.status === 'running' || t.status === 'pending' || t.status === 'streaming';
  const ctx = usePaneCtx();
  const task = useStore((s) => { const sid = ctx?.sessionId ?? s.activeId; const a = sid ? s.open[sid] : undefined; if (!a) return undefined; for (const x of a.conv.tasks.values()) if (x.toolUseId === t.id) return x; return undefined; });
  const text = Array.isArray(st?.content) ? st.content.map((c: any) => c.text ?? '').join('\n') : r?.content ?? '';
  return (
    <>
      <div className="agent-brief">
        <button className="link" onClick={() => setShowPrompt(!showPrompt)}>{showPrompt ? '收起指令' : '查看指令'}</button>
        {inp.subagent_type && <span className="badge">{inp.subagent_type}</span>}
        {inp.model && <span className="badge">{inp.model}</span>}
        {inp.run_in_background && <span className="badge">后台</span>}
      </div>
      {showPrompt && <Expandable text={String(inp.prompt ?? '')} lines={20} chars={4000}>{(v) => <div className="tool-md"><Markdown text={v} /></div>}</Expandable>}
      {running && (
        <div className="agent-trail">
          <span className="spinner" />
          <span>{t.progress?.summary ?? task?.summary ?? '子代理工作中…'}</span>
          {(t.progress?.lastTool ?? task?.lastTool) && <span className="badge">{t.progress?.lastTool ?? task?.lastTool}</span>}
          {t.progress?.elapsed ? <span className="tool-meta">{Math.round(t.progress.elapsed)}s</span> : null}
        </div>
      )}
      {r && (r.isError ? <ErrorPre text={r.content} /> : (
        <>
          <Expandable text={text} lines={40} chars={8000} openByDefault={text.length < 3000}>{(v) => <div className="tool-md"><Markdown text={v} /></div>}</Expandable>
          {st && (st.totalToolUseCount !== undefined || st.totalDurationMs !== undefined) && (
            <div className="tool-meta">
              {st.totalToolUseCount !== undefined && <span>{st.totalToolUseCount} 次工具调用</span>}
              {st.totalDurationMs !== undefined && <span> · {fmtMs(st.totalDurationMs)}</span>}
              {st.totalTokens !== undefined && <span> · {fmtTok(st.totalTokens)} tok</span>}
              {st.resolvedModel && <span> · {st.resolvedModel}</span>}
            </div>
          )}
        </>
      ))}
    </>
  );
}

export function TodoBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const st = t.result?.structured as any;
  const todos: any[] = Array.isArray(st?.newTodos) ? st.newTodos : inp.todos ?? [];
  const old: any[] = Array.isArray(st?.oldTodos) ? st.oldTodos : [];
  const oldDone = old.filter((x) => x.status === 'completed').length;
  const done = todos.filter((x) => x.status === 'completed').length;
  return (
    <>
      <ul className="todos">
        {todos.map((td, i) => (
          <li key={i} className={td.status}>
            <span className="tick">{td.status === 'completed' ? '☑' : td.status === 'in_progress' ? '◐' : '☐'}</span>
            <span>{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}</span>
          </li>
        ))}
      </ul>
      <div className="tool-meta">{done}/{todos.length} 完成{st && done > oldDone ? ` · 本次完成 ${done - oldDone}` : ''}</div>
    </>
  );
}

export function PlanBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  return <div className="tool-md"><Markdown text={String(inp.plan ?? '')} /></div>;
}

export function AskUserBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const qs: any[] = inp.questions ?? [];
  const answers: Record<string, string> = inp.answers ?? (t.result?.structured as any)?.answers ?? {};
  return (
    <div className="ask">
      {qs.map((q, i) => (
        <div key={i} className="ask-q">
          <div><span className="badge">{q.header}</span> {q.question}</div>
          <div className="ask-a">{answers[q.question] ? `→ ${answers[q.question]}` : t.result ? '（未回答）' : '等待回答…'}</div>
        </div>
      ))}
    </div>
  );
}

export function ArtifactBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  const url = /https?:\/\/\S+/.exec(r?.content ?? '')?.[0];
  return (
    <>
      <div className="tool-meta">{inp.title ?? inp.name ?? 'artifact'}{inp.expires || inp.ttl ? ` · ${inp.expires ?? inp.ttl}` : ''}</div>
      {url ? (
        <div className="artifact-link">
          <ExtLink href={url}>↗ 打开 Artifact</ExtLink>
          <code>{url}</code>
          <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(url)}>复制链接</button>
        </div>
      ) : r?.isError ? <ErrorPre text={r.content} /> : <div className="tool-meta">{r?.content ?? '上传中…'}</div>}
      {inp.content && <details className="structured"><summary>HTML 源码（{String(inp.content).length} 字符）</summary><CodeBlock code={String(inp.content)} lang="xml" maxLines={200} /></details>}
    </>
  );
}

export function GoalBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  return (
    <>
      <div className="tool-meta">{inp.action ?? inp.command ?? 'goal'}</div>
      {inp.objective && <div className="tool-md"><Markdown text={String(inp.objective)} /></div>}
      {r && (r.isError ? <ErrorPre text={r.content} /> : <Expandable text={r.content} lines={30}>{(v) => <div className="tool-md"><Markdown text={v} /></div>}</Expandable>)}
    </>
  );
}

export function WorkflowBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  return (
    <>
      {inp.script ? <CodeBlock code={String(inp.script)} lang="javascript" title={inp.name ? `workflow · ${inp.name}` : 'workflow'} maxLines={80} /> : <div className="jt"><JsonTree value={inp} /></div>}
      {r && (r.isError ? <ErrorPre text={r.content} /> : <Expandable text={r.content} lines={30}>{(v) => <CodeBlock code={v} lang="plaintext" title="结果" wrap />}</Expandable>)}
    </>
  );
}
