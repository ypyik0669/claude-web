import { memo, useState } from 'react';
import type { ToolUseBlock } from '@/model/conversation';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { ItemList } from './ChatView';
import { getToolDef, splitMcp, toolDisplayName } from './tools/registry';

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

export function ToolHead({ t, onToggle, open }: { t: ToolUseBlock; onToggle?: () => void; open?: boolean }) {
  const def = getToolDef(t.name);
  const { verb, arg } = def.label(t.input as any);
  const mcp = splitMcp(t.name);
  const setInspect = (id: string) => useStore.setState({ inspect: { sessionId: useStore.getState().activeId!, toolUseId: id } });
  const st = t.status === 'error' ? '失败' : t.status === 'running' ? (t.progress ? `${Math.round(t.progress.elapsed)}s` : '运行中') : t.status === 'pending' ? '等待' : t.status === 'streaming' ? '…' : '';
  return (
    <div className={clsx('tool-head', open && 'open')} onClick={onToggle}>
      <span className="ic">{def.icon}</span>
      <span className="name">{mcp ? toolDisplayName(t.name) : verb || t.name}</span>
      {mcp && verb && <span className="verb">{verb}</span>}
      <span className="summary" title={arg}>{arg}</span>
      {t.progress?.lastTool && t.status === 'running' && <span className="st">{t.progress.lastTool}</span>}
      {st && <span className={clsx('st', t.status === 'error' && 'err')}>{st}</span>}
      <button className="icon-btn" title="在右侧查看详情" onClick={(e) => { e.stopPropagation(); setInspect(t.id); }}>⧉</button>
    </div>
  );
}

export const ToolCard = memo(function ToolCard({ t, version }: { t: ToolUseBlock; version: number }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const def = getToolDef(t.name);
  const isAgent = def.category === 'agent';
  const defaultOpen = t.status === 'error' || (isAgent && t.status === 'running') || def.category === 'plan';
  const show = open ?? defaultOpen;
  void version;
  const Body = def.Body;
  return (
    <div className={clsx('tool', t.status === 'error' && 'error', (t.status === 'running' || t.status === 'pending') && 'running')}>
      <ToolHead t={t} open={show} onToggle={() => setOpen(!show)} />
      {show && (
        <div className="tool-body">
          <Body t={t} />
        </div>
      )}
      {t.children.length > 0 ? (
        <div className="tool-children">
          {show ? <ItemList items={t.children} version={version} /> : <div style={{ fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer' }} onClick={() => setOpen(true)}>子代理 {t.children.length} 条消息 · 展开</div>}
        </div>
      ) : isAgent && t.status === 'done' && t.name !== 'Workflow' ? (
        <div className="tool-children">
          <SubagentLoader toolUseId={t.id} />
        </div>
      ) : null}
    </div>
  );
});
