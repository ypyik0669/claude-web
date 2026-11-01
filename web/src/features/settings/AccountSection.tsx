import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Row } from './controls';
import { connectModel, loginInTerminal } from '@/features/providers/ConnectModel';
import { tr } from '@/i18n';
import { ClaudeAccounts } from './ClaudeAccounts';
import { familyWindows } from '@account-window';
import { AccountWindowsDialog } from './AccountWindows';
import { accountSummary, savedWindows } from './compact-model';

/** `claude auth status` (the server shares one run for 30 s; 重新检查 forces a fresh one). */
interface AuthStatus { loggedIn?: boolean; authMethod?: string; email?: string; orgName?: string; apiProvider?: string; error?: boolean }

/**
 * Settings → 账号与登录: the login state first (spec §5.7); the runtime details (version, where the binary is from,
 * doctor) are the page's 更多选项 (`Overview part="engine"`).
 */
export function AccountSection() {
  const providers = useStore((s) => s.providers.filter((p) => p.type !== 'claude-account').length);
  // A7: the own login's 200K / 1M picks and 自动压缩 point (meta settings; the server applies them to the conversations)
  const rawWindows = useStore((s) => s.settings['claude.contextWindows']);
  const rawCompact = useStore((s) => s.settings['claude.compactAt']);
  const windowsHint = accountSummary(familyWindows(rawWindows), typeof rawCompact === 'number' ? rawCompact : undefined);
  const [editing, setEditing] = useState(false);
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
      <div className="sp-blk-h">{tr('Claude 账号')}</div>
      <div className="sp-card">
        <Row
          label={tr('登录状态')}
          hint={auth === null ? tr('检查中…') : auth.loggedIn ? (who || tr('已登录 claude.ai')) : auth.error ? tr('没检查成功：运行内核没有回答，稍后再点「重新检查」。') : tr('还没登录。有 Claude Pro / Max 订阅就登录；没有的话用下面的「接一个模型」填 API Key。')}
        >
          {auth && <span className={clsx('sp-state', auth.loggedIn ? 'ok' : 'off')}>{auth.loggedIn ? tr('已登录') : tr('未登录')}</span>}
          {auth && !auth.loggedIn && !auth.error && <button className="btn sm ghost" onClick={loginInTerminal}>{tr('登录')}</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => check(true)}>{busy ? tr('检查中…') : tr('重新检查')}</button>
        </Row>
        {auth?.apiProvider && <Row label={tr('API 提供方')} hint={tr('Claude 账号的请求发往哪里。')}>{auth.apiProvider}</Row>}
        <Row label={tr('上下文窗口')} hint={windowsHint}>
          <button className="btn sm ghost" data-act="account-windows-edit" onClick={() => setEditing(true)}>{tr('编辑')}</button>
        </Row>
      </div>
      {editing && (
        <AccountWindowsDialog windows={familyWindows(rawWindows)} compactAt={typeof rawCompact === 'number' ? rawCompact : undefined} onClose={() => setEditing(false)}
          onSave={async (p) => {
            const set = useStore.getState().setSetting;
            await set('claude.contextWindows', savedWindows(p.windows));
            await set('claude.compactAt', p.compactAt);
          }} />
      )}
      <ClaudeAccounts />
      <div className="sp-blk-h">{tr('第三方接口')}</div>
      <div className="sp-card">
        <Row label={tr('供应商')} hint={providers ? tr('已添加 {providers} 个。每个对话可以在模型菜单里换用。', { providers }) : tr('还没有。用中转站、DeepSeek、Kimi 等的 API Key 时，在这里接。')}>
          <button className={clsx('btn sm', !providers && auth?.loggedIn === false && 'primary')} onClick={() => void connectModel({ reason: 'settings' })}>{tr('接一个模型')}</button>
          {providers > 0 && <button className="btn sm ghost" onClick={() => go('providers')}>{tr('管理供应商')}</button>}
        </Row>
      </div>
    </>
  );
}
