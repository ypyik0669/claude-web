import { useEffect, useRef, useState } from 'react';
import type { Tile } from '@/model/layout';
import { useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { desktop } from '@/desktop';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';

/**
 * In-app browser.
 *
 * Desktop gets a real `<webview>` (its own session partition, popups denied, navigation stays inside
 * the tag). In a plain browser we can only use an `<iframe>`, and most sites send X-Frame-Options /
 * frame-ancestors — there is no way to detect that from script, so the toolbar always offers
 * "open externally" and a hint appears if nothing paints.
 *
 * The point of having it here rather than alongside the app is the agent loop: whatever the agent
 * just built can be opened, and the page's URL + console errors handed straight back to the composer.
 */
export function BrowserTile({ tile }: { tile: Extract<Tile, { kind: 'browser' }> }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const toast = useStore((s) => s.toast);
  const setDraft = useStore((s) => s.setDraft);
  const ctx = usePaneCtx();
  const ref = useRef<any>(null);
  const [addr, setAddr] = useState(tile.url);
  const [url, setUrl] = useState(tile.url);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, fwd: false });
  const [err, setErr] = useState('');

  // keep the tab title in sync with the page
  useEffect(() => {
    const el = ref.current;
    if (!el || !desktop) return;
    const onStart = () => { setLoading(true); setErr(''); };
    const onStop = () => {
      setLoading(false);
      try {
        setUrl(el.getURL());
        setAddr(el.getURL());
        setNav({ back: el.canGoBack(), fwd: el.canGoForward() });
      } catch { /* not attached yet */ }
    };
    const onTitle = (e: any) => { if (ctx) dispatch({ t: 'tile.rename', paneId: ctx.paneId, tileId: tile.id, title: String(e.title).slice(0, 40) }); };
    const onFail = (e: any) => { setLoading(false); if (e.errorCode !== -3) setErr(`${e.errorDescription || '加载失败'} (${e.errorCode})`); };
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-fail-load', onFail);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-fail-load', onFail);
    };
  }, [ctx?.paneId, tile.id]);

  const normalise = (v: string) => {
    const t = v.trim();
    if (!t) return t;
    if (/^https?:\/\//i.test(t)) return t;
    if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(t) || /^:\d+/.test(t)) return `http://${t.replace(/^:/, 'localhost:')}`;
    if (/^[\w-]+(\.[\w-]+)+(\/|$|:)/.test(t)) return `https://${t}`;
    return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
  };
  const go = (v: string) => {
    const u = normalise(v);
    if (!u) return;
    setUrl(u);
    setAddr(u);
    setErr('');
    if (ctx) dispatch({ t: 'tile.patch', paneId: ctx.paneId, tileId: tile.id, patch: { url: u } });
    if (desktop && ref.current) { try { ref.current.loadURL(u); } catch { /* not attached */ } }
  };
  const act = (fn: 'goBack' | 'goForward' | 'reload') => { try { ref.current?.[fn](); } catch { /* ignore */ } };

  /** Hand the page back to the agent: URL plus whatever the console complained about. */
  const toComposer = async () => {
    const sid = ctx?.sessionId ?? useStore.getState().activeId;
    if (!sid) return toast('先在这里打开一个对话');
    let extra = '';
    if (desktop && ref.current) {
      try {
        const logs: string[] = await ref.current.executeJavaScript('window.__cwErrors || []');
        if (logs?.length) extra = `\n控制台错误：\n${logs.slice(0, 10).map((l) => `- ${l}`).join('\n')}`;
      } catch { /* page may block eval */ }
    }
    const cur = useStore.getState().open[sid]?.draft ?? '';
    setDraft(sid, `${cur}${cur ? '\n' : ''}页面：${url}${extra}\n`);
    toast('已放进输入框', true);
  };

  return (
    <div className="browser-tile">
      <div className="browser-bar">
        <button className="icon-btn xs" disabled={!nav.back} title="后退" aria-label="后退" onClick={() => act('goBack')}><Icon name="restore" size={14} /></button>
        <button className="icon-btn xs" disabled={!nav.fwd} title="前进" aria-label="前进" onClick={() => act('goForward')}><Icon name="minimize" size={14} /></button>
        <button className={clsx('icon-btn xs', loading && 'active')} title="刷新" aria-label="刷新" onClick={() => act('reload')}><Icon name="refresh" size={14} /></button>
        <input
          className="field"
          value={addr}
          spellCheck={false}
          placeholder="输入网址或 localhost:3000"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(addr); if (e.key === 'Escape') setAddr(url); }}
        />
        <button className="icon-btn xs" title="把页面地址和控制台错误放进输入框" aria-label="发给会话" onClick={toComposer}><Icon name="send" size={14} /></button>
        <button className="icon-btn xs" title="在系统浏览器打开" aria-label="外部打开" onClick={() => (desktop ? desktop.openExternal(url) : window.open(url, '_blank', 'noopener,noreferrer'))}><Icon name="external" size={14} /></button>
        {desktop && <button className="icon-btn xs" title="开发者工具" aria-label="开发者工具" onClick={() => { try { ref.current?.openDevTools(); } catch { /* ignore */ } }}><Icon name="bash" size={14} /></button>}
      </div>
      {err && <div className="board-err">{err} · <button className="btn sm ghost" onClick={() => act('reload')}>重试</button></div>}
      <div className="browser-body">
        {desktop ? (
          // No `allowpopups`: the tag reads the attribute's PRESENCE, so `allowpopups="false"` — what
          // React writes for any non-null value — turns popups ON. Leaving it off is the closed state.
          <webview ref={ref} src={tile.url} partition="persist:cw-browser" style={{ width: '100%', height: '100%' }} />
        ) : (
          <>
            <iframe ref={ref} src={url} title="in-app browser" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            <div className="browser-hint">浏览器里只能用受限 iframe：拒绝被嵌入的站点会是空白，用右上角「在系统浏览器打开」。桌面版是完整的内嵌浏览器。</div>
          </>
        )}
      </div>
    </div>
  );
}
