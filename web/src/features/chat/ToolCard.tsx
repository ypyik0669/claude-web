import { memo, useState } from 'react';
import type { ToolUseBlock } from '@/model/conversation';
import { useStore } from '@/store';
import { clsx, toolSummary } from '@/util';
import { DiffView, Markdown } from './Markdown';
import { ItemList } from './ChatView';

const ICON: Record<string, string> = { Artifact: '📦', Goal: '🎯', Workflow: '🧩', WebBrowser: '🌐', Monitor: '👁', SendMessage: '📨', Bash: '$', PowerShell: '>', Read: '📄', Write: '✎', Edit: '✎', MultiEdit: '✎', Glob: '🔍', Grep: '🔍', Agent: '🤖', Task: '🤖', WebFetch: '🌐', WebSearch: '🌐', Skill: '⚡', TodoWrite: '☑', AskUserQuestion: '❓', ExitPlanMode: '📋', EnterPlanMode: '📋' };

function ToolBody({ t }: { t: ToolUseBlock }) {
  const inp = t.input as any;
  const r = t.result;
  switch (t.name) {
    case 'Edit':
    case 'MultiEdit': {
      const edits: any[] = t.name === 'MultiEdit' ? inp.edits ?? [] : [inp];
      return (
        <>
          <div className="lbl">{inp.file_path}</div>
          {edits.map((e, i) => (
            <DiffView key={i} oldText={e.old_string} newText={e.new_string} />
          ))}
          {r?.isError && <pre style={{ color: 'var(--red)' }}>{r.content}</pre>}
        </>
      );
    }
    case 'Write':
      return (
        <>
          <div className="lbl">{inp.file_path}</div>
          <pre>{String(inp.content ?? '').slice(0, 20000)}</pre>
          {r?.isError && <pre style={{ color: 'var(--red)' }}>{r.content}</pre>}
        </>
      );
    case 'TodoWrite':
      return (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {(inp.todos ?? []).map((td: any, i: number) => (
            <li key={i} style={{ textDecoration: td.status === 'completed' ? 'line-through' : undefined, color: td.status === 'in_progress' ? 'var(--yellow)' : undefined }}>
              {td.content}
            </li>
          ))}
        </ul>
      );
    case 'Agent':
    case 'Task':
      return (
        <>
          <div className="lbl">prompt</div>
          <pre>{inp.prompt}</pre>
          {r && (
            <>
              <div className="lbl">result</div>
              <Markdown text={r.content} />
            </>
          )}
        </>
      );
    case 'ExitPlanMode':
      return <Markdown text={inp.plan ?? ''} />;
    case 'Artifact': {
      const url = /https?:\/\/\S+/.exec(r?.content ?? '')?.[0];
      return (
        <>
          <div className="lbl">{inp.title ?? inp.name ?? 'artifact'} · {inp.expires ?? inp.ttl ?? ''}</div>
          {url ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <a href={url} target="_blank" rel="noreferrer" className="btn sm">↗ 打开 Artifact</a>
              <code style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>{url}</code>
              <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(url)}>复制链接</button>
            </div>
          ) : (
            <pre>{r?.content ?? '上传中…'}</pre>
          )}
          {inp.content && <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--fg-2)' }}>HTML 源码 ({String(inp.content).length} 字符)</summary><pre>{String(inp.content).slice(0, 20000)}</pre></details>}
        </>
      );
    }
    case 'Goal':
      return (
        <>
          <div className="lbl">{inp.action ?? inp.command ?? 'goal'}</div>
          {inp.objective && <Markdown text={String(inp.objective)} />}
          {r && <pre>{r.content}</pre>}
        </>
      );
    case 'Workflow':
      return (
        <>
          <div className="lbl">workflow{inp.name ? ` · ${inp.name}` : ''}</div>
          <pre>{inp.script ?? JSON.stringify(inp, null, 2)}</pre>
          {r && <pre style={{ color: r.isError ? 'var(--red)' : undefined }}>{r.content}</pre>}
        </>
      );
    default:
      return (
        <>
          <div className="lbl">input</div>
          <pre>{t.name === 'Bash' || t.name === 'PowerShell' ? inp.command : JSON.stringify(t.input, null, 2)}</pre>
          {t.progress?.summary && <div style={{ color: 'var(--fg-2)' }}>{t.progress.summary}</div>}
          {r && (
            <>
              <div className="lbl">{r.isError ? 'error' : 'output'}</div>
              <pre style={{ color: r.isError ? 'var(--red)' : undefined }}>{r.content.length > 30000 ? r.content.slice(0, 30000) + '\n…(截断)' : r.content}</pre>
            </>
          )}
        </>
      );
  }
}

function SubagentLoader({ toolUseId }: { toolUseId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    setBusy(true);
    try {
      await useStore.getState().loadSubagent(useStore.getState().activeId!, toolUseId);
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return (
    <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>
      <button className="btn sm" disabled={busy} onClick={load}>
        {busy ? '加载中…' : '加载子代理对话'}
      </button>
      {err && <span style={{ color: 'var(--red)', marginLeft: 8 }}>{err}</span>}
    </div>
  );
}

export const ToolCard = memo(function ToolCard({ t, version }: { t: ToolUseBlock; version: number }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const setInspect = (id: string) => useStore.setState({ inspect: { sessionId: useStore.getState().activeId!, toolUseId: id } });
  const isAgent = t.name === 'Agent' || t.name === 'Task';
  const defaultOpen = t.status === 'error' || (isAgent && t.status === 'running');
  const show = open ?? defaultOpen;
  const st = t.status === 'done' ? (t.result ? '' : '') : t.status === 'error' ? '失败' : t.status === 'running' ? (t.progress ? `${Math.round(t.progress.elapsed)}s` : '运行中') : t.status === 'pending' ? '等待' : '…';
  void version;
  return (
    <div className={clsx('tool', t.status === 'error' && 'error', (t.status === 'running' || t.status === 'pending') && 'running')}>
      <div className="tool-head" onClick={() => setOpen(!show)}>
        <span className="ic">{ICON[t.name] ?? '⚙'}</span>
        <span className="name">{t.name.replace(/^mcp__/, 'mcp:')}</span>
        <span className="summary">{toolSummary(t.name, t.input)}</span>
        {t.progress?.lastTool && t.status === 'running' && <span className="st">{t.progress.lastTool}</span>}
        <span className="st">{st}</span>
        <button className="icon-btn" title="在右侧查看详情" onClick={(e) => { e.stopPropagation(); setInspect(t.id); }}>
          ⧉
        </button>
      </div>
      {show && (
        <div className="tool-body">
          <ToolBody t={t} />
        </div>
      )}
      {t.children.length > 0 ? (
        <div className="tool-children">
          {show ? <ItemList items={t.children} version={version} /> : <div style={{ fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer' }} onClick={() => setOpen(true)}>子代理 {t.children.length} 条消息 · 展开</div>}
        </div>
      ) : isAgent && t.status === 'done' ? (
        <div className="tool-children">
          <SubagentLoader toolUseId={t.id} />
        </div>
      ) : null}
    </div>
  );
});
