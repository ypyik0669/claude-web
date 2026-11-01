import { openClaudeAiImport, openDispatch, openPublished } from '@/features/cloud/cloud-open';
import { useEffect, useMemo, useRef, useState } from 'react';
import { THEMES, forkCarry, useActive, useStore, type PanelId } from '@/store';
import { ws } from '@/ws/client';
import { ago, basename } from '@/util';
import { Icon, AGENT_ICONS, type IconName } from '@/ui/icons';
import { parsePeerId, type SessionSummary } from '@shared';
import { PANELS } from '@/model/layout';
import { useOrch } from '@/features/orchestra/state';
import { SHORTCUTS, keyLabel } from '@/features/workbench/shortcuts';
import { runCommand } from '@/features/workbench/commands';
import { viewCommands, type WbView } from '@/features/workbench/wb-views';
import { openSessionView } from '@/features/workbench/right-panel';
import { panelCommandLabel } from '@/features/workbench/panel-entries';
import { shareConversation } from '@/features/chat/MessageActions';
import { TERMS } from '@/ui/terms';
import { imeComposing } from '@/ui/ime';
import { canZoom, useZoom } from '@/ui/zoom';
import { zoomPercent } from '@/ui/zoom-math';
import { commandHits } from './filter';
import { tr } from '@/i18n';
import { openWhatsNew } from '@/features/update/WhatsNew';
import { pickFolder } from '@/ui/pick-folder';

interface Cmd { id: string; label: string; sub?: string; ic?: IconName; group: string; run: () => void }

/** `agent:claude in:proj rest` → the same filters the server's library search understands. */
function parseFilters(raw: string): { agent?: string; cwd?: string; rest: string; filtered: boolean } {
  let agent: string | undefined, cwd: string | undefined;
  const rest = raw
    .replace(/\bagent:(\S+)/gi, (_, v) => { agent = v.toLowerCase(); return ''; })
    .replace(/\bin:(\S+)/gi, (_, v) => { cwd = v.toLowerCase(); return ''; })
    .replace(/\s+/g, ' ')
    .trim();
  return { agent, cwd, rest, filtered: !!(agent || cwd) };
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const st = useStore();
  const active = useActive();
  const zoom = useZoom();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [hits, setHits] = useState<{ session: SessionSummary; snippet?: string }[]>([]);
  const inp = useRef<HTMLInputElement>(null);
  const pf = useMemo(() => parseFilters(q), [q]);
  const close = () => useStore.setState({ paletteOpen: false });

  useEffect(() => {
    if (open) { setQ(''); setIdx(0); setTimeout(() => inp.current?.focus(), 0); }
  }, [open]);

  // server-side full-text search (debounced) when the query is not a command prefix
  useEffect(() => {
    // `agent:` / `in:` filters go to the server too, however short the rest of the query is
    if (!open || q.startsWith('>') || (q.trim().length < 2 && !pf.filtered)) { setHits([]); return; }
    let live = true; // a slower search for an older query must not replace this one's hits
    const t = setTimeout(() => ws.request<typeof hits>({ kind: 'sessions.search', query: q, limit: 20 }).then((h) => live && setHits(h)).catch(() => live && setHits([])), 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, open]);

  // a view of the current conversation (the old workbench tabs): the right panel on a desktop (改动 / Git → 审阅,
  // 文件 / 搜索 / 生成的文件 → 文件…; a phone's bottom drawer; 定时任务 → 自动化) — with a document / terminal in front, the conversation next
  // to it is brought forward first, otherwise the command would do nothing visible (openSessionView)
  const showView = (view: WbView) => openSessionView(view);
  const commands = useMemo<Cmd[]>(() => {
    // the label says what the toggle will do right now (a hidden or minimized panel is opened; the terminal is hidden, not closed)
    const panel = (p: (typeof PANELS)[number]): Cmd => ({ id: `panel.${p.id}`, label: panelCommandLabel(st.layout.dock, p, st.settings['ui.workbench'] === true), ic: p.icon, group: tr('面板'), run: () => st.togglePanel(p.id) });
    const c: Cmd[] = [
      { id: 'new', label: tr('新对话'), sub: keyLabel(SHORTCUTS[0]), ic: 'plus', group: tr('对话'), run: () => runCommand('new') },
      // stage F (local versions of claude.ai features)
      { id: 'dispatch', label: tr('派活…'), ic: 'send', group: tr('对话'), run: () => openDispatch() },
      { id: 'published', label: tr('已发布的文件'), ic: 'share', group: tr('对话'), run: () => openPublished() },
      { id: 'claudeai.import', label: tr('导入 claude.ai 数据…'), ic: 'cloud', group: tr('对话'), run: () => openClaudeAiImport() },
      { id: 'ws.add', label: tr('打开项目文件夹…'), ic: 'folder', group: tr('对话'), run: async () => { const p = await pickFolder(); if (p) await st.addWorkspace(p); } },
      { id: 'sidebar', label: st.sidebarOpen ? tr('收起侧栏') : tr('展开侧栏'), sub: 'Ctrl+B', ic: 'sidebar', group: tr('视图'), run: () => useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })) },
      { id: 'archived', label: st.showArchived ? tr('隐藏已归档的对话') : tr('显示已归档的对话'), ic: 'archive', group: tr('视图'), run: () => useStore.getState().setShowArchived(!useStore.getState().showArchived) },
      { id: 'keys', label: tr('键盘快捷键'), sub: 'Ctrl+/', ic: 'keyboard', group: tr('视图'), run: () => useStore.setState({ shortcutsOpen: true }) },
      { id: 'whatsNew', label: tr('更新内容'), ic: 'sparkle', group: tr('视图'), run: () => openWhatsNew() },
      { id: 'settings', label: tr('设置…'), sub: 'Ctrl+,', ic: 'settings', group: tr('视图'), run: () => st.openSettings() },
      // 界面缩放: the desktop app's whole-window zoom (a browser has its own)
      ...(canZoom ? SHORTCUTS.filter((x) => x.id.startsWith('zoom.')).map<Cmd>((x) => ({ id: x.id, label: x.id === 'zoom.reset' ? tr('{label}（现在 {zoomPercent}）', { label: x.label, zoomPercent: zoomPercent(zoom) }) : x.label, sub: keyLabel(x), ic: x.id === 'zoom.in' ? 'zoomIn' : x.id === 'zoom.out' ? 'zoomOut' : 'zoom', group: tr('视图'), run: () => runCommand(x.id) })) : []),
      // workbench verbs come straight from the shortcut table so labels / keys never drift
      ...SHORTCUTS.filter((x) => ['group.new', 'group.close', 'group.next', 'pane.splitRight', 'pane.splitDown', 'tile.close', 'pane.zoom', 'pane.next', 'tile.new', 'dock.toggle', 'dock.minimize'].includes(x.id))
        .map<Cmd>((x) => ({ id: `wb.${x.id}`, label: x.label, sub: keyLabel(x), ic: x.group === tr('分组') ? 'board' : x.group === tr('分屏') ? 'splitRight' : 'inspector', group: tr('工作台'), run: () => runCommand(x.id) })),
      { id: 'ui.workbench', label: tr('{v}工作台工具（分组栏 / 标签条 / 面板图标栏）', { v: st.settings['ui.workbench'] === true ? tr('隐藏') : tr('显示') }), ic: 'board', group: tr('工作台'), run: () => void st.setSetting('ui.workbench', st.settings['ui.workbench'] !== true) },
      ...(['single', 'cols2', 'cols3', 'grid2x2', 'mainSide'] as const).map<Cmd>((p) => ({ id: `preset.${p}`, label: tr('布局预设: {v}', { v: { single: tr('不分屏'), cols2: tr('左右两栏'), cols3: tr('三栏'), grid2x2: tr('四宫格'), mainSide: tr('主 + 侧') }[p] }), ic: 'zoom', group: tr('工作台'), run: () => st.dispatchLayout({ t: 'pane.preset', preset: p }) })),
      { id: 'orch.new', label: tr('新建编排'), sub: tr('多 agent 工作流'), ic: 'orchestra', group: tr('编排'), run: () => useOrch.getState().ask('new') },
      { id: 'orch.run', label: tr('运行编排…'), ic: 'play', group: tr('编排'), run: () => useOrch.getState().ask('run') },
      { id: 'window.new', label: tr('在新窗口打开当前分组'), ic: 'copy', group: tr('工作台'), run: () => runCommand('window.new') },
      ...PANELS.map(panel),
      ...THEMES.map<Cmd>((t) => ({ id: `theme.${t}`, label: tr('主题: {t}{v}', { t, v: st.theme === t ? tr('（当前）') : '' }), ic: 'moon', group: tr('主题'), run: () => st.setTheme(t) })),
    ];
    if (active) {
      const live = active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
      c.unshift(
        { id: 's.fork', label: tr('从这里分叉当前对话'), ic: 'branch', group: tr('当前对话'), run: () => void st.openSession({ sessionId: active.sessionId, cwd: active.cwd, fork: true, ...forkCarry(active.sessionId) }) },
        { id: 's.pin', label: st.sessionMeta[active.sessionId]?.pinned ? tr('取消置顶') : tr('置顶当前对话'), ic: 'pin', group: tr('当前对话'), run: () => void st.setSessionMeta(active.sessionId, { pinned: !st.sessionMeta[active.sessionId]?.pinned }) },
        { id: 's.archive', label: st.sessionMeta[active.sessionId]?.archived ? tr('取消归档') : tr('归档当前对话'), ic: 'archive', group: tr('当前对话'), run: () => void st.setSessionMeta(active.sessionId, { archived: !st.sessionMeta[active.sessionId]?.archived }) },
        { id: 's.traj', label: tr('对话 / {trajectory}', { trajectory: TERMS.trajectory }), sub: 'Alt+J', ic: 'workflow', group: tr('当前对话'), run: () => runCommand('tab') },
        { id: 's.export', label: tr('导出为 HTML'), ic: 'share', group: tr('当前对话'), run: () => shareConversation(active.sessionId) },
        // the per-session views that used to be the workbench tab row (改动 / Git / 文件 / 搜索 / 定时任务 / 生成的文件 / Issue 与 PR)
        ...viewCommands(!!parsePeerId(active.sessionId)).map<Cmd>((v) => ({ id: `s.${v.id}`, label: v.label, ic: v.icon, group: tr('当前对话'), run: () => showView(v.view) })),
        ...(parsePeerId(active.sessionId) ? [] : [{ id: 's.open', label: tr('在资源管理器打开目录'), ic: 'folder' as const, group: tr('当前对话'), run: () => void ws.request({ kind: 'shell.open', path: active.cwd }).catch((e) => useStore.getState().toast(e.message)) },
        { id: 's.code', label: tr('在 VS Code 打开目录'), ic: 'keyboard' as const, group: tr('当前对话'), run: () => void ws.request({ kind: 'shell.open', path: active.cwd, app: 'code' }).catch((e) => useStore.getState().toast(e.message)) }]),
        live ? { id: 's.stop', label: tr('结束当前对话的进程'), ic: 'stop', group: tr('当前对话'), run: () => void st.closeSession(active.sessionId) } : { id: 's.resume', label: tr('恢复当前对话的进程'), ic: 'play', group: tr('当前对话'), run: () => void st.openSession({ sessionId: active.sessionId, cwd: active.cwd }) },
        ...(live ? [{ id: 's.compact', label: tr('/compact 压缩上下文'), ic: 'copy' as const, group: tr('当前对话'), run: () => void st.send(active.sessionId, '/compact') }] : []),
      );
    }
    return c;
  }, [st.layout.dock, st.theme, st.sidebarOpen, st.showArchived, st.settings, st.sessionMeta, active?.sessionId, active?.state, zoom]);

  const ql = q.replace(/^>/, '').trim().toLowerCase();
  // name hits first, then the conversations, then (in one block each) every group the query names (「面板」 → every panel)
  const { named: cmdHits, grouped: groupHits } = pf.filtered ? { named: [], grouped: [] } : commandHits(commands, ql);
  // local fallback (and the only list before the index exists / for filter-only queries the index cannot answer)
  const localHits = () => st.sessions.filter((s) => !s.parentId && (!pf.agent || (s.agent ?? 'claude') === pf.agent) && (!pf.cwd || (s.cwd ?? '').toLowerCase().includes(pf.cwd)) && (!pf.rest || s.title.toLowerCase().includes(pf.rest.toLowerCase()))).slice(0, pf.filtered ? 30 : 12);
  const sessHits: SessionSummary[] = q.startsWith('>') ? [] : hits.length ? hits.map((h) => h.session) : localHits();
  const items: { kind: 'cmd'; c: Cmd }[] | { kind: 'sess'; s: SessionSummary; snippet?: string }[] | any[] = [
    ...cmdHits.map((c) => ({ kind: 'cmd' as const, c })),
    ...sessHits.map((s) => ({ kind: 'sess' as const, s, snippet: hits.find((h) => h.session.sessionId === s.sessionId)?.snippet })),
    ...groupHits.map((c) => ({ kind: 'cmd' as const, c })),
  ];
  useEffect(() => setIdx(0), [q, hits.length]);

  if (!open) return null;
  const run = (it: any) => {
    close();
    if (it.kind === 'cmd') it.c.run();
    else st.open[it.s.sessionId] ? st.setActive(it.s.sessionId) : void st.loadHistory(it.s.sessionId);
  };
  const onKey = (e: React.KeyboardEvent) => {
    // only the palette: the global Esc would also close the settings page it was opened over
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    // Enter that confirms an IME candidate (Chinese / Japanese input) is not "run this item"
    if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && items[idx]) run(items[idx]);
  };
  let lastGroup = '';
  return (
    <div className="palette-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cmdk" onKeyDown={onKey}>
        <input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('输入命令，或搜索对话（全文）…  > 只搜命令 · in:目录')} />
        <div className="list">
          {items.map((it, i) => {
            const group = it.kind === 'cmd' ? it.c.group : hits.length ? tr('对话 · 全文匹配') : ql ? tr('匹配的对话') : tr('最近的对话');
            const head = group !== lastGroup ? <div className="grp" key={`g${i}`}>{group}</div> : null;
            lastGroup = group;
            return (
              <div key={it.kind === 'cmd' ? it.c.id : it.s.sessionId}>
                {head}
                <div className={`it ${i === idx ? 'sel' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => run(it)}>
                  <span className="ic" title={it.kind === 'sess' ? it.s.agent ?? 'claude' : undefined}><Icon name={it.kind === 'cmd' ? it.c.ic ?? 'chevronRight' : AGENT_ICONS[it.s.agent ?? 'claude'] ?? 'agent'} size={15} /></span>
                  <span className="t">{it.kind === 'cmd' ? it.c.label : it.s.title}</span>
                  {it.kind === 'sess' && <span className="dir" title={it.s.cwd}>{basename(it.s.cwd ?? '')}</span>}
                  <span className="sub">{it.kind === 'cmd' ? it.c.sub ?? '' : it.snippet ? `…${it.snippet}…` : ago(it.s.lastModified)}</span>
                </div>
              </div>
            );
          })}
          {!items.length && <div className="empty">{tr('没有匹配')}</div>}
        </div>
        <div className="foot"><span>{tr('↑↓ 选择')}</span><span>{tr('Enter 执行')}</span><span>{tr('Esc 关闭')}</span><span>{tr('> 只看命令')}</span></div>
      </div>
    </div>
  );
}
