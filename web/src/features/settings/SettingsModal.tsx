import { useEffect, useRef, useState, type ReactNode } from 'react';
import { THEMES, useStore } from '@/store';
import { clsx } from '@/util';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { Mcp, McpAddJson, Overview, Plugins, ProviderProfiles, Settings, SimpleList } from '@/features/panels/ConfigPanel';
import { CJK_FONTS, DEFAULT_THEME, DENSITIES, FONT_SIZES } from './ui-settings';
import { SkillsBackup, SkillsSection } from './SkillsSection';
import { ToolsSection } from './ToolsSection';
import { AgentsSection } from './AgentsSection';
import { LibrarySection } from './LibrarySection';
import { HostsSection, RemoteSection } from './RemoteSection';
import { PeersSection } from './PeersSection';
import { ImSection } from './ImSection';
import { SecretsSection } from './SecretsSection';
import { GatewaySection } from './GatewaySection';
import { UpdateSection, type UpdateState } from './UpdateSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { ModelsSection } from './ModelsSection';
import { McpCatalog } from './McpCatalog';
import { AccountSection } from './AccountSection';
import { EnvEditor } from './EnvEditor';
import { MemorySettings } from '@/features/memory/MemorySettings';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { MODE_LABEL } from '@/ui/terms';
import type { GatewayStatus, PermissionMode } from '@shared';
import {
  ADVANCED_SECTIONS, BODY_INFO, SETTINGS_GROUPS, VISIBLE_SECTIONS, activeTab, findSection, moreHint, navStatus,
  resolveSettingsTarget, searchSettings, type BodyId, type EntryId, type EntryMeta, type SectionMeta, type SettingsHit,
  type SettingsTarget,
} from './catalog';
import { NumberSelect, Row, Seg, Select, Toggle } from './controls';

export { Row } from './controls';

/** Modes offered as the default for new sessions (dontAsk is a per-session choice, not a default). */
const DEFAULT_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const THEME_NAME: Record<string, string> = { system: '跟随系统', dark: '深色', light: '浅色' };

/** The control of every row in the settings map (catalog.ts); typed on EntryId, so a row without one does not compile. */
const CONTROLS: Record<EntryId, (e: EntryMeta) => ReactNode> = {
  'ui.defaultMode': (e) => <Select k={e.id} def="default" label={e.label} options={DEFAULT_MODES.map((m) => ({ id: m, l: MODE_LABEL[m] }))} />,
  autoContinueOnReset: (e) => <Toggle k={e.id} label={e.label} />,
  'ui.showThinking': (e) => <Toggle k={e.id} label={e.label} />,
  'ui.diffMode': (e) => <Seg k={e.id} def="unified" label={e.label} options={[{ id: 'unified', l: '上下对照' }, { id: 'split', l: '左右并排' }]} />,
  'ui.workbench': (e) => <Toggle k={e.id} label={e.label} />,
  'ui.autoSave': (e) => <Toggle k={e.id} def label={e.label} />,
  'ui.notifications': (e) => <Toggle k={e.id} def label={e.label} />,
  'ui.closeToTray': (e) => <Toggle k={e.id} def label={e.label} />,
  'ui.confirmExit': (e) => <Toggle k={e.id} def label={e.label} />,
  'ui.softwareRender': (e) => <Toggle k={e.id} label={e.label} />,
  'orchestra.maxParallel': (e) => <NumberSelect k={e.id} def={3} label={e.label} options={[1, 2, 3, 4, 6, 8]} />,
  'ui.theme': (e) => <Select k={e.id} def={DEFAULT_THEME} label={e.label} options={[{ id: 'system', l: THEME_NAME.system }, ...THEMES.map((t) => ({ id: t, l: THEME_NAME[t] ?? t }))]} />,
  'ui.fontSize': (e) => <NumberSelect k={e.id} def={14} label={e.label} options={FONT_SIZES} />,
  'ui.density': (e) => <Select k={e.id} def="comfortable" label={e.label} options={DENSITIES as any} />,
  'ui.cjkFont': (e) => <Select k={e.id} def="" label={e.label} options={CJK_FONTS} />,
  'ui.reduceMotion': (e) => <Toggle k={e.id} label={e.label} />,
};

const muted = { color: 'var(--ink-3)', fontSize: 11 } as const;
/** Every page part (catalog.ts BodyId); the components keep their own requests and state. */
const BODIES: Record<BodyId, () => ReactNode> = {
  account: () => <AccountSection />,
  engine: () => <Overview part="engine" />,
  models: () => <ModelsSection />,
  providers: () => <ProviderProfiles />,
  gateway: () => <GatewaySection />,
  mcp: () => <Mcp />,
  mcpCatalog: () => <McpCatalog />,
  mcpJson: () => <McpAddJson />,
  plugins: () => <Plugins />,
  skills: () => <SkillsSection />,
  skillsBackup: () => <SkillsBackup />,
  agents: () => <AgentsSection />,
  subagents: () => <SimpleList kind="config.agents" empty="还没有子代理。~/.claude/agents 里的 .md 文件和插件带的子代理会出现在这里。" render={(a) => <div className="grow"><div>{a.name} <span style={muted}>{a.source}{a.model ? ` · ${a.model}` : ''}</span></div><div className="sub">{a.description}</div></div>} />,
  memory: () => <MemorySettings />,
  remote: () => <RemoteSection />,
  peers: () => <PeersSection />,
  hosts: () => <HostsSection />,
  im: () => <ImSection />,
  library: () => <LibrarySection />,
  secrets: () => <SecretsSection />,
  hooks: () => <SimpleList kind="config.hooks" empty="还没有 Hooks。settings.json 或插件里配置的会出现在这里。" render={(h) => <div className="grow"><div>{h.event} <span style={muted}>{h.matcher ? `matcher: ${h.matcher}` : ''} · {h.source}</span></div><div className="sub">{(h.hooks ?? []).map((x: any) => x.command ?? x.type).join(' ; ')}</div></div>} />,
  env: () => <EnvEditor bare />,
  tools: () => <ToolsSection />,
  diagnostics: () => <DiagnosticsSection />,
  update: () => <UpdateSection />,
  raw: () => <Settings />,
};

/** Is the key event aimed at something you type into? ('/' focuses the search only when it is not.) */
function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/**
 * The settings window (Ctrl+,), full-window like Linear / Codex (spec §5.7): grouped navigation + search on the left,
 * the page in a 660px column on the right. `settingsOpen` = {section, query, reveal}; old section ids still work
 * (catalog.ts LEGACY_SECTIONS). The app underneath stays mounted.
 */
export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsPage open={open} />;
}

function SettingsPage({ open }: { open: { section?: string; query?: string; reveal?: string } }) {
  const [target, setTarget] = useState<SettingsTarget>(() => resolveSettingsTarget(open));
  const [q, setQ] = useState(open.query ?? '');
  const [moreOpen, setMoreOpen] = useState(!!target.more);
  const [advOpen, setAdvOpen] = useState(!!findSection(target.section)?.advanced);
  // phones (≤ 600px): the navigation and the page take turns; opened on a given page = the page
  const [phonePage, setPhonePage] = useState(!!(open.section || open.reveal));
  const inp = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ settingsOpen: null });

  const go = (t: SettingsTarget) => {
    setTarget(t);
    setMoreOpen(!!t.more);
    setPhonePage(true);
    if (findSection(t.section)?.advanced) setAdvOpen(true);
  };
  // a new openSettings() while open (a link in a section, the model menu's 管理模型…) moves to that page
  const seen = useRef(open);
  useEffect(() => { if (open.query) inp.current?.focus(); }, []);
  useEffect(() => {
    if (seen.current === open) return;
    seen.current = open;
    setQ(open.query ?? '');
    go(resolveSettingsTarget(open));
  }, [open]);
  // the phone drawer would sit above this page
  useEffect(() => { const st = useStore.getState(); if (st.mobile && st.sidebarOpen) useStore.setState({ sidebarOpen: false }); }, []);
  // after a move: scroll to the revealed row / part, or to the top
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const root = scroller.current;
      if (!root) return;
      const el = target.reveal ? root.querySelector(`[data-entry="${CSS.escape(target.reveal)}"]`) : target.body ? root.querySelector(`[data-body="${CSS.escape(target.body)}"]`) : null;
      if (el) el.scrollIntoView({ block: 'center' });
      else root.scrollTop = 0;
    });
    return () => cancelAnimationFrame(id);
  }, [target]);
  // '/' → search (like the mock's hint), unless typing somewhere
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) { e.preventDefault(); inp.current?.focus(); inp.current?.select(); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const status = useNavStatus();
  const sec = findSection(target.section) ?? VISIBLE_SECTIONS[0];
  const searching = !!q.trim();
  const hits = searching ? searchSettings(q) : [];
  const pick = (t: SettingsTarget) => { setQ(''); go(t); };

  const navItem = (s: SectionMeta) => (
    <button key={s.id} className={clsx('sp-si', s.id === sec.id && !searching && 'on')} data-section={s.id} aria-current={s.id === sec.id && !searching ? 'page' : undefined} onClick={() => pick({ section: s.id })}>
      <Icon name={s.ic} size={15} /><span className="t">{s.l}</span>{status[s.id] && <span className="r">{status[s.id]}</span>}
    </button>
  );

  return (
    <div
      className={clsx('modal settings sp', phonePage && 'phone-page')}
      role="dialog"
      aria-label="设置"
      data-section={sec.id}
      data-tab={activeTab(sec, target.tab)?.id}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (searching && e.target === inp.current) setQ('');
        else close();
      }}
    >
      <nav className="sp-nav">
        <div className="sp-nav-top">
          <button className="sp-back" onClick={close} title="返回 (Esc)"><Icon name="restore" size={16} />返回</button>
        </div>
        <label className="sp-search">
          <Icon name="search" size={14} />
          <input ref={inp} placeholder="搜索设置" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索设置" />
          {!q && <span className="kbd">/</span>}
        </label>
        <div className="sp-groups">
          {SETTINGS_GROUPS.filter((g) => g.id !== 'advanced').map((g) => (
            <div key={g.id} className="sp-g">
              <div className="sp-gh">{g.l}</div>
              {VISIBLE_SECTIONS.filter((s) => s.group === g.id).map(navItem)}
            </div>
          ))}
          <div className={clsx('sp-g sp-adv', advOpen && 'open')}>
            <button className="sp-gh sp-adv-h" aria-expanded={advOpen} onClick={() => setAdvOpen(!advOpen)}>高级<Icon name={advOpen ? 'chevronDown' : 'chevronRight'} size={12} /></button>
            {advOpen ? ADVANCED_SECTIONS.map(navItem) : <button className="sp-adv-sub" onClick={() => setAdvOpen(true)}>{ADVANCED_SECTIONS.map((s) => s.l).join(' · ')}</button>}
          </div>
        </div>
        <VersionLine onOpen={() => pick({ section: 'update' })} />
      </nav>

      <main className="sp-main">
        <div className="sp-drag" />
        <div className="sp-scroll" ref={scroller}>
          <div className="sp-inner">
            <button className="sp-phone-back" onClick={() => setPhonePage(false)}><Icon name="restore" size={15} />全部设置</button>
            {searching ? (
              <SearchResults q={q} hits={hits} pick={pick} />
            ) : (
              <Page key={sec.id} sec={sec} tab={target.tab} reveal={target.reveal} moreOpen={moreOpen} setMoreOpen={setMoreOpen} setTab={(tab) => go({ section: sec.id, tab })} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Nav row statuses: login (the server's shared `config.auth`), provider count, gateway on / off. Nothing that spawns MCP servers. */
function useNavStatus() {
  const providers = useStore((s) => s.providers.length);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [gateway, setGateway] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    ws.request<any>({ kind: 'config.auth' }).then((a) => live && setLoggedIn(typeof a?.loggedIn === 'boolean' ? a.loggedIn : null)).catch(() => {});
    const loadGw = () => ws.request<GatewayStatus>({ kind: 'gateway.status' }).then((g) => live && setGateway(!!g?.enabled)).catch(() => {});
    void loadGw();
    const off = ws.on((e) => { if (e.kind === 'gateway.changed') void loadGw(); });
    return () => { live = false; off(); };
  }, []);
  return navStatus({ loggedIn, providers, gatewayEnabled: gateway });
}

/** Bottom-left: the app version and whether it is current (desktop); click → 高级 › 更新. */
function VersionLine({ onOpen }: { onOpen: () => void }) {
  const [st, setSt] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!desktop?.onUpdate) return;
    const off = desktop.onUpdate((s: UpdateState) => setSt(s));
    void desktop.updateState?.().then((s) => s && setSt(s));
    return off;
  }, []);
  const note = st?.status === 'none' ? '已是最新' : st?.status === 'available' ? `有新版本 ${st.version ?? ''}` : st?.status === 'downloaded' ? '重启即可更新' : st?.status === 'downloading' ? '下载更新中' : '';
  return (
    <button className="sp-ver" onClick={onOpen} title="更新">
      <span className={clsx('dot', st?.status === 'none' && 'ok', (st?.status === 'available' || st?.status === 'downloaded') && 'new')} />
      {desktop ? `Claude Web ${desktop.version}` : 'Claude Web · 网页版'}{note && ` · ${note}`}
    </button>
  );
}

function EntryRow({ sec, e, reveal }: { sec: SectionMeta; e: EntryMeta; reveal?: string }) {
  return (
    <div className={clsx('sp-row-wrap', reveal === e.id && 'reveal')} data-entry={e.id}>
      <ErrorBoundary area={`设置 · ${sec.l} · ${e.label}`} compact>
        <Row label={e.label} hint={e.hint} tag={e.tag}>{CONTROLS[e.id](e)}</Row>
      </ErrorBoundary>
    </div>
  );
}

/** 更多选项: the page's low-frequency rows and parts. Mounted on first open (their requests wait until then), kept after. */
function More({ open, onToggle, hint, children }: { open: boolean; onToggle: () => void; hint: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true); // in this render, so a reveal / scroll right after opening finds the rows
  return (
    <div className={clsx('sp-more', open && 'open')}>
      <button className="sp-more-h" aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />更多选项{hint && !open && <span className="faint">· {hint}</span>}
      </button>
      {mounted && <div className="sp-more-body" hidden={!open}>{children}</div>}
    </div>
  );
}

function Page({ sec, tab, reveal, moreOpen, setMoreOpen, setTab }: { sec: SectionMeta; tab?: string; reveal?: string; moreOpen: boolean; setMoreOpen: (v: boolean) => void; setTab: (id: string) => void }) {
  const t = activeTab(sec, tab);
  const entries = sec.entries ?? [];
  const main = entries.filter((e) => !e.more);
  const moreEntries = entries.filter((e) => e.more);
  const bodies = t ? t.bodies : sec.bodies ?? [];
  const moreBodies = t ? t.more ?? [] : sec.more ?? [];
  const parts = bodies.length + moreBodies.length;
  const blocks: { h?: string; rows: EntryMeta[] }[] = [];
  for (const e of main) {
    const last = blocks[blocks.length - 1];
    if (last && last.h === e.block) last.rows.push(e);
    else blocks.push({ h: e.block, rows: [e] });
  }
  const body = (b: BodyId) => (
    <div key={b} className="sp-body" data-body={b}>
      <ErrorBoundary area={parts === 1 && !t ? `设置 · ${sec.l}` : `设置 · ${sec.l} · ${BODY_INFO[b].l}`} resetKeys={[sec.id, t?.id]}>{BODIES[b]()}</ErrorBoundary>
    </div>
  );
  return (
    <>
      <h1 className="sp-title">{sec.l}</h1>
      <div className="sp-lead">{sec.desc}</div>
      {sec.tabs && (
        <div className="sp-tabs" role="tablist">
          {sec.tabs.map((x) => <button key={x.id} role="tab" aria-selected={x.id === t?.id} data-tab={x.id} className={clsx(x.id === t?.id && 'on')} onClick={() => setTab(x.id)}>{x.l}</button>)}
        </div>
      )}
      {blocks.map((b, i) => (
        <div key={b.h ?? i}>
          {b.h && <div className="sp-blk-h">{b.h}</div>}
          <div className="sp-card">{b.rows.map((e) => <EntryRow key={e.id} sec={sec} e={e} reveal={reveal} />)}</div>
        </div>
      ))}
      <div key={t?.id ?? 'page'} className="sp-bodies">{bodies.map(body)}</div>
      {(moreEntries.length > 0 || moreBodies.length > 0) && (
        <More key={`more-${t?.id ?? ''}`} open={moreOpen} onToggle={() => setMoreOpen(!moreOpen)} hint={moreHint(sec, t?.id)}>
          {moreEntries.length > 0 && <div className="sp-card">{moreEntries.map((e) => <EntryRow key={e.id} sec={sec} e={e} reveal={reveal} />)}</div>}
          {moreBodies.map(body)}
        </More>
      )}
    </>
  );
}

function SearchResults({ q, hits, pick }: { q: string; hits: SettingsHit[]; pick: (t: SettingsTarget) => void }) {
  return (
    <>
      <h1 className="sp-title">搜索「{q.trim()}」</h1>
      <div className="sp-lead">{hits.length ? `${hits.length} 条结果` : '没有匹配的设置。试试别的说法，或者换成英文 / 旧名称。'}</div>
      <div className="sp-hits">
        {hits.map((h) => h.kind === 'entry' ? (
          <div key={`e:${h.entry.id}`} className="sp-hit">
            <div className="sp-crumb">{h.crumb}</div>
            <div className="sp-card"><EntryRow sec={h.section} e={h.entry} /></div>
          </div>
        ) : (
          <button
            key={`p:${h.section.id}:${h.tab?.id ?? ''}:${h.body ?? ''}`}
            className="sp-jump"
            data-target={`${h.section.id}${h.tab ? `/${h.tab.id}` : ''}${h.body ? `#${h.body}` : ''}`}
            onClick={() => pick({ section: h.section.id, tab: h.tab?.id, body: h.body, more: h.more })}
          >
            <Icon name={h.section.ic} size={15} />
            <span className="t">{h.title}</span>
            <span className="sp-crumb">{h.crumb}</span>
            <Icon name="chevronRight" size={14} />
          </button>
        ))}
      </div>
    </>
  );
}
