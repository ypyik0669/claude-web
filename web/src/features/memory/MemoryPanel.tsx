import { useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore, useScopedSession } from '@/store';
import { clsx, ago } from '@/util';
import { dlg } from '@/ui/dialog';
import { Icon, type IconName } from '@/ui/icons';
import type { MemoryItem, MemoryKind, MemoryScope } from '@shared';

const KINDS: { id: MemoryKind; l: string; ic: IconName }[] = [
  { id: 'decision', l: '决定', ic: 'check' },
  { id: 'constraint', l: '约束', ic: 'lock' },
  { id: 'fact', l: '事实', ic: 'info' },
  { id: 'deadend', l: '死路', ic: 'alert' },
  { id: 'preference', l: '偏好', ic: 'user' },
  { id: 'note', l: '备注', ic: 'read' },
];
const SCOPES: { id: MemoryScope; l: string; hint: string }[] = [
  { id: 'project', l: '本项目', hint: '按工作目录归属，绝大多数记忆放这里' },
  { id: 'global', l: '全局', hint: '到哪个项目都成立的事' },
  { id: 'session', l: '本会话', hint: '临时的，换会话就不再出现' },
];
const kindOf = (k: MemoryKind) => KINDS.find((x) => x.id === k) ?? KINDS[5];

/**
 * The shared memory store, in a panel.
 *
 * The same rows every agent sees over MCP — this is where a human can check what the agents have
 * decided they know, pin what matters and delete what turned out to be wrong. A memory store you
 * cannot audit is one you cannot trust.
 */
export function MemoryPanel() {
  const active = useScopedSession();
  const toast = useStore((s) => s.toast);
  const cwd = active?.cwd ?? '';
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<MemoryScope | ''>('');
  const [kind, setKind] = useState<MemoryKind | ''>('');
  const [rows, setRows] = useState<MemoryItem[]>([]);
  const [stats, setStats] = useState<{ total: number; byScope: Record<string, number> } | null>(null);
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<MemoryKind>('fact');
  const [draftScope, setDraftScope] = useState<MemoryScope>('project');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const seq = useRef(0); // search-as-you-type: an older query's slower answer must not win
  const load = async () => {
    const n = ++seq.current;
    try {
      const [list, st] = await Promise.all([
        ws.request<MemoryItem[]>({ kind: 'memory.search', query: q.trim() || undefined, scope: scope || undefined, kind_: kind || undefined, cwd, sessionId: active?.sessionId, limit: 200 }),
        ws.request<{ total: number; byScope: Record<string, number> }>({ kind: 'memory.stats' }),
      ]);
      if (n !== seq.current) return;
      setRows(list);
      setStats(st);
      setErr('');
    } catch (e: any) { if (n === seq.current) setErr(e.message); }
  };
  useEffect(() => { void load(); }, [q, scope, kind, cwd, active?.sessionId]);
  useEffect(() => {
    const off = ws.on((e) => { if (e.kind === 'memory.changed') void load(); });
    return () => { off(); };
  }, [q, scope, kind, cwd, active?.sessionId]);

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await ws.request({ kind: 'memory.write', text, kind_: draftKind, scope: draftScope, cwd, sessionId: active?.sessionId });
      setDraft('');
      toast('已记住', true);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const harvest = async () => {
    if (!active) return toast('先打开一个会话');
    setBusy(true);
    try {
      const r = await ws.request<{ written: number; skipped: number }>({ kind: 'memory.harvest', sessionId: active.sessionId });
      toast(r.written ? `从这个会话提取了 ${r.written} 条` : '这个会话里没有值得记住的东西', !!r.written);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };

  const grouped = useMemo(() => {
    const by = new Map<MemoryScope, MemoryItem[]>();
    for (const m of rows) (by.get(m.scope) ?? by.set(m.scope, []).get(m.scope)!).push(m);
    return SCOPES.map((s) => [s, by.get(s.id) ?? []] as const).filter(([, list]) => list.length);
  }, [rows]);

  return (
    <div className="memory">
      <div className="memory-head">
        <input className="field sm" placeholder="搜索记忆…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="field sm" value={scope} onChange={(e) => setScope(e.target.value as MemoryScope | '')}>
          <option value="">全部范围</option>
          {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.l}</option>)}
        </select>
        <select className="field sm" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind | '')}>
          <option value="">全部类型</option>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.l}</option>)}
        </select>
        <span className="grow" />
        <button className="btn sm ghost" disabled={busy || !active} title="扫描当前会话，提取决定 / 约束 / 走过的死路" onClick={harvest}><Icon name="bolt" size={12} /> 从会话提取</button>
      </div>

      <div className="memory-new">
        <textarea placeholder="记一条：写清楚「是什么」和「为什么」，几个月后还看得懂。" value={draft} rows={2} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add(); }} />
        <div className="row-inline">
          <select className="field sm" value={draftKind} onChange={(e) => setDraftKind(e.target.value as MemoryKind)}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.l}</option>)}</select>
          <select className="field sm" value={draftScope} onChange={(e) => setDraftScope(e.target.value as MemoryScope)} title={SCOPES.find((s) => s.id === draftScope)?.hint}>{SCOPES.map((s) => <option key={s.id} value={s.id}>{s.l}</option>)}</select>
          <span className="grow" />
          <button className="btn sm" disabled={!draft.trim() || busy} onClick={add}>记住 (Ctrl+Enter)</button>
        </div>
      </div>

      {err && <div className="board-err">{err}</div>}

      <div className="memory-list">
        {grouped.map(([s, list]) => (
          <div key={s.id} className="memory-group">
            <div className="label">{s.l} · {list.length}</div>
            {list.map((m) => <Row key={m.id} m={m} />)}
          </div>
        ))}
        {!rows.length && !err && (
          <div className="empty" style={{ padding: 20 }}>
            <div style={{ marginBottom: 6 }}>还没有记忆</div>
            <div className="sub">所有 agent（Claude / Codex / Gemini / Qwen）都通过同一个 MCP 服务读写这里，一个 agent 记下的事另一个能直接读到。上面手写一条，或从一个会话里提取。</div>
          </div>
        )}
      </div>
      {stats && <div className="memory-foot sub">共 {stats.total} 条 · {SCOPES.map((s) => `${s.l} ${stats.byScope[s.id] ?? 0}`).join(' · ')}</div>}
    </div>
  );
}

function Row({ m }: { m: MemoryItem }) {
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState<string | null>(null);
  const k = kindOf(m.kind);
  const save = async () => {
    const text = (editing ?? '').trim();
    setEditing(null);
    if (!text || text === m.text) return;
    await ws.request({ kind: 'memory.update', id: m.id, patch: { text } }).catch((e) => toast(e.message));
  };
  return (
    <div className={clsx('mem-row', m.pinned && 'pinned')}>
      <span className={clsx('mem-kind', m.kind)} title={k.l}><Icon name={k.ic} size={13} /></span>
      <div className="grow">
        {editing !== null ? (
          <textarea autoFocus value={editing} rows={3} onChange={(e) => setEditing(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save(); }} />
        ) : (
          <div className="t" onDoubleClick={() => setEditing(m.text)} title="双击编辑">{m.text}</div>
        )}
        <div className="m">
          <span>{k.l}</span>
          {m.tags.map((t) => <span key={t} className="badge">{t}</span>)}
          {m.sourceAgent && <span>· {m.sourceAgent}</span>}
          {m.hits > 0 && <span>· 命中 {m.hits}</span>}
          <span>· {ago(m.updatedAt)}</span>
        </div>
      </div>
      <button className={clsx('icon-btn xs', m.pinned && 'active')} title={m.pinned ? '取消置顶' : '置顶'} onClick={() => void ws.request({ kind: 'memory.update', id: m.id, patch: { pinned: !m.pinned } })}><Icon name="pin" size={12} /></button>
      <button className="icon-btn xs" title="删除" onClick={async () => { if (await dlg.confirm('删除这条记忆？', { danger: true })) void ws.request({ kind: 'memory.remove', id: m.id }); }}><Icon name="trash" size={12} /></button>
    </div>
  );
}
