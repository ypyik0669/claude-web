import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { THEMES, useStore } from '@/store';
import { clsx } from '@/util';
import { EnvEditor, Mcp, Overview, Plugins, ProviderProfiles, Settings, SimpleList } from '@/features/panels/ConfigPanel';
import { CJK_FONTS, DENSITIES, FONT_SIZES } from './ui-settings';
import { SkillsSection } from './SkillsSection';
import { ToolsSection } from './ToolsSection';
import { SecretsSection } from './SecretsSection';
import { UpdateSection } from './UpdateSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { ModelsSection } from './ModelsSection';
import { McpCatalog } from './McpCatalog';

/** One searchable row. `keywords` widen the match beyond the visible label. */
export interface Entry { id: string; label: string; hint?: string; keywords?: string; render: () => ReactNode }
export interface Section { id: string; l: string; ic: string; entries?: Entry[]; body?: () => ReactNode; keywords?: string }

function Toggle({ k, def = false }: { k: string; def?: boolean }) {
  const v = useStore((s) => s.settings[k]);
  const set = useStore((s) => s.setSetting);
  const on = (v ?? def) as boolean;
  return <button className={clsx('toggle', on && 'on')} onClick={() => void set(k, !on)} />;
}
function Select({ k, def, options }: { k: string; def: string; options: { id: string; l: string }[] }) {
  const v = useStore((s) => s.settings[k]);
  const set = useStore((s) => s.setSetting);
  return (
    <select className="field" value={String(v ?? def)} onChange={(e) => void set(k, e.target.value)}>
      {options.map((o) => <option key={o.id} value={o.id}>{o.l}</option>)}
    </select>
  );
}
function NumberSelect({ k, def, options }: { k: string; def: number; options: readonly number[] }) {
  const v = useStore((s) => s.settings[k]);
  const set = useStore((s) => s.setSetting);
  return (
    <select className="field" value={String(v ?? def)} onChange={(e) => void set(k, Number(e.target.value))}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="grow"><div className="l">{label}</div>{hint && <div className="sub">{hint}</div>}</div>
      <div className="ctl">{children}</div>
    </div>
  );
}

export function useSections(): Section[] {
  return useMemo<Section[]>(() => [
    { id: 'appearance', l: '外观', ic: '◐', entries: [
      { id: 'ui.theme', label: '主题', hint: '跟随系统会按操作系统的深浅色切换', keywords: 'theme dark light 深色 浅色 system', render: () => <Select k="ui.theme" def="dark" options={[{ id: 'system', l: '跟随系统' }, ...THEMES.map((t) => ({ id: t, l: t }))]} /> },
      { id: 'ui.fontSize', label: '字号', hint: '整体界面字号（像素）', keywords: 'font size 字体大小', render: () => <NumberSelect k="ui.fontSize" def={14} options={FONT_SIZES} /> },
      { id: 'ui.density', label: '密度', hint: '紧凑模式减少行高与内边距', keywords: 'density compact 紧凑', render: () => <Select k="ui.density" def="comfortable" options={DENSITIES as any} /> },
      { id: 'ui.cjkFont', label: '中文字体', hint: '优先用于中日韩文字的字体', keywords: 'cjk font 中文 字体 雅黑 苹方', render: () => <Select k="ui.cjkFont" def="" options={CJK_FONTS} /> },
      { id: 'ui.reduceMotion', label: '减少动画', keywords: 'motion animation 动画', render: () => <Toggle k="ui.reduceMotion" /> },
    ] },
    { id: 'interface', l: '界面', ic: '▦', entries: [
      { id: 'ui.singleWindow', label: '单窗格模式', hint: '隐藏分组与分屏，所有会话在同一个窗格里切换', keywords: 'single pane layout 分屏 分组', render: () => <Toggle k="ui.singleWindow" /> },
      { id: 'ui.showThinking', label: '显示思考过程', hint: '展开模型的 thinking 块', keywords: 'thinking reasoning 思考', render: () => <Toggle k="ui.showThinking" /> },
      { id: 'ui.autoSave', label: '编辑器自动保存', hint: '停止输入 0.8 秒后写回磁盘', keywords: 'editor autosave monaco 保存', render: () => <Toggle k="ui.autoSave" def /> },
      { id: 'ui.diffMode', label: '默认 diff 视图', keywords: 'diff split unified 并排 内联', render: () => <Select k="ui.diffMode" def="unified" options={[{ id: 'unified', l: '内联' }, { id: 'split', l: '并排' }]} /> },
      { id: 'ui.confirmExit', label: '退出时确认', hint: '有运行中的会话或未保存文件时提示', keywords: 'quit exit close 退出 关闭', render: () => <Toggle k="ui.confirmExit" def /> },
      { id: 'ui.closeToTray', label: '关闭窗口时最小化到托盘', hint: '桌面版：关闭最后一个窗口不退出，留在托盘继续跑会话', keywords: 'tray minimize close 托盘', render: () => <Toggle k="ui.closeToTray" def /> },
      { id: 'ui.notifications', label: '桌面通知', hint: '会话需要你或完成时弹通知', keywords: 'notification 通知', render: () => <Toggle k="ui.notifications" def /> },
    ] },
    { id: 'session', l: '会话', ic: '◌', entries: [
      { id: 'autoContinueOnReset', label: '额度恢复后自动继续', hint: '被限流时到重置时间自动重发上一条', keywords: 'rate limit quota 限流 额度', render: () => <Toggle k="autoContinueOnReset" /> },
      { id: 'ui.defaultMode', label: '新会话默认权限模式', keywords: 'permission mode 权限', render: () => <Select k="ui.defaultMode" def="default" options={[{ id: 'default', l: '每次询问' }, { id: 'acceptEdits', l: '自动接受编辑' }, { id: 'plan', l: '计划模式' }, { id: 'auto', l: '自动模式' }, { id: 'bypassPermissions', l: '完全权限' }]} /> },
      { id: 'ui.softwareRender', label: '软件渲染（桌面版）', hint: '显卡驱动异常导致黑屏 / 闪烁时打开，重启后生效', keywords: 'gpu render 黑屏 闪烁 disable-gpu', render: () => <Toggle k="ui.softwareRender" /> },
    ] },
    { id: 'engine', l: '引擎与账号', ic: '⚙', keywords: 'engine ccb claude login 登录 doctor 更新', body: () => <Overview /> },
    { id: 'providers', l: '供应商 / 环境', ic: '☁', keywords: 'provider api key base url 供应商 中转 env 环境变量 openai gemini', body: () => <><ProviderProfiles /><EnvEditor /></> },
    { id: 'models', l: '模型', ic: '◈', keywords: 'model 模型 启用 opus sonnet haiku', body: () => <ModelsSection /> },
    { id: 'secrets', l: '密钥', ic: '🔒', keywords: 'secret keychain credential 密钥 钥匙串 加密', body: () => <SecretsSection /> },
    { id: 'mcp', l: 'MCP', ic: '⌬', keywords: 'mcp server 目录 registry 健康', body: () => <><McpCatalog /><Mcp /></> },
    { id: 'plugins', l: '插件', ic: '▣', keywords: 'plugin marketplace 插件 市场', body: () => <Plugins /> },
    { id: 'skills', l: 'Skills', ic: '✦', keywords: 'skill 技能 安装 github', body: () => <SkillsSection /> },
    { id: 'agents', l: 'Agents', ic: '⧉', keywords: 'agent subagent 子代理', body: () => <SimpleList kind="config.agents" render={(a) => <div className="grow"><div>{a.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{a.source}{a.model ? ` · ${a.model}` : ''}</span></div><div className="sub">{a.description}</div></div>} /> },
    { id: 'hooks', l: 'Hooks', ic: '⚓', keywords: 'hook 钩子', body: () => <SimpleList kind="config.hooks" render={(h) => <div className="grow"><div>{h.event} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{h.matcher ? `matcher: ${h.matcher}` : ''} · {h.source}</span></div><div className="sub">{(h.hooks ?? []).map((x: any) => x.command ?? x.type).join(' ; ')}</div></div>} /> },
    { id: 'tools', l: 'CLI 工具', ic: '⌨', keywords: 'git gh node python uv docker ripgrep 工具 检测', body: () => <ToolsSection /> },
    { id: 'update', l: '更新', ic: '⇪', keywords: 'update version release 更新 版本', body: () => <UpdateSection /> },
    { id: 'diagnostics', l: '诊断', ic: '🩺', keywords: 'diagnostic log bundle 日志 诊断包', body: () => <DiagnosticsSection /> },
    { id: 'raw', l: 'settings.json', ic: '{}', keywords: 'settings json raw 原文 user project local', body: () => <Settings /> },
  ], []);
}

/** Searchable settings window (Ctrl+,). `settingsOpen.reveal` scrolls to / highlights one entry. */
export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const sections = useSections();
  const [q, setQ] = useState('');
  const [sec, setSec] = useState('appearance');
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQ(open.query ?? '');
    if (open.section) setSec(open.section);
    else if (open.reveal) setSec(sections.find((s) => s.entries?.some((e) => e.id === open.reveal))?.id ?? sec);
    setTimeout(() => {
      inp.current?.focus();
      if (open.reveal) document.querySelector(`[data-entry="${CSS.escape(open.reveal)}"]`)?.scrollIntoView({ block: 'center' });
    }, 30);
  }, [open]);
  if (!open) return null;
  const close = () => useStore.setState({ settingsOpen: null });
  const ql = q.trim().toLowerCase();
  const hits = ql
    ? sections.flatMap((s) => [
      ...(s.entries ?? []).filter((e) => `${e.label} ${e.hint ?? ''} ${e.keywords ?? ''} ${e.id} ${s.l}`.toLowerCase().includes(ql)).map((e) => ({ s, e })),
      ...(s.body && `${s.l} ${s.keywords ?? ''}`.toLowerCase().includes(ql) ? [{ s, e: null as Entry | null }] : []),
    ])
    : [];
  const cur = sections.find((s) => s.id === sec) ?? sections[0];
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="set-side">
          <input ref={inp} className="field" placeholder="搜索设置…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="set-nav">
            {sections.map((s) => <button key={s.id} className={clsx(s.id === sec && !ql && 'active')} onClick={() => { setQ(''); setSec(s.id); }}><span className="ic">{s.ic}</span>{s.l}</button>)}
          </div>
        </div>
        <div className="set-main">
          <div className="set-head"><h3>{ql ? `搜索「${q}」` : cur.l}</h3><span className="grow" /><button className="icon-btn" onClick={close} title="关闭 (Esc)">✕</button></div>
          <div className="set-body">
            {ql ? (
              hits.length ? hits.map(({ s, e }) => (
                e ? (
                  <div key={`${s.id}:${e.id}`} data-entry={e.id} className="set-row-wrap"><div className="set-crumb">{s.l}</div><Row label={e.label} hint={e.hint}>{e.render()}</Row></div>
                ) : (
                  <div key={s.id} className="set-row-wrap"><button className="set-jump" onClick={() => { setQ(''); setSec(s.id); }}><span className="ic">{s.ic}</span>{s.l} <span className="muted">打开分区 →</span></button></div>
                )
              )) : <div className="empty">没有匹配的设置</div>
            ) : cur.entries ? (
              cur.entries.map((e) => <div key={e.id} data-entry={e.id} className={clsx('set-row-wrap', open.reveal === e.id && 'reveal')}><Row label={e.label} hint={e.hint}>{e.render()}</Row></div>)
            ) : (
              <div className="set-section">{cur.body?.()}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
