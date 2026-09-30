import { create } from 'zustand';
import type { Provider } from '@shared';
import { useStore } from '@/store';
import { imeComposing } from '@/ui/ime';
import { CLAUDE_LOGIN_CMD, LOGIN_IN_TERMINAL } from '@/ui/terms';
import { QuickConnect } from './QuickConnect';

/**
 * Why the 「接一个模型」 dialog is open: `start` (the start page's notice), `send` (a new conversation about to go
 * out on a Claude account that is not logged in — the message goes out once a model is connected), `session` (a
 * conversation on that account failed with 「Not logged in」), `settings` (快速添加 in settings → 供应商).
 */
export type ConnectReason = 'start' | 'send' | 'session' | 'settings';
interface Req { id: number; reason: ConnectReason; makeDefault: boolean; resolve: (p: Provider | null) => void }
export const useConnect = create<{ req: Req | null }>(() => ({ req: null }));
let seq = 0;

/**
 * Open the dialog; resolves with the provider connected (or picked from the ones already added), null when closed.
 * The new one becomes the default for new conversations unless the Claude account is logged in or another usable
 * default is already set (`makeDefault` overrides).
 */
export function connectModel(o: { reason?: ConnectReason; makeDefault?: boolean } = {}): Promise<Provider | null> {
  const st = useStore.getState();
  const def = st.settings.defaultProviderId as string | undefined;
  const makeDefault = o.makeDefault ?? (st.auth?.loggedIn !== true && !(def && st.providers.some((p) => p.id === def)));
  return new Promise((resolve) => {
    useConnect.getState().req?.resolve(null);
    useConnect.setState({ req: { id: ++seq, reason: o.reason ?? 'start', makeDefault, resolve } });
  });
}

/** `claude auth login` in a terminal tab (the Claude subscription route), with what to do there. */
export function loginInTerminal() {
  const st = useStore.getState();
  st.openTile({ id: `t${Date.now()}`, kind: 'term', cwd: '', cmd: CLAUDE_LOGIN_CMD, title: '登录 Claude' }, 'tab');
  st.toast(LOGIN_IN_TERMINAL, true, 12_000);
}

const COPY: Record<ConnectReason, { title: string; text: string }> = {
  start: { title: '接一个模型', text: '有 API Key 就能用：中转站、DeepSeek、Kimi、智谱、通义千问…… 选来源、粘贴 Key，测试通过就好了。' },
  send: { title: '先接一个模型', text: 'Claude 账号还没登录。接一个模型（中转站、DeepSeek、Kimi 等的 API Key）就能开始，接好后这条消息会直接发出去。' },
  session: { title: '换一个模型继续', text: '这个对话用的是 Claude 账号，但它还没登录。接一个模型，这个对话就换过去并重试刚才那条消息。' },
  settings: { title: '快速添加供应商', text: '选来源、粘贴 Key：模型列表和接口格式自动读取，测试通过后保存。更多选项在「添加」里。' },
};

export function ConnectModelHost() {
  const req = useConnect((s) => s.req);
  const providers = useStore((s) => s.providers);
  if (!req) return null;
  const close = (p: Provider | null) => {
    req.resolve(p);
    useConnect.setState((s) => (s.req?.id === req.id ? { req: null } : s));
  };
  const c = COPY[req.reason];
  // already added ones are one click away (a send / a conversation that just needs one); not in settings — that
  // list is right behind the dialog
  const existing = req.reason === 'settings' ? [] : providers;
  return (
    <div key={req.id} className="modal-bg dialog-bg connect-bg" onMouseDown={(e) => e.target === e.currentTarget && close(null)} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); close(null); } }}>
      <div className="modal connect-model" role="dialog" aria-modal="true" aria-label={c.title} data-reason={req.reason}>
        <h3>{c.title}</h3>
        <p className="sub">{c.text}</p>
        {existing.length > 0 && (
          <div className="qc-existing">
            <span className="qc-l">用已添加的</span>
            {existing.map((p) => <button key={p.id} type="button" className="btn sm" data-qc="existing" onClick={() => close(p)}>{p.name}</button>)}
          </div>
        )}
        <QuickConnect makeDefault={req.makeDefault} onDone={close} />
        <div className="qc-foot">
          {req.reason !== 'settings' && <button type="button" className="link" data-qc="login" onClick={() => { close(null); loginInTerminal(); }}>有 Claude Pro / Max 订阅？用 Claude 账号登录</button>}
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={() => close(null)}>取消</button>
        </div>
      </div>
    </div>
  );
}
