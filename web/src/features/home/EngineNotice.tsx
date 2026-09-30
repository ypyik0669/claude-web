import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { authChecker } from '@/features/workbench/auth-check';
import { engineNotice, type NoticeAction } from './model';
import { CLAUDE_LOGIN_CMD, LOGIN_IN_TERMINAL } from '@/ui/terms';

const ACTION_LABEL: Record<NoticeAction, string> = { login: '在终端登录', provider: '添加供应商', runtime: '查看运行内核' };

function act(a: NoticeAction) {
  const st = useStore.getState();
  if (a === 'login') {
    st.openTile({ id: `t${Date.now()}`, kind: 'term', cwd: '', cmd: CLAUDE_LOGIN_CMD, title: '登录 Claude' }, 'tab');
    st.toast(LOGIN_IN_TERMINAL, true, 12_000);
  } else if (a === 'provider') st.openSettings({ section: 'providers' });
  else st.openSettings({ section: 'engine' });
}

/**
 * The start page's login / runtime line (spec §5.8): nothing while all is well. Not logged in to Claude with no
 * provider → 「还没登录 Claude。[在终端登录] [添加供应商]」; no runtime found → where to look. Login state is the
 * store's (`checkAuth`): asked on mount, and again when the window comes back while it still says 「未登录」 with
 * no provider (someone just ran /login in a terminal).
 */
export function EngineNotice() {
  const engine = useStore((s) => s.engine);
  const auth = useStore((s) => s.auth);
  const providers = useStore((s) => s.providers.length);
  const connected = useStore((s) => s.connected);
  const [missing, setMissing] = useState(false);
  const [checking, setChecking] = useState(false);
  const checker = useMemo(() => authChecker({
    request: (force) => { setChecking(true); return useStore.getState().checkAuth(force).finally(() => setChecking(false)); },
    onResult: () => {},
    recheckOnFocus: (last) => (last as { loggedIn?: boolean } | null)?.loggedIn === false && useStore.getState().providers.length === 0,
    focusGapMs: 30_000,
  }), []);
  useEffect(() => {
    void checker.check().catch(() => {});
    const onFocus = () => { if (document.visibilityState === 'visible') void checker.onFocus().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [checker]);
  // no runtime: the store's own request failed and says nothing; ask once more and keep the answer
  useEffect(() => {
    if (engine || !connected) return;
    const t = setTimeout(() => { useStore.getState().loadEngine().then(() => setMissing(false), () => setMissing(true)); }, 2500);
    return () => clearTimeout(t);
  }, [engine, connected]);
  const n = engineNotice({ auth, providers, engine: engine ? 'ok' : missing ? 'missing' : 'unknown' });
  if (!n) return null;
  return (
    <div className="home-notice" role="status" data-kind={n.kind}>
      <Icon name="alert" size={14} />
      <span className="t">{n.text}</span>
      {n.actions.map((a) => <button key={a} className="btn sm" onClick={() => act(a)}>{ACTION_LABEL[a]}</button>)}
      {n.kind === 'login' && <button className="link" disabled={checking} onClick={() => void checker.check(true).catch(() => {})}>{checking ? '检查中…' : '重新检查'}</button>}
    </div>
  );
}
