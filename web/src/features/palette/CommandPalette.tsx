import { useEffect, useMemo, useRef, useState } from 'react';
import { THEMES, useActive, useStore, type PanelId } from '@/store';
import { ws } from '@/ws/client';
import { ago, basename } from '@/util';
import type { SessionSummary } from '@shared';
import { SHORTCUTS, keyLabel } from '@/features/workbench/shortcuts';
import { runCommand } from '@/features/workbench/commands';

interface Cmd { id: string; label: string; sub?: string; ic?: string; group: string; run: () => void }

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const st = useStore();
  const active = useActive();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [hits, setHits] = useState<{ session: SessionSummary; snippet?: string }[]>([]);
  const inp = useRef<HTMLInputElement>(null);
  const close = () => useStore.setState({ paletteOpen: false });

  useEffect(() => {
    if (open) { setQ(''); setIdx(0); setTimeout(() => inp.current?.focus(), 0); }
  }, [open]);

  // server-side full-text search (debounced) when the query is not a command prefix
  useEffect(() => {
    if (!open || q.startsWith('>') || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => ws.request<typeof hits>({ kind: 'sessions.search', query: q, limit: 20 }).then(setHits).catch(() => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const commands = useMemo<Cmd[]>(() => {
    const panel = (id: PanelId, l: string): Cmd => ({ id: `panel.${id}`, label: `${st.panels.includes(id) ? '关闭' : '打开'}${l}面板`, ic: '▣', group: '面板', run: () => st.togglePanel(id) });
    const c: Cmd[] = [
      { id: 'new', label: '新会话', sub: keyLabel(SHORTCUTS[0]), ic: '＋', group: '会话', run: () => runCommand('new') },
      { id: 'ws.add', label: '添加工作区…', ic: '▤', group: '会话', run: async () => { const p = await ws.request<string | null>({ kind: 'fs.pickDir' }); if (p) await st.addWorkspace(p); } },
      { id: 'sidebar', label: st.sidebarOpen ? '收起侧栏' : '展开侧栏', sub: 'Ctrl+B', ic: '◧', group: '视图', run: () => useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })) },
      { id: 'archived', label: st.showArchived ? '隐藏已归档会话' : '显示已归档会话', ic: '🗄', group: '视图', run: () => useStore.setState((s) => ({ showArchived: !s.showArchived })) },
      { id: 'keys', label: '键盘快捷键', sub: '?', ic: '⌨', group: '视图', run: () => useStore.setState({ shortcutsOpen: true }) },
      { id: 'settings', label: '设置…', sub: 'Ctrl+,', ic: '⚙', group: '视图', run: () => st.openSettings() },
      // workbench verbs come straight from the shortcut table so labels / keys never drift
      ...SHORTCUTS.filter((x) => ['group.new', 'group.close', 'group.next', 'pane.splitRight', 'pane.splitDown', 'tile.close', 'pane.zoom', 'pane.next', 'tile.new', 'dock.toggle', 'dock.minimize'].includes(x.id) && !(st.settings['ui.singleWindow'] && x.group !== '面板'))
        .map<Cmd>((x) => ({ id: `wb.${x.id}`, label: x.label, sub: keyLabel(x), ic: x.group === '分组' ? '▭' : x.group === '窗格' ? '◫' : '▣', group: '工作台', run: () => runCommand(x.id) })),
      ...(['single', 'cols2', 'cols3', 'grid2x2', 'mainSide'] as const).map<Cmd>((p) => ({ id: `preset.${p}`, label: `布局预设: ${{ single: '单窗格', cols2: '左右两栏', cols3: '三栏', grid2x2: '四宫格', mainSide: '主 + 侧' }[p]}`, ic: '⊞', group: '工作台', run: () => st.dispatchLayout({ t: 'pane.preset', preset: p }) })),
      { id: 'window.new', label: '在新窗口打开当前分组', ic: '⧉', group: '工作台', run: () => runCommand('window.new') },
      panel('mission', '总览'), panel('tasks', '任务'), panel('files', '文件改动'), panel('usage', '用量'), panel('config', '配置中心'), panel('terminal', '终端'),
      ...THEMES.map<Cmd>((t) => ({ id: `theme.${t}`, label: `主题: ${t}${st.theme === t ? ' ✓' : ''}`, ic: '◐', group: '主题', run: () => st.setTheme(t) })),
    ];
    if (active) {
      const live = active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
      c.unshift(
        { id: 's.fork', label: '分叉当前会话', ic: '⑂', group: '当前会话', run: () => void st.openSession({ sessionId: active.sessionId, cwd: active.cwd, fork: true }) },
        { id: 's.pin', label: st.sessionMeta[active.sessionId]?.pinned ? '取消置顶' : '置顶当前会话', ic: '📌', group: '当前会话', run: () => void st.setSessionMeta(active.sessionId, { pinned: !st.sessionMeta[active.sessionId]?.pinned }) },
        { id: 's.archive', label: st.sessionMeta[active.sessionId]?.archived ? '取消归档' : '归档当前会话', ic: '🗄', group: '当前会话', run: () => void st.setSessionMeta(active.sessionId, { archived: !st.sessionMeta[active.sessionId]?.archived }) },
        { id: 's.traj', label: '对话 ⇄ 轨迹', ic: '⇄', group: '当前会话', run: () => runCommand('tab') },
        { id: 's.open', label: '在资源管理器打开目录', ic: '▤', group: '当前会话', run: () => void ws.request({ kind: 'shell.open', path: active.cwd }) },
        { id: 's.code', label: '在 VS Code 打开目录', ic: '⌨', group: '当前会话', run: () => void ws.request({ kind: 'shell.open', path: active.cwd, app: 'code' }) },
        live ? { id: 's.stop', label: '结束当前会话进程', ic: '⏻', group: '当前会话', run: () => void st.closeSession(active.sessionId) } : { id: 's.resume', label: '恢复当前会话进程', ic: '▶', group: '当前会话', run: () => void st.openSession({ sessionId: active.sessionId, cwd: active.cwd }) },
        ...(live ? [{ id: 's.compact', label: '/compact 压缩上下文', ic: '⧉', group: '当前会话', run: () => void st.send(active.sessionId, '/compact') }] : []),
      );
    }
    return c;
  }, [st.panels, st.theme, st.sidebarOpen, st.showArchived, st.settings, st.sessionMeta, active?.sessionId, active?.state]);

  const ql = q.replace(/^>/, '').trim().toLowerCase();
  const cmdHits = commands.filter((c) => !ql || c.label.toLowerCase().includes(ql) || c.group.toLowerCase().includes(ql));
  const sessHits: SessionSummary[] = q.startsWith('>') ? [] : hits.length ? hits.map((h) => h.session) : st.sessions.filter((s) => !ql || s.title.toLowerCase().includes(ql)).slice(0, 12);
  const items: { kind: 'cmd'; c: Cmd }[] | { kind: 'sess'; s: SessionSummary; snippet?: string }[] | any[] = [
    ...(ql ? cmdHits.slice(0, 8) : cmdHits).map((c) => ({ kind: 'cmd' as const, c })),
    ...sessHits.map((s) => ({ kind: 'sess' as const, s, snippet: hits.find((h) => h.session.sessionId === s.sessionId)?.snippet })),
  ];
  useEffect(() => setIdx(0), [q, hits.length]);

  if (!open) return null;
  const run = (it: any) => {
    close();
    if (it.kind === 'cmd') it.c.run();
    else st.open[it.s.sessionId] ? st.setActive(it.s.sessionId) : void st.loadHistory(it.s.sessionId);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    if (e.key === 'Enter' && items[idx]) run(items[idx]);
  };
  let lastGroup = '';
  return (
    <div className="palette-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cmdk" onKeyDown={onKey}>
        <input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入命令，或搜索会话（全文）…  以 > 开头只搜命令" />
        <div className="list">
          {items.map((it, i) => {
            const group = it.kind === 'cmd' ? it.c.group : hits.length ? '会话（全文匹配）' : '会话';
            const head = group !== lastGroup ? <div className="grp" key={`g${i}`}>{group}</div> : null;
            lastGroup = group;
            return (
              <div key={it.kind === 'cmd' ? it.c.id : it.s.sessionId}>
                {head}
                <div className={`it ${i === idx ? 'sel' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => run(it)}>
                  <span className="ic">{it.kind === 'cmd' ? it.c.ic ?? '›' : '◌'}</span>
                  <span className="t">{it.kind === 'cmd' ? it.c.label : it.s.title}</span>
                  <span className="sub">{it.kind === 'cmd' ? it.c.sub ?? '' : it.snippet ? `…${it.snippet}…` : `${basename(it.s.cwd)} · ${ago(it.s.lastModified)}`}</span>
                </div>
              </div>
            );
          })}
          {!items.length && <div className="empty">没有匹配</div>}
        </div>
        <div className="foot"><span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span><span>&gt; 只看命令</span></div>
      </div>
    </div>
  );
}
