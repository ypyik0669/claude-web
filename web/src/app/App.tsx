import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hideSheet, useStore } from '@/store';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { Workbench } from '@/features/workbench/Workbench';
import { Dock } from '@/features/workbench/Dock';
import { ShortcutsModal } from '@/features/workbench/ShortcutsModal';
import { matchBrowserKey } from '@/features/workbench/shortcuts';
import { runCommand } from '@/features/workbench/commands';
import { claimSession } from '@/features/workbench/windows';
import { showPanel } from '@/features/workbench/right-panel';
import { clsx } from '@/util';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { ImageViewer } from '@/features/chat/ImageViewer';
import { DialogHost } from '@/ui/dialog';
import { ConnectModelHost } from '@/features/providers/ConnectModel';
import { AddSourceLazy } from '@/features/gateway/AddSourceLazy';
import { UpdatePrompt } from '@/features/update/UpdatePrompt';
import { SettingsModal } from '@/features/settings/SettingsModal';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { desktop, isDesktop } from '@/desktop';
import { Icon } from '@/ui/icons';
import { installOrchestra } from '@/features/orchestra/state';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { Toasts } from '@/ui/Toasts';
import { SourcePickerLazy } from '@/features/recording/SourcePickerLazy';
import { RecordingIndicator } from '@/features/recording/RecordingIndicator';
import { chromeVisibility, workbenchOn } from '@/model/layout';
import { captionHeight, captionHeightAt, captionRow, captionWidth } from '@/features/workbench/tab-row';
import { setCaptionSize } from '@/ui/caption';
import { WindowControls } from '@/ui/WindowControls';
import { installZoom, useZoom } from '@/ui/zoom';
import { MOBILE_QUERY, drawerYields } from '@/ui/viewport';
import { installAutomation } from '@/features/automation/state';
import { installBackground } from '@/features/background/state';
import { installBots } from '@/features/bots/state';
import { installCafe } from '@/features/cafe/state';
import { CharacterLibrary } from '@/features/cafe/CharacterLibrary';
import { CodexLoginHost } from '@/features/settings/CodexLoginDialog';
import { BackgroundSide } from '@/features/background/BackgroundSide';
import { installBrowserHost } from '@/features/browser/host';
import { installThemes } from '@/themes/trial';
import { useSection } from '@/features/sections';
import { Rail } from '@/features/rail/Rail';
import { RAIL_WIDTH } from '@/features/rail/rail-model';
import { AutomationSide } from '@/features/automation/AutomationSide';
import { ExtensionsSide } from '@/features/extensions/ExtensionsSide';
import { ModelHubSide } from '@/features/model-hub/ModelHubSide';
import { installChecklist } from '@/features/home/checklist-sync';
import { installAccountDefault } from '@/features/models/account-default';
import { installSettingsClose } from '@/features/settings/close-on-nav';
import { pushBackLayer } from '@/ui/back-layer';
import { installPhoneSheet, sheetEnter, sheetTakesEscape, toggleSheetDetent, useSheetLeaving } from '@/ui/phone-sheet';
import { drawerEnter, installPhoneDrawer, usePhoneDrawer } from '@/ui/phone-drawer';
import { imeComposing } from '@/ui/ime';
import { tr } from '@/i18n';
import { applyUiSettings, resolveTheme, DEFAULT_THEME } from '@/features/settings/ui-settings';
import { setSafeMode } from '@/themes/apply';
import { CustomCss } from './custom-css';
import { AddAccountHost } from '@/features/settings/ClaudeAccounts';
import { FileMenu } from '@/features/files/FileMenu';
import { fillComposer } from '@/features/composer/fill';
import { quoteInComposer } from '@/features/composer/quote';
import { WhatsNewModal, useWhatsNewOnUpdate } from '@/features/update/WhatsNew';
import { startNavHistory } from '@/features/workbench/nav-history';
import { ProjectDialogLazy } from '@/features/sidebar/ProjectDialogLazy';
import { HandoffDialogHost } from '@/features/cloud/HandoffDialog';
import { CloudDialogsLazy } from '@/features/cloud/CloudDialogsLazy';

/** Width of the right panel minimized to its icon rail. */
const MIN_RAIL = 36;

/** Sidebar column with a drag handle on its right edge (width lives in the layout state). */
function SidebarColumn() {
  const width = useStore((s) => s.layout.sidebar.width);
  const dispatch = useStore((s) => s.dispatchLayout);
  const drag = useRef<{ x0: number; w0: number } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  // phone: the drawer a tap opened slides in (nothing happens anywhere else — ui/phone-drawer.ts)
  useLayoutEffect(() => { if (el.current) drawerEnter(el.current); }, []);
  // which section's sidebar: the conversations, or a page section's own (structure round 2). A phone's drawer is
  // always the conversations — the pages draw their parts as tabs there. Each is mounted when first shown and only
  // hidden after that (the list's filter, what was unfolded, a multi-select all survive a visit to 自动化). The Bot
  // page keeps its roster in its own first column, so beside it the sidebar is the conversations too (no second copy)
  const mobile = useStore((s) => s.mobile);
  const current = useSection();
  const section = mobile || current === 'bots' ? 'chat' : current;
  const [seen, setSeen] = useState<string[]>([section]);
  if (!seen.includes(section)) setSeen([...seen, section]);
  // NOTE: no inline `position` here — an inline style beats `.app.mobile .sidebar { position: fixed }`
  // regardless of specificity, which would leave the drawer in the grid flow and squash the workbench to 0px.
  return (
    <div className="sidebar has-resizer" ref={el}>
      <div className="sb-sect" data-section="chat" hidden={section !== 'chat'}><ErrorBoundary area={tr('侧栏')}><Sidebar onNew={() => runCommand('new')} /></ErrorBoundary></div>
      {seen.includes('background') && <div className="sb-sect" data-section="background" hidden={section !== 'background'}><ErrorBoundary area={tr('侧栏 · 后台')}><BackgroundSide /></ErrorBoundary></div>}
      {seen.includes('automation') && <div className="sb-sect" data-section="automation" hidden={section !== 'automation'}><ErrorBoundary area={tr('侧栏 · 自动化')}><AutomationSide /></ErrorBoundary></div>}
      <div className="sb-sect" data-section="gateway" hidden={section !== 'gateway'}><ErrorBoundary area={tr('侧栏 · 模型')}><ModelHubSide /></ErrorBoundary></div>
      {seen.includes('extensions') && <div className="sb-sect" data-section="extensions" hidden={section !== 'extensions'}><ErrorBoundary area={tr('侧栏 · 扩展')}><ExtensionsSide /></ErrorBoundary></div>}
      <div
        className="resizer right"
        onPointerDown={(e) => { drag.current = { x0: e.clientX, w0: width }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (drag.current) dispatch({ t: 'sidebar.set', patch: { width: Math.max(200, Math.min(520, drag.current.w0 + (e.clientX - drag.current.x0))) } }); }}
        onPointerUp={() => { drag.current = null; }}
        onDoubleClick={() => dispatch({ t: 'sidebar.set', patch: { width: 264 } })}
      />
    </div>
  );
}

const MOBILE = window.matchMedia(MOBILE_QUERY);

export function App() {
  useWhatsNewOnUpdate();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  // phone width lives in the store: the workbench chrome, the session header and the panel commands all follow it
  const mobile = useStore((s) => s.mobile);
  useEffect(() => { const on = () => useStore.setState({ mobile: MOBILE.matches }); on(); MOBILE.addEventListener('change', on); return () => MOBILE.removeEventListener('change', on); }, []);
  // ← → (workbench/nav-history.ts): follow the conversation in front from the start
  useEffect(() => { startNavHistory(); }, []);
  // (before the paint: a phone never shows the drawer — or its scrim, which would fade — open for a frame on the way)
  useLayoutEffect(() => { if (mobile) useStore.setState({ sidebarOpen: false }); }, [mobile]);
  // the palette / the shortcut sheet opened from the keyboard on a phone: the drawer (z 60) makes way (final review M4)
  useEffect(() => useStore.subscribe((s, p) => { if (drawerYields(p, s)) useStore.setState({ sidebarOpen: false }); }), []);
  useEffect(() => installOrchestra(), []);
  useEffect(() => installAutomation(), []);
  useEffect(() => installBackground(), []);
  useEffect(() => installBots(), []);
  useEffect(() => installCafe(), []);
  // this window as the browser an Agent's web tools work in (the desktop app only)
  useEffect(() => installBrowserHost(), []);
  // the user's own character themes, and the theme skill's trial runs (themes/trial.ts)
  useEffect(() => installThemes(), []);
  useEffect(() => installZoom(), []);
  useEffect(() => installChecklist(), []);
  useEffect(() => installAccountDefault(), []);
  useEffect(() => installSettingsClose(), []);
  const sbWidth = useStore((s) => s.layout.sidebar.width);
  const dock = useStore((s) => s.layout.dock);
  const inspect = useStore((s) => s.inspect);
  const dockShown = dock.open && (dock.tabs.length > 0 || !!inspect);
  // a phone's right panel is the bottom drawer: on screen only while it is up (store `sheetAt`), never minimised —
  // both derived here, nothing written to the desktop's layout (review 7 M4)
  const sheetUp = useStore((s) => s.sheetAt > 0);
  const rpWidth = !dockShown ? 0 : mobile ? (sheetUp ? dock.width : 0) : dock.minimized ? MIN_RAIL : dock.width;
  // going narrow (or wide) never brings the drawer up by itself: a desktop's open panel stays where it is
  useEffect(() => { useStore.setState({ sheetAt: 0, sheetDetent: 'half' }); }, [mobile]);
  // the settings page, the palette and the shortcut sheet cover the drawer while they are open (review 7 I1)
  const covered = useStore((s) => !!s.settingsOpen || s.paletteOpen || s.shortcutsOpen);

  // ---- phone: the two sliding surfaces (UI refresh §8; ui/phone-sheet.ts, ui/phone-drawer.ts, styles/phone-sheet.css)
  const app = useRef<HTMLDivElement>(null);
  const rpanel = useRef<HTMLDivElement>(null);
  const sheetBackdrop = useRef<HTMLDivElement>(null);
  const sheetOn = mobile && rpWidth > 0;
  // put away, the bottom sheet stays displayed until it has slid out; so does the sidebar drawer (and a finger
  // pulling the drawer in mounts it before `sidebarOpen` says so)
  const sheetLeaving = useSheetLeaving((s) => s.leaving);
  const drawerHeld = usePhoneDrawer((s) => s.held);
  // the sheet's height (半 / 全). The store is back at 半 the moment the sheet is put away; the element keeps the
  // size it had while it slides out
  const detent = useStore((s) => s.sheetDetent);
  const [shownDetent, setShownDetent] = useState(detent);
  if (sheetOn && shownDetent !== detent) setShownDetent(detent);
  // (after the effect above: crossing into phone width closes the sidebar before the drawer is there to slide out)
  useEffect(() => (mobile && app.current ? installPhoneDrawer(app.current) : undefined), [mobile]);
  useEffect(() => (mobile && rpanel.current ? installPhoneSheet(rpanel.current, () => sheetBackdrop.current) : undefined), [mobile]);
  // shown this very commit: it starts below the screen and slides up (before the first paint)
  useLayoutEffect(() => { if (sheetOn && rpanel.current) sheetEnter(rpanel.current); }, [sheetOn]);
  // the system's back gesture closes what is on top — the drawer, the sheet — instead of leaving the page; with the
  // sheet up Esc does the same and nothing else (not when the settings page / the palette covers it: Esc is theirs)
  useEffect(() => {
    if (!mobile || !sidebarOpen) return;
    return pushBackLayer(() => useStore.setState({ sidebarOpen: false }));
  }, [mobile, sidebarOpen]);
  useEffect(() => {
    if (!sheetOn || covered) return;
    const release = pushBackLayer(hideSheet);
    const onKey = (e: KeyboardEvent) => {
      if (!sheetTakesEscape(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // capture, on the window: the composer under the sheet never sees it
      hideSheet();
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); release(); };
  }, [sheetOn, covered]);
  // phone: a soft keyboard shrinks the visual viewport; the drawer's bottom rides above it (review 7 M6)
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!mobile || !vv) { root.style.removeProperty('--kb'); return; }
    const on = () => root.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on); root.style.removeProperty('--kb'); };
  }, [mobile]);

  // desktop caption buttons (Windows / Linux overlay). Windows: painted on nothing — they float over the top-right
  // card and the shell gap above it (a transparent overlay; the card's corner shows behind them). Linux, where that is
  // unverified, keeps one colour: the card (--bg) when a session header / the right panel is under them, the shell
  // (--bg-1) for the group bar or a tab strip
  const theme = useStore((s) => s.theme);
  const settingsOpen = useStore((s) => !!s.settingsOpen);
  const workbench = useStore((s) => workbenchOn(s.settings));
  const chromeRow = useStore((s) => {
    const vis = chromeVisibility(s.layout, { workbench: workbenchOn(s.settings) });
    return vis.groupBar || Object.values(vis.tabStrip).some(Boolean);
  });
  // the settings page covers everything with --bg; an open right panel owns the corner — its tab row is --bg-1 only
  // with the workbench tools (the default one is white)
  const sideSurface = !settingsOpen && (rpWidth > MIN_RAIL ? workbench : chromeRow);
  // …and as tall as the row they sit over (tab-row.ts `captionHeight`): their glyphs line up with the row's own icons
  const groupBar = useStore((s) => chromeVisibility(s.layout, { workbench: workbenchOn(s.settings) }).groupBar);
  const capRow = captionRow({ settings: settingsOpen, dockOpen: rpWidth > MIN_RAIL, workbench, groupBar, chromeRow });
  const density = useStore((s) => s.settings['ui.density']);
  const zoom = useZoom();
  const [capH, setCapH] = useState(60);
  useEffect(() => {
    const d = desktop;
    if (!d) return;
    const t = setTimeout(() => {
      const cs = getComputedStyle(document.documentElement);
      const linux = document.documentElement.classList.contains('linux');
      const px = (name: string) => parseFloat(cs.getPropertyValue(name));
      const dims = { gap: linux ? 0 : px('--shell-gap'), head: px('--h-head'), bar: px('--h-bar') };
      const height = captionHeightAt(zoom, capRow, dims);
      // menus keep clear of the buttons (ui/caption.ts) — not on macOS, whose traffic lights are on the left
      setCaptionSize(document.documentElement.classList.contains('mac') ? null : { w: captionWidth(zoom), h: captionHeight(capRow, dims) });
      setCapH(captionHeight(capRow, dims));
      d.setTitleBarColors(cs.getPropertyValue('--bg-1').trim(), cs.getPropertyValue('--fg-1').trim(), linux ? cs.getPropertyValue(sideSurface ? '--bg-1' : '--bg').trim() : '#00000000', height);
    }, 0);
    return () => clearTimeout(t);
  }, [theme, sideSurface, capRow, density, zoom]);
  // a browser's own chrome (Android's toolbar, an installed page's status bar) takes the colour of what is at the top
  // of the page: the shell's ground, or on a phone the conversation's sheet. index.html has the two defaults by the
  // system's light / dark; the theme chosen here may be neither
  useEffect(() => {
    if (desktop) return;
    const t = setTimeout(() => {
      const c = getComputedStyle(document.documentElement).getPropertyValue(mobile ? '--bg' : '--bg-1').trim();
      if (c) for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', c);
    }, 0);
    return () => clearTimeout(t);
  }, [theme, mobile]);

  // asking to inspect a tool call must bring 详情 to the front of the right panel — also when it is already a tab
  // behind another one (otherwise the detail button on a tool row does nothing visible). On a phone the right panel is
  // the bottom drawer: a step (the steps view) shows there too; a file (an attachment chip, Alt+click on a path) opens
  // in place like a plain click on a path — a whole screen beats a drawer for reading a file
  useEffect(() => {
    if (!inspect) return;
    const st = useStore.getState();
    if (!st.mobile || !inspect.file) { showPanel('inspector'); return; }
    st.openTile({ id: `d${Date.now().toString(36)}`, kind: 'doc', path: inspect.file.path, line: inspect.file.line }, 'tab');
    useStore.setState({ inspect: null });
  }, [inspect]);

  // desktop shell: menu accelerators arrive as commands; notifications click → focus session
  useEffect(() => {
    if (!desktop) return;
    const offCmd = desktop.onCommand((id) => runCommand(id));
    const offFocus = desktop.onFocusSession((sessionId) => {
      const st = useStore.getState();
      // only the window that holds the session responds; otherwise the main window claims it
      const holds = st.layout.groups.some((g) => Object.values(g.panes).some((p) => p.tiles.some((t) => t.kind === 'chat' && t.sessionId === sessionId)));
      if (holds) st.setActive(sessionId);
      else if (!desktop?.windowId || desktop.windowId === 'main') (st.open[sessionId] ? st.setActive(sessionId) : void st.loadHistory(sessionId));
      else claimSession(sessionId);
    });
    // 深链接: claude-web://new?folder=…&q=… fills the new-conversation page (never sends); …/session/<id> opens one
    const takeLink = async () => {
      const l = await desktop?.takeDeepLink?.().catch(() => null);
      if (!l) return;
      const st = useStore.getState();
      if (l.kind === 'session') { if (st.open[l.id]) st.setActive(l.id); else void st.loadHistory(l.id); return; }
      runCommand('new');
      requestAnimationFrame(() => fillComposer({ cwd: l.folder, text: l.q, focus: true }));
    };
    const offLink = desktop.onDeepLink?.(() => void takeLink());
    void takeLink();
    // 右键菜单 → 引用到输入框 (desktop/src/context-menu.ts): the selected text into the front conversation's input box
    const offQuote = desktop.onQuoteSelection?.((text) => {
      if (!quoteInComposer(text)) useStore.getState().toast(tr('先打开一个对话（或新对话），再引用'));
    });
    return () => { offCmd(); offFocus(); offLink?.(); offQuote?.(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (useStore.getState().settingsOpen) useStore.setState({ settingsOpen: null }); useStore.setState({ shortcutsOpen: false }); return; }
      // the way out of a character theme whose CSS hid the settings: the classic look until the next start
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'Digit0') {
        e.preventDefault();
        const st = useStore.getState();
        setSafeMode();
        applyUiSettings(st.settings);
        st.setTheme(resolveTheme((st.settings['ui.theme'] as any) ?? DEFAULT_THEME), true);
        st.toast(tr('已临时换回默认主题，下次启动恢复'));
        return;
      }
      const id = matchBrowserKey(e);
      if (!id) return;
      if (id === 'files.search' && imeComposing(e)) return;
      // on desktop the menu accelerators own the Ctrl-only chords; browser-only (Alt) chords still run here
      if (desktop && (e.ctrlKey || e.metaKey) && !e.altKey && !['pane.splitRight', 'pane.splitDown', 'pane.zoom', 'dock.toggle', 'dock.minimize', 'view.cycle', 'side', 'menu.effort', 'pane.close', 'shortcuts'].includes(id) && !id.startsWith('panel.') && !/^group\.jump/.test(id)) return;
      e.preventDefault();
      runCommand(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // `dock-open`: the right panel owns the window's top-right corner (desktop caption buttons sit over its tab row).
    // Not when it is minimized to its 36px icon rail: the buttons then cover the workbench's top-right row as well.
    <div ref={app} className={clsx('app', !sidebarOpen && 'no-sidebar', mobile && 'mobile', !mobile && 'has-rail', mobile && sidebarOpen && 'drawer-open', rpWidth > MIN_RAIL && !mobile && 'dock-open', sheetOn && 'sheet-open', sheetOn && covered && 'sheet-covered')} style={{ ['--rp' as any]: `${mobile ? 0 : rpWidth}px`, ['--sb' as any]: `${sbWidth}px`, ['--rail' as any]: `${mobile ? 0 : RAIL_WIDTH}px` }}>
      {/* desktop width: the icon rail, the window's first column (fixed to the left edge; the grid starts after it) */}
      {!mobile && <ErrorBoundary area={tr('图标栏')}><Rail /></ErrorBoundary>}
      {/* phone: both scrims are in the document the whole time — transparent and taking no taps until their surface
          is up (the style sheet) — so they fade with it and follow a drag. A tap on one puts its surface away */}
      {mobile && <div className="drawer-backdrop" onClick={() => useStore.setState({ sidebarOpen: false })} />}
      {/* the right panel is a bottom sheet over the conversation; putting it away hides it — the desktop's open /
          closed is not written */}
      {mobile && <div className="sheet-backdrop" ref={sheetBackdrop} onClick={hideSheet} />}
      {sidebarOpen || (mobile && drawerHeld) ? <SidebarColumn /> : <div className="sidebar" style={{ display: 'none' }} />}
      <ErrorBoundary area={tr('工作台')}><Workbench /></ErrorBoundary>
      <div className="rpanel" ref={rpanel} data-detent={mobile ? shownDetent : undefined} style={{ display: rpWidth || (mobile && sheetLeaving) ? 'flex' : 'none' }}>
        {/* phone: the sheet's handle — drag it (or the tab row under it) to move the sheet, tap it for 半 ⇄ 全 */}
        {mobile && <button type="button" className="sheet-grip" title={tr('拖动调整高度；点一下在半高和全高之间切换')} aria-label={shownDetent === 'full' ? tr('缩到半高') : tr('展开到全高')} onClick={() => { if (rpanel.current) toggleSheetDetent(rpanel.current); }} />}
        <ErrorBoundary area={tr('右侧面板')}><Dock /></ErrorBoundary>
      </div>
      <ErrorBoundary area={tr('通知')} floating><Toasts /></ErrorBoundary>
      {isDesktop && <ErrorBoundary area={tr('录屏')} floating><SourcePickerLazy /><RecordingIndicator /></ErrorBoundary>}
      <ErrorBoundary area={tr('命令面板')} floating><CommandPalette /></ErrorBoundary>
      <ErrorBoundary area={tr('快捷键')} floating><ShortcutsModal /></ErrorBoundary>
      <ErrorBoundary area={tr('更新内容')} floating><WhatsNewModal /></ErrorBoundary>
      <ErrorBoundary area={tr('设置')} floating onReset={() => useStore.setState({ settingsOpen: null })}><SettingsModal /></ErrorBoundary>
      <ErrorBoundary area={tr('首次引导')} floating><Onboarding /></ErrorBoundary>
      <ErrorBoundary area={tr('图片查看')} floating><ImageViewer /></ErrorBoundary>
      <ErrorBoundary area={tr('文件菜单')} floating><FileMenu /></ErrorBoundary>
      <ErrorBoundary area={tr('接一个模型')} floating><ConnectModelHost /></ErrorBoundary>
      <ErrorBoundary area={tr('添加来源')} floating><AddSourceLazy /></ErrorBoundary>
      {isDesktop && desktop?.platform !== 'darwin' && !mobile && <WindowControls height={capH} />}
      <ErrorBoundary area={tr('应用更新')} floating><UpdatePrompt /></ErrorBoundary>
      <ErrorBoundary area={tr('角色库')} floating><CharacterLibrary /></ErrorBoundary>
      <ErrorBoundary area={tr('登录 Codex 账号')} floating><CodexLoginHost /></ErrorBoundary>
      <ErrorBoundary area={tr('编辑项目')} floating><ProjectDialogLazy /></ErrorBoundary>
      <ErrorBoundary area={tr('交给常开机器继续')} floating><HandoffDialogHost /></ErrorBoundary>
      <ErrorBoundary area={tr('派活')} floating><CloudDialogsLazy /></ErrorBoundary>
      <ErrorBoundary area={tr('对话框')} floating><DialogHost /></ErrorBoundary>
      <ErrorBoundary area={tr('添加 Claude 账号')} floating><AddAccountHost /></ErrorBoundary>
      <CustomCss />
    </div>
  );
}
