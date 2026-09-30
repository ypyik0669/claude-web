import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { authChecker } from '@/features/workbench/auth-check';
import { engineNotice, type NoticeAction } from './model';
import { connectModel, loginInTerminal } from '@/features/providers/ConnectModel';

const ACTION_LABEL: Record<NoticeAction, string> = { login: '用 Claude 账号登录', provider: '接一个模型', runtime: '查看运行内核' };

function act(a: NoticeAction) {
  if (a === 'login') loginInTerminal();
  else if (a === 'provider') void connectModel({ reason: 'start' });
  else useStore.getState().openSettings({ section: 'engine' });
}

/**
 * The start page's login / runtime line (spec §5.8): nothing while all is well. Not logged in to Claude with no
 * provider → 「还没接模型…[接一个模型] [用 Claude 账号登录]」; no runtime found → where to look. Login state is the
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
      {n.actions.map((a, i) => <button key={a} className={i === 0 ? 'btn sm primary' : 'btn sm'} data-act={a} onClick={() => act(a)}>{ACTION_LABEL[a]}</button>)}
      {n.kind === 'login' && <button className="link" disabled={checking} onClick={() => void checker.check(true).catch(() => {})}>{checking ? '检查中…' : '重新检查'}</button>}
    </div>
  );
}
