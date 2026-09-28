import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { ItemList } from '@/features/chat/ChatView';
import { CodeBlock } from '@/features/chat/CodeBlock';
import { langFromPath } from '@/features/chat/highlight';
import { ToolHead } from '@/features/chat/ToolCard';
import { getToolDef } from '@/features/chat/tools/registry';
import { JsonTree } from '@/features/chat/tools/McpTool';
import { basename } from '@/util';
import { Icon } from '@/ui/icons';
import { remoteFileNote, sessionPeer } from '@/features/peers';

function FileView({ path, line }: { path: string; line?: number }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setText(null); setErr('');
    let live = true; // a slower read of the previous path must not land under this path's header
    ws.request<string>({ kind: 'fs.read', path }).then((t) => live && setText(t)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [path]);
  useEffect(() => {
    if (text === null || !line) return;
    const el = document.querySelector(`.inspector-file .code-table tr:nth-child(${line})`);
    el?.scrollIntoView({ block: 'center' });
    el?.classList.add('hl');
  }, [text, line]);
  return (
    <div className="inspector-file" style={{ padding: '8px 12px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <b>{basename(path)}</b>
        <span className="mono" style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontSize: 11.5 }} title={path}>{path}</span>
        <button className="btn sm ghost" onClick={() => ws.request({ kind: 'shell.open', path, app: 'code' }).catch(() => {})}>VS Code</button>
        <button className="icon-btn" aria-label="关闭" onClick={() => useStore.setState({ inspect: null })}><Icon name="close" size={14} /></button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12 }}>{err}</div>}
      {text === null && !err && <div className="empty">读取中…</div>}
      {text !== null && <CodeBlock code={text} lang={langFromPath(path)} title={path} lineNumbers className="tall" />}
    </div>
  );
}

export function InspectorPanel() {
  const inspect = useStore((s) => s.inspect);
  const o = useStore((s) => (inspect ? s.open[inspect.sessionId] : undefined));
  const sessions = useStore((s) => s.sessions);
  if (!inspect) return <div className="empty">点击工具行右侧的详情按钮、轨迹表格中的一行，或搜索结果里的文件路径查看详情</div>;
  if (inspect.file) {
    // a session on another machine: the path is on THAT disk — never read the same path here
    const peer = sessionPeer(inspect.sessionId, sessions);
    if (peer) return <div className="remote-only"><Icon name="machine" size={22} /><div>{remoteFileNote(peer, inspect.file.path)}</div></div>;
    return <FileView path={inspect.file.path} line={inspect.file.line} />;
  }
  const t = o && inspect.toolUseId ? o.conv.toolIndex.get(inspect.toolUseId) : undefined;
  if (!o || !t) return <div className="empty">找不到该工具调用</div>;
  const Body = getToolDef(t.name).Body;
  return (
    <div className="inspector" style={{ padding: '8px 12px', fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}><ToolHead t={t} /></div>
        <button className="icon-btn" aria-label="关闭" onClick={() => useStore.setState({ inspect: null })}><Icon name="close" size={14} /></button>
      </div>
      <Body t={t} />
      <details className="structured" style={{ marginTop: 8 }}>
        <summary>原始输入</summary>
        <div className="jt"><JsonTree value={t.input} /></div>
      </details>
      {t.result && (
        <details className="structured">
          <summary>原始输出（{t.result.content.length} 字符）</summary>
          <CodeBlock code={t.result.content} lang="plaintext" wrap maxLines={200} />
        </details>
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
