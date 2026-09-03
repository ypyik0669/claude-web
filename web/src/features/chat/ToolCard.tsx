import { memo, useState } from 'react';
import type { ToolUseBlock } from '@/model/conversation';
import { useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { clsx, basename } from '@/util';
import { Icon } from '@/ui/icons';
import { ItemList } from './ChatView';
import { getToolDef, splitMcp, toolDisplayName } from './tools/registry';

function SubagentLoader({ toolUseId }: { toolUseId: string }) {
  const ctx = usePaneCtx();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    setBusy(true);
    try {
      await useStore.getState().loadSubagent((ctx?.sessionId ?? useStore.getState().activeId)!, toolUseId);
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return (
    <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
      <button className="btn sm" disabled={busy} onClick={load}>
        {busy ? '加载中…' : '加载子代理对话'}
      </button>
      {err && <span style={{ color: 'var(--err)', marginLeft: 8 }}>{err}</span>}
    </div>
  );
}

/**
 * The collapsed form of a tool call: one line, ~24px tall — icon, verb, target, then the
 * duration or error on the right. Expanding is what produces a card; the row itself never is one.
 * Paths show as basename with the full path in the tooltip, so a deep path can't blow the line out.
 */
export function ToolHead({ t, onToggle, open }: { t: ToolUseBlock; onToggle?: () => void; open?: boolean }) {
  const def = getToolDef(t.name);
  const { verb, arg } = def.label(t.input as any);
  const mcp = splitMcp(t.name);
  const ctx = usePaneCtx();
  const setInspect = (id: string) => useStore.setState({ inspect: { sessionId: (ctx?.sessionId ?? useStore.getState().activeId)!, toolUseId: id } });
  const short = def.category === 'read' || def.category === 'edit' ? shortPath(arg) : arg;
  const st = t.status === 'error' ? '失败' : t.status === 'running' ? (t.progress ? `${Math.round(t.progress.elapsed)}s` : '运行中') : t.status === 'pending' ? '等待' : t.status === 'streaming' ? '…' : '';
  return (
    <div className={clsx('tool-head', open && 'open')} onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' && onToggle) onToggle(); }} title={arg}>
      <span className="ic"><Icon name={def.icon} size={14} /></span>
      <span className="name">{mcp ? toolDisplayName(t.name) : verb || t.name}</span>
      {mcp && verb && <span className="verb">{verb}</span>}
      <span className="summary">{short}</span>
      {t.progress?.lastTool && t.status === 'running' && <span className="st">{t.progress.lastTool}</span>}
      {st && <span className={clsx('st', t.status === 'error' && 'err')}>{st}</span>}
      <button className="icon-btn xs" title="在右侧查看详情" aria-label="详情" onClick={(e) => { e.stopPropagation(); setInspect(t.id); }}><Icon name="external" size={12} /></button>
    </div>
  );
}

/** `a/b/c/file.ts:10-40` → `file.ts:10-40`; the head's tooltip keeps the full string. */
function shortPath(arg: string): string {
  if (!arg || /\s/.test(arg)) return arg;
  const b = basename(arg.replace(/[\\/]+$/, ''));
  return b && b.length < arg.length ? b : arg;
}

/**
 * `bare` renders only the body (the timeline already drew the head and the rail), which is how
 * every tool inside a `Steps` trail is shown. Standalone tools (Agent / plan / question) keep the card.
 */
export const ToolCard = memo(function ToolCard({ t, version, bare }: { t: ToolUseBlock; version: number; bare?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const def = getToolDef(t.name);
  const isAgent = def.category === 'agent';
  const defaultOpen = t.status === 'error' || (isAgent && t.status === 'running') || def.category === 'plan';
  const show = bare || (open ?? defaultOpen);
  void version;
  const Body = def.Body;
  const children = t.children.length > 0 ? (
    <div className="tool-children">
      {show ? <ItemList items={t.children} version={version} /> : <div style={{ fontSize: 12, color: 'var(--ink-3)', cursor: 'pointer' }} onClick={() => setOpen(true)}>子代理 {t.children.length} 条消息 · 展开</div>}
    </div>
  ) : isAgent && t.status === 'done' && t.name !== 'Workflow' ? (
    <div className="tool-children"><SubagentLoader toolUseId={t.id} /></div>
  ) : null;

  if (bare) return <div className="tool-out"><div className="tool-body"><Body t={t} /></div>{children}</div>;
  return (
    <div className={clsx('tool', t.status === 'error' && 'error', (t.status === 'running' || t.status === 'pending') && 'running')}>
      <ToolHead t={t} open={show} onToggle={() => setOpen(!show)} />
      {show && <div className="tool-body"><Body t={t} /></div>}
      {children}
    </div>
  );
});
