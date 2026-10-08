import { useEffect, useRef, useState } from 'react';
import type { Provider, ProviderType } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { PRESETS, anthropicBase, cleanBase, explainProbe, quickPlan, relayName, uniqueName, type ProbeLike, type QuickFormat, type QuickPlan } from './quick';

/** A model list as the probe returned it: the ids and the display names it gave. */
type Listed = { models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts'] };
interface Probe extends ProbeLike { models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts']; chat?: { ok: boolean; model: string; error?: string; switched?: boolean } }
type Phase = 'idle' | 'list' | 'chat' | 'save';

const FORMATS: { v: QuickFormat; l: string; t: string }[] = [
  { v: 'auto', l: '自动', t: '读到 Claude 模型就用 Claude 格式，否则 OpenAI 格式' },
  { v: 'anthropic', l: 'Claude 格式', t: 'Anthropic Messages 接口（/v1/messages）' },
  { v: 'openai', l: 'OpenAI 格式', t: 'OpenAI Chat Completions 接口（/v1/chat/completions）' },
];

function probe(provider: Partial<Provider>, listOnly: boolean): Promise<Probe> {
  return ws.request<Probe>({ kind: 'providers.probe', provider, listOnly });
}

/**
 * 接一个模型 (quick connect): where the key is from · (a relay's address) · the key · 连接. The endpoint's model list
 * picks the format and the default model (quick.ts), then one short real message proves it works, and the profile is
 * saved — the default for new conversations when `makeDefault`. Used by the first-run wizard, the 「接一个模型」
 * dialog (a send with nothing to send it with, a conversation on a Claude account that is not logged in) and settings.
 */
export function QuickConnect({ onDone, makeDefault, autoFocus = true }: { onDone: (p: Provider) => void; makeDefault: boolean; autoFocus?: boolean }) {
  const [presetId, setPresetId] = useState('relay');
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const relay = preset.type === 'auto';
  const [base, setBase] = useState('');
  const [key, setKey] = useState('');
  const [fmt, setFmt] = useState<QuickFormat>('auto');
  const [phase, setPhase] = useState<Phase>('idle');
  const [plan, setPlan] = useState<QuickPlan | null>(null);
  const [err, setErr] = useState<{ text: string; raw?: string } | null>(null);
  // a failed chat check: the list worked, so 仍然保存 can keep the profile (the model can be changed later)
  const [fallback, setFallback] = useState<{ plan: QuickPlan; list: Listed; runtime?: 'claude' } | null>(null);
  const [started, setStarted] = useState(0);
  const [, tick] = useState(0);
  const busy = phase !== 'idle';
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) setTimeout(() => first.current?.focus({ preventScroll: true }), 0); }, [autoFocus, presetId]);
  useEffect(() => {
    if (phase !== 'chat') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const pick = (id: string) => { if (busy) return; setPresetId(id); setErr(null); setFallback(null); };

  const save = async (p: QuickPlan, { models, modelNames, modelEfforts }: Listed, runtime?: 'claude') => {
    setPhase('save');
    const st = useStore.getState();
    const name = uniqueName(relay ? relayName(base) : preset.name, st.providers.map((x) => x.name));
    const draft: Partial<Provider> = { name, type: p.type as ProviderType, baseUrl: p.baseUrl, apiKey: key.trim(), models, ...(modelNames ? { modelNames } : {}), ...(modelEfforts ? { modelEfforts } : {}), ...(models.length ? { modelsAt: Date.now() } : {}) };
    if (p.defaultModel) draft.defaultModel = p.defaultModel;
    if (p.modelMap) draft.modelMap = p.modelMap;
    if (runtime) draft.runtime = runtime;
    const saved = await ws.request<Provider>({ kind: 'providers.upsert', provider: draft });
    if (makeDefault) await st.setSetting('defaultProviderId', saved.id);
    await st.loadProviders();
    st.toast(`已接好「${saved.name}」${p.defaultModel ? ` · ${p.defaultModel}` : ''}${makeDefault ? '，新对话默认用它' : ''}`, true);
    onDone(saved);
  };

  const connect = async () => {
    if (busy) return;
    setErr(null);
    setFallback(null);
    const k = key.trim();
    const b = relay ? cleanBase(base) : preset.baseUrl ?? '';
    if (relay && !b) { setErr({ text: '先填中转站的地址。' }); return; }
    if (!k) { setErr({ text: '先粘贴 API Key。' }); return; }
    try {
      setPhase('list');
      let used: QuickFormat = fmt;
      const listType: ProviderType = relay ? (fmt === 'anthropic' ? 'anthropic' : 'openai') : (preset.type as ProviderType);
      let list = await probe({ type: listType, baseUrl: listType === 'anthropic' ? anthropicBase(b) : b, apiKey: k }, true);
      // a relay that only speaks Claude format may refuse a Bearer-only model list: ask again the Anthropic way
      if (!list.ok && relay && fmt === 'auto') {
        const again = await probe({ type: 'anthropic', baseUrl: anthropicBase(b), apiKey: k }, true);
        if (again.ok) { list = again; used = 'anthropic'; }
      }
      if (!list.ok || !list.models.length) { setErr({ text: explainProbe(list, 'list'), raw: list.error }); return; }
      const p = quickPlan(preset, used, b, list.models);
      setPlan(p);
      // no chat check for Gemini (the probe has none either): the key already listed the models
      if (p.type !== 'anthropic' && p.type !== 'openai') { await save(p, list); return; }
      setPhase('chat');
      setStarted(Date.now());
      const r = await probe({ type: p.type, baseUrl: p.baseUrl, apiKey: k, defaultModel: p.defaultModel, modelMap: p.modelMap }, false);
      const runtime = r.chat?.switched ? 'claude' as const : undefined;
      if (!r.ok) { setErr({ text: explainProbe(r, 'chat'), raw: r.chat?.error ?? r.error }); setFallback({ plan: p, list, runtime }); return; }
      await save(p, r.models.length ? r : list, runtime);
    } catch (e: any) {
      setErr({ text: e?.message ?? String(e) });
    } finally {
      setPhase('idle');
    }
  };

  const forceSave = async () => {
    if (!fallback || busy) return;
    try { await save(fallback.plan, fallback.list, fallback.runtime); } catch (e: any) { setErr({ text: e?.message ?? String(e) }); } finally { setPhase('idle'); }
  };

  const secs = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
  const status = phase === 'list' ? '正在读取模型列表…'
    : phase === 'chat' ? `正在发一条很短的消息测试 ${plan?.defaultModel ?? ''}${plan?.type === 'anthropic' ? '（Claude 格式要启动一次 Claude Code，约 10–40 秒）' : ''}… ${secs} 秒`
    : phase === 'save' ? '正在保存…' : '';
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) { e.preventDefault(); void connect(); } };

  return (
    <div className="qc" data-preset={preset.id}>
      <div className="qc-presets" role="radiogroup" aria-label="API Key 从哪来">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === preset.id} className={clsx('qc-preset', p.id === preset.id && 'on')} disabled={busy && p.id !== preset.id} onClick={() => pick(p.id)}>{p.name}</button>
        ))}
      </div>
      {relay && (
        <label className="qc-f">
          <span className="qc-l">地址</span>
          <input ref={first} className="field" data-qc="base" value={base} disabled={busy} onChange={(e) => setBase(e.target.value)} onKeyDown={enter} placeholder="中转站给的地址，如 https://api.example.com" spellCheck={false} autoComplete="off" />
        </label>
      )}
      <label className="qc-f">
        <span className="qc-l">API Key</span>
        <input ref={relay ? undefined : first} className="field" data-qc="key" type="password" value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} onKeyDown={enter} placeholder={relay ? '中转站给的 Key（通常以 sk- 开头）' : `在 ${preset.name} 官网创建的 API Key`} spellCheck={false} autoComplete="off" />
      </label>
      {preset.keyUrl && <div className="qc-hint"><a href={preset.keyUrl} target="_blank" rel="noreferrer">去 {preset.name} 官网创建 API Key <Icon name="external" size={11} /></a></div>}
      {relay && (
        <div className="qc-f qc-fmt">
          <span className="qc-l">接口格式</span>
          <div className="sp-seg" role="radiogroup" aria-label="接口格式">
            {FORMATS.map((f) => <button key={f.v} type="button" role="radio" aria-checked={fmt === f.v} className={clsx(fmt === f.v && 'on')} title={f.t} disabled={busy} onClick={() => setFmt(f.v)}>{f.l}</button>)}
          </div>
        </div>
      )}
      {preset.note && <div className="qc-hint sub">{preset.note}</div>}
      <div className="qc-status" role="status" aria-live="polite">
        {busy && <><span className="spin" aria-hidden /> {status}</>}
        {!busy && err && <span className="qc-err" title={err.raw && err.raw !== err.text ? err.raw : undefined}>{err.text}</span>}
      </div>
      <div className="qc-actions">
        <button className="btn primary" data-qc="connect" disabled={busy} onClick={() => void connect()}>{busy ? '连接中…' : '连接'}</button>
        {fallback && !busy && <button className="btn ghost" data-qc="force" onClick={() => void forceSave()} title="模型列表读到了，只是测试消息没通过：先保存，之后在设置 → 供应商 里改模型">仍然保存</button>}
      </div>
    </div>
  );
}
