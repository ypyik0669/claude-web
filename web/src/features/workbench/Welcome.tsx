import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { ago } from '@/util';
import { Composer } from '@/features/composer/Composer';
import { Icon } from '@/ui/icons';
import { authChecker } from './auth-check';
import { SidebarReveal, usePaneEdge } from './pane-edge';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}

/** Startup check strip: the runtime that was detected, login state, and how many provider profiles exist. */
function EngineStatus() {
  const engine = useStore((s) => s.engine);
  const providers = useStore((s) => s.providers);
  const togglePanel = useStore((s) => s.togglePanel);
  const [auth, setAuth] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  // mount: the server's shared answer; 重新检查: a fresh one; coming back to the window (after a /login
  // elsewhere): a fresh one only while it says "not logged in" and there is no provider profile to use instead
  const checker = useMemo(() => authChecker({
    request: (force) => { setChecking(true); return ws.request<any>({ kind: 'config.auth', force }).finally(() => setChecking(false)); },
    onResult: setAuth,
    recheckOnFocus: (last) => (last as { loggedIn?: boolean } | null)?.loggedIn === false && useStore.getState().providers.length === 0,
    focusGapMs: 30_000,
  }), []);
  useEffect(() => {
    void checker.check();
    const onFocus = () => { if (document.visibilityState === 'visible') void checker.onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [checker]);
  if (!engine) return null;
  const needs = auth !== null && !auth.loggedIn && providers.length === 0;
  return (
    <div className="engine-status" onClick={() => togglePanel('config')} title="打开配置中心">
      <span className="dot idle" />
      <span>Claude Web 引擎 v{engine.version ?? '?'}{engine.runtime === 'claude' ? '（官方 Claude Code）' : ''}</span>
      <span className="sep">·</span>
      {auth === null ? <span>检查登录…</span> : auth.loggedIn ? <span>已登录 {auth.email ?? auth.authMethod ?? ''}</span> : <span style={{ color: providers.length ? undefined : 'var(--yellow)' }}>未登录 claude.ai</span>}
      {auth !== null && !auth.loggedIn && (
        <button type="button" className="link" disabled={checking} onClick={(e) => { e.stopPropagation(); void checker.check(true); }}>{checking ? '检查中…' : '重新检查'}</button>
      )}
      {providers.length > 0 && <><span className="sep">·</span><span>{providers.length} 个供应商</span></>}
      {needs && <span className="badge err" style={{ marginLeft: 6 }}>去终端 /login 或添加供应商</span>}
    </div>
  );
}

/** Empty chat tile: greeting + welcome composer (creates a session into THIS tile) + recent sessions. */
export function Welcome({ paneId, tileId }: { paneId: string; tileId: string }) {
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const loadHistory = useStore((s) => s.loadHistory);
  const dispatch = useStore((s) => s.dispatchLayout);
  const recent = useMemo(() => sessions.slice(0, 6), [sessions]);
  const edge = usePaneEdge();
  const mobile = useStore((s) => s.mobile);
  const pick = (sid: string) => {
    if (open[sid]) dispatch({ t: 'session.assign', paneId, tileId, sessionId: sid });
    else { dispatch({ t: 'session.assign', paneId, tileId, sessionId: sid }); void loadHistory(sid, { focus: false }); }
  };
  return (
    <div className="welcome-tile">
      {/* the empty page's top row: nothing but the sidebar reveal; on the desktop it is also the title bar (drag) */}
      <div className="welcome-top">{((edge.lead && !edge.strip) || mobile) && <SidebarReveal />}</div>
      <div className="welcome">
        <h1 className="greet"><span className="spark"><Icon name="claude" size={26} /></span>{greeting()}</h1>
        <Composer welcome target={{ paneId, tileId }} />
        <EngineStatus />
        {recent.length > 0 && (
          <div className="recent">
            <h5>最近</h5>
            {recent.map((s) => (
              <div key={s.sessionId} className="sess" onClick={() => pick(s.sessionId)}>
                <span className="t">{s.title}</span>
                <span className="ago">{s.peer ? `${s.peer.name} · ` : ''}{s.cwd.split(/[\\/]/).pop()} · {ago(s.lastModified)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
