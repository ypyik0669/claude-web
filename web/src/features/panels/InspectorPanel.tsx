import { useStore } from '@/store';
import { ItemList } from '@/features/chat/ChatView';
import { DiffView, Markdown } from '@/features/chat/Markdown';
import { toolSummary } from '@/util';

export function InspectorPanel() {
  const inspect = useStore((s) => s.inspect);
  const o = useStore((s) => (inspect ? s.open[inspect.sessionId] : undefined));
  if (!inspect || !o) return <div className="empty">点击工具卡片右侧 ⧉ 或轨迹表格中的一行查看详情</div>;
  const t = o.conv.toolIndex.get(inspect.toolUseId);
  if (!t) return <div className="empty">找不到该工具调用</div>;
  const inp = t.input as any;
  return (
    <div style={{ padding: '8px 12px', fontSize: 12.5 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <b>{t.name}</b>
        <span className={`badge ${t.status === 'done' ? 'ok' : t.status === 'error' ? 'err' : 'run'}`}>{t.status}</span>
        <span className="mono" style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{toolSummary(t.name, t.input)}</span>
        <button className="icon-btn" onClick={() => useStore.setState({ inspect: null })}>✕</button>
      </div>
      {t.name === 'Edit' || t.name === 'MultiEdit' ? (
        (t.name === 'MultiEdit' ? inp.edits ?? [] : [inp]).map((e: any, i: number) => <DiffView key={i} oldText={e.old_string} newText={e.new_string} />)
      ) : (
        <>
          <div className="lbl" style={{ color: 'var(--fg-2)', fontSize: 11, margin: '6px 0 3px' }}>INPUT</div>
          <pre className="mono" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4, padding: 8, maxHeight: 300, overflow: 'auto' }}>{t.name === 'Bash' ? inp.command : t.name === 'Agent' || t.name === 'Task' ? inp.prompt : JSON.stringify(t.input, null, 2)}</pre>
        </>
      )}
      {t.result && (
        <>
          <div style={{ color: 'var(--fg-2)', fontSize: 11, margin: '6px 0 3px' }}>{t.result.isError ? 'ERROR' : 'RESULT'}</div>
          {t.name === 'Agent' || t.name === 'Task' ? <Markdown text={t.result.content} /> : <pre className="mono" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4, padding: 8, maxHeight: 400, overflow: 'auto', color: t.result.isError ? 'var(--red)' : undefined }}>{t.result.content}</pre>}
          {t.result.structured !== undefined && t.name !== 'Agent' && (
            <details>
              <summary style={{ cursor: 'pointer', color: 'var(--fg-2)', fontSize: 11 }}>结构化输出</summary>
              <pre className="mono" style={{ fontSize: 11, maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(t.result.structured, null, 2)}</pre>
            </details>
          )}
        </>
      )}
      {t.children.length > 0 && (
        <>
          <div style={{ color: 'var(--fg-2)', fontSize: 11, margin: '10px 0 3px' }}>子代理对话 ({t.children.length})</div>
          <div style={{ borderLeft: '3px solid var(--accent-soft)', paddingLeft: 8 }}>
            <ItemList items={t.children} version={o.version} />
          </div>
        </>
      )}
    </div>
  );
}
