import { useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import type { CatalogNote, CatalogSummary, ChannelStatus, Provider, SourceSummary } from '@shared';
import { useGateway } from './state';
import { tr } from '@/i18n';

/** A catalog note in words (what the vendor says about using it). */
export const NOTE_TEXT: Record<CatalogNote, string> = {
  'real-name': tr('注册要实名认证'),
  'one-concurrent': tr('同一时间只能跑一个请求'),
  'parallel-tools-off': tr('不支持一次调用多个工具'),
  'list-any-key': tr('模型列表不验证 Key，填错了要到对话时才知道'),
  logged: tr('请求会被记录'),
  region: tr('部分地区用不了'),
  'paid-credit-raises-limit': tr('充一点钱能提高免费额度'),
  'non-commercial': tr('只能非商业使用'),
};

/** The key field of an entry whose credential is not an API key, in the interface's language (the catalog's own
 *  keyLabel / keyHint are the fallback, for remote / plugin entries). */
const KEY_FIELD: Record<string, () => { label: string; hint: string }> = {
  'grok-web': () => ({
    label: tr('sso cookie'),
    hint: tr('在浏览器打开 grok.com 并登录 → F12 → Application（应用）→ Cookies → 复制 sso 的值。也可以粘贴整段 Cookie；被 Cloudflare 拦时，在末尾加上 ; ua=<浏览器的 User-Agent>。'),
  }),
};

/** The tags a catalog entry / source carries: free, may train on prompts, from a plugin. */
export function SourceTags({ free, mayTrain, plugin }: { free?: boolean | 'some'; mayTrain?: boolean; plugin?: boolean }) {
  return (
    <>
      {free === true && <span className="gw-tag free">{tr('免费')}</span>}
      {free === 'some' && <span className="gw-tag free">{tr('部分免费')}</span>}
      {mayTrain && <span className="gw-tag warn" title={tr('提供方说可能会用对话内容训练模型；别发敏感内容')}>{tr('可能用于训练')}</span>}
      {plugin && <span className="gw-tag">{tr('插件')}</span>}
    </>
  );
}

/** The friendly form for a catalog entry added with a key (or none): what it is, its limits, one field, 添加. */
export function CatalogForm({ entry, onDone }: { entry: CatalogSummary; onDone(name: string, p: Provider | null): void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsKey = entry.needs === 'key';
  const field = KEY_FIELD[entry.id]?.() ?? { label: entry.keyLabel ?? tr('Key'), hint: entry.keyHint ?? '' };

  const add = async () => {
    if (needsKey && !key.trim()) { setError(tr('先填 Key。')); return; }
    setBusy(true);
    setError('');
    try {
      const r = await ws.request<{ source: SourceSummary | null; status: ChannelStatus }>({ kind: 'channels.add', catalogId: entry.id, ...(needsKey ? { key: key.trim() } : {}) });
      useGateway.setState({ sources: r.status.sources, sourceWarnings: r.status.warnings, catalog: r.status.available ?? useGateway.getState().catalog });
      await useStore.getState().loadProviders().catch(() => {});
      const pid = r.source?.providerId;
      onDone(r.source?.name ?? entry.name, pid ? useStore.getState().providers.find((p) => p.id === pid) ?? null : null);
    } catch (e: any) {
      setError(e?.message || tr('没加上，再试一次。'));
    } finally { setBusy(false); }
  };

  return (
    <div className="gw-embedded-add" data-catalog={entry.id}>
      <div className="gateway-row"><SourceTags free={entry.free} mayTrain={entry.mayTrain} plugin={!!entry.plugin} /></div>
      {entry.limits && <div className="gw-kv"><span className="muted">{tr('额度')}</span><span>{entry.limits}</span></div>}
      {entry.models?.length ? <div className="gw-kv"><span className="muted">{tr('模型')}</span><span>{entry.models.slice(0, 6).map((m) => m.id).join('、')}{entry.models.length > 6 ? ' …' : ''}</span></div> : null}
      {entry.plugin && <div className="sub">{tr('这个来源来自插件「{id}」。', { id: entry.plugin.id })}</div>}
      {entry.notes?.map((n) => <div key={n} className="sub">· {NOTE_TEXT[n] ?? n}</div>)}
      {entry.mayTrain && <div className="gw-warn"><Icon name="alert" size={13} /><span>{tr('提供方说可能会用对话内容训练模型；别发敏感内容。')}</span></div>}
      {needsKey && (
        <label className="field">
          <span>{field.label}</span>
          <input
            type="password"
            autoComplete="off"
            value={key}
            autoFocus
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) void add(); }}
          />
        </label>
      )}
      {needsKey && field.hint && <div className="sub">{field.hint}</div>}
      {needsKey && entry.signupUrl && !field.hint && (
        <a className="link" href={entry.signupUrl} target="_blank" rel="noreferrer">{tr('还没有 Key？去申请')}</a>
      )}
      {!needsKey && <div className="sub">{tr('不用 Key，点添加就能用。')}</div>}
      {error && <div className="gw-warn" role="alert"><Icon name="alert" size={13} /><span>{error}</span></div>}
      <div className="gateway-row">
        <span className="grow" />
        <button className="btn" disabled={busy} onClick={() => void add()}>{busy ? tr('正在添加…') : tr('添加')}</button>
      </div>
    </div>
  );
}
