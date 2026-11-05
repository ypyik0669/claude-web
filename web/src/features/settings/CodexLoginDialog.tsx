import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { CodexAccount, CodexLoginView } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { openExternal } from '@/features/chat/link-route';
import { tr } from '@/i18n';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { useEscClose } from '@/features/gateway/use-esc-close';

/** Opened from anywhere (the model menu's Codex section, settings → Agents); App mounts the host once. */
const useOpen = create<{ open: boolean }>(() => ({ open: false }));
export const openCodexLogin = () => useOpen.setState({ open: true });
export function CodexLoginHost() {
  const open = useOpen((s) => s.open);
  return open ? <CodexLoginDialog onClose={() => useOpen.setState({ open: false })} /> : null;
}

const PLAN: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
const planName = (p?: string) => (p ? PLAN[p] ?? p : '');

/**
 * Codex's own ChatGPT sign-in, from the page (agents/codex-login.ts on the server): the browser opens OpenAI's page,
 * Codex catches the answer on its own loopback port and keeps the tokens in ~/.codex — as `codex login` would, without
 * a terminal. 「用设备码」 is for a browser that is not on this computer.
 */
export function CodexLoginDialog({ onClose }: { onClose(): void }) {
  const toast = useStore((s) => s.toast);
  const loadAgents = useStore((s) => s.loadAgents);
  const [account, setAccount] = useState<CodexAccount | null>(null);
  const [view, setView] = useState<CodexLoginView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);
  const viewRef = useRef<CodexLoginView | null>(null);
  viewRef.current = view;

  const stop = () => { if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null; } };
  const cancel = () => { const v = viewRef.current; if (v?.state === 'pending') void ws.request({ kind: 'agents.codex.login.cancel', id: v.id }).catch(() => {}); };
  const close = () => { stop(); cancel(); onClose(); };
  const escRef = useEscClose<HTMLDivElement>(close, false);

  const readAccount = () => ws.request<CodexAccount>({ kind: 'agents.codex.account' }).then(setAccount).catch((e: any) => setError(e.message));
  useEffect(() => { void readAccount(); return () => { stop(); cancel(); }; }, []);

  const watch = (v: CodexLoginView) => {
    stop();
    timer.current = window.setInterval(async () => {
      try {
        const next = await ws.request<CodexLoginView>({ kind: 'agents.codex.login.status', id: v.id });
        setView(next);
        if (next.state === 'pending') return;
        stop();
        if (next.state === 'done') {
          if (next.account) setAccount(next.account);
          toast(tr('Codex 已登录，模型列表正在更新'), true);
          void loadAgents(false).catch(() => {});
        } else if (next.state === 'failed') setError(next.error ?? tr('登录没有完成'));
      } catch (e: any) { stop(); setError(e.message); }
    }, 1500);
  };

  const begin = async (device: boolean) => {
    setBusy(true);
    setError('');
    try {
      const v = await ws.request<CodexLoginView>({ kind: 'agents.codex.login.begin', device });
      setView(v);
      if (v.authUrl) openExternal(v.authUrl);
      watch(v);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const logout = async () => {
    if (!(await dlg.confirm(tr('退出 Codex 账号？'), { message: tr('退出后 Codex 的对话要重新登录才能用。'), okLabel: tr('退出登录'), danger: true }))) return;
    setBusy(true);
    try { setAccount(await ws.request<CodexAccount>({ kind: 'agents.codex.logout' })); void loadAgents(false).catch(() => {}); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const who = account?.signedIn ? (account.apiKey ? tr('用 API Key 登录') : [account.email, planName(account.plan)].filter(Boolean).join(' · ') || tr('已登录')) : '';
  const pending = view?.state === 'pending';

  return (
    <div ref={escRef} className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal codex-login" style={{ width: 520 }} role="dialog" aria-label={tr('登录 Codex 账号')}>
        <h3>{tr('登录 Codex 账号')}</h3>
        <div className="sub">{tr('用 ChatGPT 账号登录 Codex，订阅里有的模型都会出现在模型菜单里。登录信息由 Codex 自己保存，跟终端里 codex login 一样。')}</div>

        <div className="gateway-card" role="status" data-id="codex-account">
          <div className="gw-kv"><span className="muted">{tr('当前账号')}</span><span>{account === null ? tr('正在读取…') : who || tr('还没登录')}</span></div>
          {pending && view?.userCode && (
            <div className="gateway-row">
              <code style={{ fontSize: 20, letterSpacing: 3 }}>{view.userCode}</code>
              <button className="link" onClick={() => openExternal(view.verificationUrl!)}>{tr('打开登录页面')}</button>
            </div>
          )}
          {pending && view?.userCode && <div className="sub">{tr('在打开的页面登录后输入上面的代码。')}</div>}
          {pending && view?.authUrl && (
            <div className="sub">
              {tr('已在浏览器打开 ChatGPT 登录页，登录后这里会自动更新。')}{' '}
              <button className="link" onClick={() => openExternal(view.authUrl!)}>{tr('没打开？点这里')}</button>
            </div>
          )}
          {view?.state === 'done' && <div className="ok"><Icon name="checkCircle" size={14} /> {tr('登录成功')}</div>}
        </div>

        {error && <div className="sub warn" role="status">{error}</div>}

        <div className="actions">
          {account?.signedIn && !pending && <button className="btn ghost danger" disabled={busy} onClick={() => void logout()}>{tr('退出登录')}</button>}
          <span className="grow" />
          {pending
            ? <button className="btn ghost" onClick={() => { cancel(); stop(); setView(null); }}>{tr('取消登录')}</button>
            : <>
                <button className="btn ghost" disabled={busy} data-id="codex-login-device" onClick={() => void begin(true)} title={tr('浏览器不在这台电脑上时用')}>{tr('用设备码')}</button>
                <button className="btn primary" disabled={busy} data-id="codex-login" onClick={() => void begin(false)}>{account?.signedIn ? tr('换个账号') : tr('用 ChatGPT 登录')}</button>
              </>}
          <button className="btn ghost" onClick={close}>{view?.state === 'done' ? tr('完成') : tr('关闭')}</button>
        </div>
      </div>
    </div>
  );
}
