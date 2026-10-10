import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { desktop } from '@/desktop';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { Popover } from '@/features/composer/Popover';
import { selectionOf } from './guest';
import { closeTab, ensureTab, frontTab, guestOf, guestReady, hasWebview, newTab, patchTab, setGuest, useBrowser, type BrowserTab, type WebviewEl } from './state';
import { RECENT_KEY, addressToUrl, frameSandbox, loadable, pushRecent, readRecent, siteHue, siteLetter, siteOf } from './url';
import './browser.css';

/** A site's letter on its own colour: what stands for a page that has no icon of ours to show. */
function SiteMark({ url, size = 16 }: { url: string; size?: number }) {
  return <span className="bw-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.58), ['--h' as string]: siteHue(url) }} aria-hidden>{siteLetter(url)}</span>;
}

const tabName = (t: BrowserTab) => t.title || (t.url ? siteOf(t.url) : '新标签页');

/** Send the page in a tab somewhere else: back, forward, again — whatever the page element offers. */
function drive(tabId: string, fn: 'goBack' | 'goForward' | 'reload' | 'stop') {
  try { guestOf(tabId)?.[fn](); } catch { /* the page is being replaced */ }
}

/** Give a tab an address: a new tab gets its page, a tab with a page is told to load. */
function go(tab: BrowserTab, input: string): boolean {
  const url = addressToUrl(input);
  if (!url || !loadable(url)) return false;
  if (!tab.src) { patchTab(tab.id, { src: url, url, loading: true, error: undefined }); return true; }
  patchTab(tab.id, { url, error: undefined });
  const el = guestOf(tab.id);
  if (el) void el.loadURL(url).catch(() => {});
  else patchTab(tab.id, { frameUrl: url });
  return true;
}

function recordVisit(url: string, title: string) {
  const st = useStore.getState();
  const next = pushRecent(readRecent(st.settings[RECENT_KEY]), { url, title, at: Date.now() });
  if (next) void st.setSetting(RECENT_KEY, next);
}

/**
 * `allowpopups` on the <webview>: without it the page's own window.open (and every link that opens a new window) is
 * blocked inside the page and nothing happens; with it the desktop shell is asked, which opens no window and hands
 * the address back as a new tab (desktop/src/main.ts). Written as a string: the attribute only has to be present,
 * and React drops a boolean on an attribute it does not know.
 */
const ALLOW_POPUPS = { allowpopups: 'true' } as unknown as { allowpopups?: boolean };

/**
 * One tab's page. Desktop: a real `<webview>` in the tab's browser profile, created with the tab's first address and
 * never given another `src` (it would reload) — it moves on by being told to load. Elsewhere: an `<iframe>`, which
 * only shows sites that allow being embedded.
 *
 * A tab that is not in front stays laid out (hidden, same size): an Agent may be working in it, and a page with no
 * size cannot be read by position or drawn.
 */
function TabView({ tab, front }: { tab: BrowserTab; front: boolean }) {
  const ref = useRef<WebviewEl | null>(null);
  const webview = hasWebview();
  useEffect(() => {
    const el = ref.current;
    if (!el || !webview) return;
    const id = tab.id;
    setGuest(id, el);
    const sync = () => {
      try { patchTab(id, { url: el.getURL() || tab.src, title: el.getTitle(), back: el.canGoBack(), fwd: el.canGoForward() }); } catch { /* not attached yet */ }
    };
    const onReady = () => { guestReady(id); sync(); };
    const onStart = () => patchTab(id, { loading: true, error: undefined });
    const onStop = () => {
      patchTab(id, { loading: false });
      sync();
      // the user's own browsing is what 最近打开 lists (not what an Agent looked up)
      try { if (!tab.agent) recordVisit(el.getURL(), el.getTitle()); } catch { /* not attached */ }
    };
    const onTitle = (e: Event) => patchTab(id, { title: String((e as unknown as { title?: string }).title ?? '').slice(0, 200) });
    const onFail = (e: Event) => {
      const f = e as unknown as { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      // -3: the load was replaced by another (a redirect in script, a download) — not a failure to show
      if (f.isMainFrame === false || f.errorCode === -3) return;
      patchTab(id, { loading: false, error: `${f.errorDescription || '加载失败'}（${f.errorCode ?? '?'}）` });
    };
    el.addEventListener('dom-ready', onReady);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', sync);
    el.addEventListener('did-navigate-in-page', sync);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-fail-load', onFail);
    return () => {
      el.removeEventListener('dom-ready', onReady);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', sync);
      el.removeEventListener('did-navigate-in-page', sync);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-fail-load', onFail);
      setGuest(id, null);
    };
  }, [tab.id, webview, !!tab.src]);

  if (!tab.src) return <div className="bw-view" data-tab={tab.id} hidden={!front}><NewTabPage tab={tab} front={front} /></div>;
  return (
    <div className={clsx('bw-view page', !front && 'back')} data-tab={tab.id} aria-hidden={!front}>
      {webview ? (
        // No `allowpopups`: the tag reads the attribute's PRESENCE, so `allowpopups="false"` would turn popups ON.
        // A page's new windows arrive as new tabs here (desktop/src/main.ts → `desktop.onBrowserPopup`).
        <webview ref={ref as unknown as React.Ref<HTMLWebViewElement>} src={tab.src} partition={tab.partition} {...ALLOW_POPUPS} />
      ) : (
        <>
          <iframe src={tab.frameUrl ?? tab.src} title={tabName(tab)} sandbox={frameSandbox(tab.frameUrl ?? tab.src, location.origin)} />
          <div className="bw-hint">网页版里只能显示允许被嵌入的网站，其它的是空白：点右上角 ··· 在系统浏览器打开。完整的浏览器在桌面版里。</div>
        </>
      )}
      {tab.error && (
        <div className="bw-error" role="alert">
          <span className="tile-ic tint-warn"><Icon name="alert" size={18} /></span>
          <b>打不开这个页面</b>
          <span className="why">{siteOf(tab.url)} · {tab.error}</span>
          <button className="btn sm" onClick={() => { patchTab(tab.id, { error: undefined }); drive(tab.id, 'reload'); }}>再试一次</button>
        </div>
      )}
    </div>
  );
}

/** A new tab's own page: one box for both searching and going somewhere, then the sites opened lately. */
function NewTabPage({ tab, front }: { tab: BrowserTab; front: boolean }) {
  const recent = useStore((s) => s.settings[RECENT_KEY]);
  const [q, setQ] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const sites = readRecent(recent).slice(0, 8);
  // the box takes the keyboard when the user opens a new tab — not when the panel merely mounts under something else
  const wasFront = useRef(false);
  useEffect(() => {
    if (front && !wasFront.current && document.activeElement?.closest('.bw')) box.current?.focus({ preventScroll: true });
    wasFront.current = front;
  }, [front]);
  return (
    <div className="bw-newtab">
      <span className="hero-ic tint-info"><Icon name="web" size={26} /></span>
      <form className="bw-search" onSubmit={(e) => { e.preventDefault(); go(tab, q); }}>
        <Icon name="search" size={16} />
        <input ref={box} value={q} spellCheck={false} placeholder="搜索，或者输入网址" aria-label="搜索，或者输入网址" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && imeComposing(e.nativeEvent)) e.preventDefault(); }} />
      </form>
      {sites.length > 0 && (
        <div className="bw-recent" data-id="recent">
          <div className="bw-h">最近打开</div>
          <div className="bw-sites">
            {sites.map((r) => (
              <button key={r.url} className="bw-site" title={r.url} onClick={() => go(tab, r.url)}>
                <SiteMark url={r.url} size={32} />
                <span className="tx"><span className="n">{siteOf(r.url)}</span><span className="d">{r.title || r.url}</span></span>
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="bw-tip"><Icon name="sparkle" size={13} />Agent 也用这个浏览器：在对话里让它「搜一下……」或者「打开这个网址看看」，它打开的页面会出现在这里。</p>
    </div>
  );
}

function AddressBar({ tab }: { tab: BrowserTab }) {
  const active = useScopedSession();
  const toast = useStore((s) => s.toast);
  const [addr, setAddr] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // the field follows the page unless it is being typed in
  useEffect(() => { if (!editing) setAddr(tab.url); }, [tab.url, tab.id, editing]);
  const closeMenu = useCallback((refocus: boolean) => { setMenu(false); if (refocus) more.current?.focus(); }, []);
  const hasPage = !!tab.src;
  const submit = () => { if (go(tab, addr)) { setEditing(false); field.current?.blur(); } };

  /** Hand the page to the conversation in front: its address, and what is selected on it. */
  const toChat = async () => {
    if (!active?.sessionId) return toast('先打开一个对话，再把页面发给它');
    const picked = await selectionOf(tab.id);
    const st = useStore.getState();
    const cur = st.open[active.sessionId]?.draft ?? '';
    const lines = [`页面：${tab.title ? `${tab.title} ` : ''}${tab.url}`, ...(picked ? [`选中的内容：\n${picked}`] : [])];
    st.setDraft(active.sessionId, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
    toast(picked ? '页面地址和选中的内容已放进输入框' : '页面地址已放进输入框', true);
  };
  const external = () => (desktop ? void desktop.openExternal(tab.url) : window.open(tab.url, '_blank', 'noopener,noreferrer'));

  return (
    <div className="bw-bar">
      <button className="icon-btn xs" disabled={!tab.back} title="后退" aria-label="后退" onClick={() => drive(tab.id, 'goBack')}><Icon name="chevronLeft" size={15} /></button>
      <button className="icon-btn xs" disabled={!tab.fwd} title="前进" aria-label="前进" onClick={() => drive(tab.id, 'goForward')}><Icon name="chevronRight" size={15} /></button>
      {tab.loading
        ? <button className="icon-btn xs" title="停止加载" aria-label="停止加载" onClick={() => drive(tab.id, 'stop')}><Icon name="close" size={14} /></button>
        : <button className="icon-btn xs" disabled={!hasPage} title="重新加载" aria-label="重新加载" onClick={() => drive(tab.id, 'reload')}><Icon name="refresh" size={14} /></button>}
      <div className={clsx('bw-addr', editing && 'on', tab.loading && 'loading')}>
        <Icon name={/^https:/i.test(tab.url) ? 'lock' : 'web'} size={13} />
        <input
          ref={field}
          value={addr}
          spellCheck={false}
          placeholder="搜索，或者输入网址"
          aria-label="地址"
          data-id="address"
          onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (imeComposing(e.nativeEvent)) return;
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { e.stopPropagation(); setAddr(tab.url); e.currentTarget.blur(); }
          }}
        />
      </div>
      <button className="icon-btn xs" disabled={!hasPage} title="把这个页面的地址（和选中的文字）放进对话的输入框" aria-label="发给对话" data-id="to-chat" onClick={() => void toChat()}><Icon name="quote" size={14} /></button>
      <button className="icon-btn xs" title="新标签页" aria-label="新标签页" data-id="new-tab" onClick={() => newTab()}><Icon name="plus" size={15} /></button>
      <button ref={more} className={clsx('icon-btn xs', menu && 'active')} disabled={!hasPage} title="更多" aria-label="更多" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" size={15} /></button>
      {menu && (
        <Popover anchor={more} onClose={closeMenu} prefer="down" align="right" className="bw-menu" label="这个页面">
          <button type="button" data-mi role="menuitem" className="cm-it" onClick={() => { closeMenu(false); external(); }}><span className="cm-ck"><Icon name="external" size={14} /></span><span className="cm-tx"><span className="cm-l">在系统浏览器打开</span></span></button>
          <button type="button" data-mi role="menuitem" className="cm-it" onClick={() => { closeMenu(false); void navigator.clipboard?.writeText(tab.url).then(() => toast('已复制地址', true), () => toast('没能复制')); }}><span className="cm-ck"><Icon name="copy" size={14} /></span><span className="cm-tx"><span className="cm-l">复制地址</span></span></button>
          {hasWebview() && <button type="button" data-mi role="menuitem" className="cm-it" onClick={() => { closeMenu(false); try { guestOf(tab.id)?.openDevTools?.(); } catch { /* not attached */ } }}><span className="cm-ck"><Icon name="bash" size={14} /></span><span className="cm-tx"><span className="cm-l">开发者工具</span></span></button>}
        </Popover>
      )}
    </div>
  );
}

/** Whose Agent works in this tab — and, while it does, that it is doing so. */
function AgentStrip({ tab }: { tab: BrowserTab }) {
  const title = useStore((s) => s.sessions.find((x) => x.sessionId === tab.agent)?.title);
  const loadHistory = useStore((s) => s.loadHistory);
  return (
    <div className={clsx('bw-agent', tab.busy && 'busy')} data-id="agent-strip">
      <Icon name="sparkle" size={13} />
      <span className="t">{tab.busy ? 'Agent 正在操作这个页面' : 'Agent 打开的页面'}{title ? ` · ${title}` : ''}</span>
      <span className="grow" />
      {tab.agent && <button className="link" onClick={() => void loadHistory(tab.agent!)}>看对话</button>}
    </div>
  );
}

/**
 * 浏览器 — the right panel's fifth fixed tab (spec 2026-10-10-ui-structure §4): the address bar, the page, and a row
 * of tabs once there is more than one. The user browses here; an Agent's web tools work here too, each conversation
 * in a tab of its own (host.ts), marked as the Agent's.
 */
export function BrowserPanel({ visible }: { visible: boolean }) {
  const tabs = useBrowser((s) => s.tabs);
  const activeId = useBrowser((s) => s.active);
  useLayoutEffect(() => { ensureTab(); }, []);
  // a page's own new windows open as tabs here
  useEffect(() => desktop?.onBrowserPopup?.((p) => { if (p?.url && loadable(p.url)) newTab({ url: p.url }); }), []);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  if (!tab) return <div className="bw" />;
  return (
    <div className="bw" data-visible={visible || undefined}>
      {tabs.length > 1 && (
        <div className="bw-tabs" role="tablist" aria-label="浏览器的标签页">
          {tabs.map((t) => (
            <div key={t.id} role="tab" tabIndex={0} aria-selected={t.id === tab.id} className={clsx('bw-tab', t.id === tab.id && 'on', t.agent && 'agent')} data-tab={t.id} title={`${tabName(t)}${t.agent ? '\nAgent 打开的页面' : ''}`}
              onClick={() => frontTab(t.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); frontTab(t.id); } }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}>
              {t.loading ? <span className="spinner" aria-hidden /> : t.agent ? <span className="bw-bot" aria-hidden><Icon name="sparkle" size={12} /></span> : t.url ? <SiteMark url={t.url} /> : <Icon name="web" size={13} />}
              <span className="t">{tabName(t)}</span>
              <button className="x" title="关闭标签页" aria-label={`关闭 ${tabName(t)}`} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><Icon name="close" size={11} /></button>
            </div>
          ))}
        </div>
      )}
      <AddressBar tab={tab} />
      {tab.agent && <AgentStrip tab={tab} />}
      <div className="bw-body">
        {tabs.map((t) => <TabView key={t.id} tab={t} front={t.id === tab.id} />)}
      </div>
    </div>
  );
}
