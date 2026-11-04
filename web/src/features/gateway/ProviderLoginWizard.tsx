import { useEffect, useMemo, useRef, useState } from 'react';
import type { EngineLoginProvider, LoginSessionView, ProviderLoginInfo } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { openExternal } from '@/features/chat/link-route';
import { tr } from '@/i18n';
import { Icon } from '@/ui/icons';
import { useEscClose } from './use-esc-close';
import { EngineLoginDialog } from './EngineLoginDialog';

const AUTH_TEXT: Record<string, string> = {
  'oauth-loopback': tr('浏览器登录'),
  'device-code': tr('设备码'),
  'paste-token': tr('粘贴令牌'),
  'local-credential': tr('本机登录态'),
};

/**
 * 第三方登录: the generic sign-in window for provider descriptors (Codex, Copilot, OpenCode …). It is deliberately
 * dumb about vendors — the server's registry says which modes exist and whether a provider is available; an
 * unavailable one is shown with its reason, never with a button that would fake a success.
 */
export function ProviderLoginWizard({ providerId, providerName, onClose, embedded, onAdded }: {
  providerId?: string;
  providerName?: string;
  onClose(): void;
  embedded?: boolean;
  onAdded?(): void;
}) {
  const toast = useStore((s) => s.toast);
  const [infos, setInfos] = useState<ProviderLoginInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(providerId ?? null);
  const [session, setSession] = useState<LoginSessionView | null>(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [engineProviders, setEngineProviders] = useState<EngineLoginProvider[]>([]);
  const timer = useRef<number | null>(null);
  const sessionRef = useRef<LoginSessionView | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    ws.request<ProviderLoginInfo[]>({ kind: 'upstreams.login.providers' }).then(setInfos).catch((e) => setError(e.message));
    ws.request<{ providers: EngineLoginProvider[] }>({ kind: 'engines.login.providers' })
      .then((r) => setEngineProviders(r.providers))
      .catch(() => { /* an older server has no engine sign-in */ });
  }, []);

  const stopPolling = () => {
    if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null; }
  };
  const cancelSession = () => {
    const s = sessionRef.current;
    if (s && s.state === 'pending') void ws.request({ kind: 'upstreams.login.cancel', loginId: s.id }).catch(() => {});
  };
  useEffect(() => () => { stopPolling(); cancelSession(); }, []);

  const close = () => { stopPolling(); cancelSession(); onClose(); };
  const escRef = useEscClose<HTMLDivElement>(() => { if (!busy) close(); }, !!embedded);

  const info = useMemo(() => infos.find((x) => x.id === selected), [infos, selected]);
  const engineMatches = useMemo(() => selected ? engineProviders.filter((x) => x.catalogId === selected) : [], [engineProviders, selected]);

  const watch = (id: string) => {
    stopPolling();
    timer.current = window.setInterval(async () => {
      try {
        const s = await ws.request<LoginSessionView>({ kind: 'upstreams.login.status', loginId: id });
        setSession(s);
        if (s.state === 'pending') return;
        stopPolling();
        setBusy(false);
        if (s.state === 'done') {
          toast(tr('登录成功，账号已添加'), true);
          onAdded?.();
        }
      } catch (e: any) {
        stopPolling();
        setBusy(false);
        setError(e.message);
      }
    }, 1500);
  };

  const begin = async (mode: 'oauth' | 'device' | 'paste' | 'local') => {
    if (!selected) return;
    setBusy(true);
    setError('');
    setSession(null);
    try {
      const s = await ws.request<LoginSessionView>({
        kind: 'upstreams.login.begin',
        providerId: selected,
        mode,
        ...(mode === 'paste' ? { credential: text, name: name.trim() || undefined } : {}),
      });
      setSession(s);
      if (s.state === 'pending') {
        // OAuth opens the system browser; a device code shows a URL + code and waits for the user
        if ((mode === 'oauth' || mode === 'device') && s.url) openExternal(s.url);
        watch(s.id);
      } else {
        setBusy(false);
        if (s.state === 'done') {
          toast(tr('登录成功，账号已添加'), true);
          onAdded?.();
        }
      }
    } catch (e: any) {
      setBusy(false);
      setError(e.message);
    }
  };

  const body = (
    <>
      {!embedded && <h3>{providerName ?? info?.name ?? tr('第三方登录')}</h3>}
      {!selected && (
        <div className="gw-catalog" role="list">
          {infos.map((x) => {
            const via = engineProviders.filter((p) => p.catalogId === x.id);
            return (
              <button key={x.id} className="gw-catalog-row" data-id={x.id} onClick={() => { setSelected(x.id); setSession(null); setError(''); }}>
                <span className="gw-logo sm">{x.name.slice(0, 1).toUpperCase()}</span>
                <span className="gw-source-who">
                  <b>{x.name}</b>
                  <span className="sub">{x.available ? x.instructions : via.length ? tr('通过本地网关登录') : x.reason}</span>
                </span>
                <span className="gw-tag">{AUTH_TEXT[x.auth]}</span>
                {!x.available && !via.length && <span className="gw-tag">{tr('不可用')}</span>}
                {!x.available && via.length > 0 && <span className="gw-tag green">{tr('本地网关')}</span>}
              </button>
            );
          })}
          {!infos.length && !error && <div className="sub">{tr('正在读取登录方式…')}</div>}
        </div>
      )}

      {selected && !session?.accounts?.length && (
        <>
          <div className="sub">{info?.instructions ?? ''}</div>
          {info && !info.available && !engineMatches.length && (
            <div className="gateway-card" role="status">
              <div className="warn">{info.reason ?? tr('这个来源还不能从 claude-web 登录')}</div>
              {info.docsUrl && <button className="link" onClick={() => openExternal(info.docsUrl!)}>{tr('打开文档')}</button>}
            </div>
          )}
          {!!engineMatches.length && (!info || !info.available) && (
            <div className="gateway-card">
              <div className="sub">{tr('这个来源可以通过本地网关登录，账号和不公开的 OAuth 流程由网关处理。')}</div>
              <EngineLoginDialog
                embedded
                providerId={selected!}
                onClose={close}
                onDone={() => onAdded?.()}
              />
            </div>
          )}
          {info?.available && (
            <>
              {info.modes.includes('oauth') && (
                <div className="gateway-card">
                  <div className="sub">{tr('会打开你电脑上的浏览器完成授权，完成后自动回来。')}</div>
                  <button className="btn" disabled={busy} onClick={() => void begin('oauth')}>{busy ? tr('等待浏览器授权…') : tr('在浏览器里登录')}</button>
                </div>
              )}
              {info.modes.includes('device') && (
                <div className="gateway-card">
                  <div className="sub">{tr('点下面的按钮拿到一次性代码，在打开的页面里输入。')}</div>
                  <button className="btn" disabled={busy} onClick={() => void begin('device')}>{busy ? tr('等待输入代码…') : tr('获取设备码')}</button>
                  {session?.userCode && (
                    <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                      <code style={{ fontSize: 18, letterSpacing: 2 }}>{session.userCode}</code>
                      {session.url && <button className="link" onClick={() => openExternal(session.url!)}>{tr('打开登录页面')}</button>}
                    </div>
                  )}
                </div>
              )}
              {info.modes.includes('paste') && (
                <div className="gateway-card">
                  <label className="field"><span>{tr('名称')}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('可留空')} /></label>
                  <label className="field"><span>{tr('凭据')}</span><textarea className="field" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={info.pastePlaceholder ?? tr('粘贴凭据')} /></label>
                  <button className="btn" disabled={busy || !text.trim()} onClick={() => void begin('paste')}>{busy ? tr('添加中…') : tr('添加')}</button>
                </div>
              )}
              {info.modes.includes('local') && (
                <div className="gateway-card">
                  <div className="sub">{tr('只读取本机那个工具已经保存的登录态，不会修改它。')}</div>
                  <button className="btn" disabled={busy} onClick={() => void begin('local')}>{busy ? tr('读取中…') : tr('读取本机登录态')}</button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {session?.state === 'pending' && !session?.userCode && (
        <div className="sub" role="status">
          {tr('正在等待登录完成…')}
          {session.url && <> <button className="link" onClick={() => openExternal(session.url!)}>{tr('打开登录页面')}</button></>}
        </div>
      )}
      {(session?.state === 'error' || session?.state === 'unavailable') && session.message && (
        <div className="sub warn" role="status">{session.message}</div>
      )}
      {!!session?.accounts?.length && (
        <div className="gateway-card" role="status">
          <div className="ok"><Icon name="checkCircle" size={14} /> {tr('已添加 {n} 个账号', { n: session.accounts.length })}</div>
          {session.accounts.map((a) => (
            <div key={a.id} className="gateway-row">
              <span className="grow">{a.name}</span>
              <span className="sub">{a.identity?.email ?? a.credentialKind}</span>
            </div>
          ))}
        </div>
      )}
      {error && <div className="sub warn" role="status">{error}</div>}

      <div className="actions">
        {!selected && <button className="btn ghost" onClick={close}>{tr('关闭')}</button>}
        {selected && !embedded && <button className="btn ghost" onClick={() => { setSelected(null); setSession(null); setError(''); }} disabled={busy}>{tr('返回')}</button>}
        {selected && <button className="btn ghost" onClick={close} disabled={busy}>{session?.accounts?.length ? tr('完成') : tr('取消')}</button>}
      </div>
    </>
  );

  if (embedded) return <div className="gw-embedded-add">{body}</div>;
  return (
    <div ref={escRef} className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal" style={{ width: 560 }} role="dialog" aria-label={tr('第三方登录')}>{body}</div>
    </div>
  );
}
