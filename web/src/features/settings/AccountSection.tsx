import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Row } from './controls';
import { connectModel, loginInTerminal } from '@/features/providers/ConnectModel';

/** `claude auth status` (the server shares one run for 30 s; 重新检查 forces a fresh one). */
interface AuthStatus { loggedIn?: boolean; authMethod?: string; email?: string; orgName?: string; apiProvider?: string; error?: boolean }

/**
 * Settings → 账号与登录: the login state first (spec §5.7); the runtime details (version, ccb / official binary,
 * doctor) are the page's 更多选项 (`Overview part="engine"`).
 */
export function AccountSection() {
  const providers = useStore((s) => s.providers.length);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const check = (force = false) => {
    setBusy(true);
    useStore.getState().checkAuth(force)
      .then((a) => setAuth((a as AuthStatus | null) ?? { loggedIn: false }))
      .catch(() => setAuth({ loggedIn: false, error: true }))
      .finally(() => setBusy(false));
  };
  useEffect(() => { check(false); }, []);
  const go = (section: string) => useStore.getState().openSettings({ section });
  const who = [auth?.email, auth?.orgName, auth?.authMethod].filter(Boolean).join(' · ');
  return (
    <>
      <div className="sp-blk-h">Claude 账号</div>
      <div className="sp-card">
        <Row
          label="登录状态"
          hint={auth === null ? '检查中…' : auth.loggedIn ? (who || '已登录 claude.ai') : auth.error ? '没检查成功：运行内核没有回答，稍后再点「重新检查」。' : '还没登录。有 Claude Pro / Max 订阅就登录；没有的话用下面的「接一个模型」填 API Key。'}
        >
          {auth && <span className={clsx('sp-state', auth.loggedIn ? 'ok' : 'off')}>{auth.loggedIn ? '已登录' : '未登录'}</span>}
          {auth && !auth.loggedIn && !auth.error && <button className="btn sm ghost" onClick={loginInTerminal}>登录</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => check(true)}>{busy ? '检查中…' : '重新检查'}</button>
        </Row>
        {auth?.apiProvider && <Row label="API 提供方" hint="Claude 账号的请求发往哪里。">{auth.apiProvider}</Row>}
      </div>
      <div className="sp-blk-h">第三方接口</div>
      <div className="sp-card">
        <Row label="供应商" hint={providers ? `已添加 ${providers} 个。每个对话可以在模型菜单里换用。` : '还没有。用中转站、DeepSeek、Kimi 等的 API Key 时，在这里接。'}>
          <button className={clsx('btn sm', !providers && auth?.loggedIn === false && 'primary')} onClick={() => void connectModel({ reason: 'settings' })}>接一个模型</button>
          {providers > 0 && <button className="btn sm ghost" onClick={() => go('providers')}>管理供应商</button>}
        </Row>
      </div>
    </>
  );
}
