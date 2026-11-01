import { useEffect, useRef, useState } from 'react';
import type { Provider } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { PRESETS, anthropicBase, cleanBase, explainProbe, quickPlan, relayName, uniqueName, type ProbeLike, type QuickPlan } from './quick';
import { tr } from '@/i18n';

/** A model list as the probe returned it: the ids and the display names it gave. */
type Listed = { models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts']; modelContext?: Provider['modelContext'] };
interface Probe extends ProbeLike { models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts']; modelContext?: Provider['modelContext']; chat?: { ok: boolean; model: string; error?: string } }
type Phase = 'idle' | 'list' | 'chat' | 'save';

function probe(provider: Partial<Provider>, listOnly: boolean): Promise<Probe> {
  return ws.request<Probe>({ kind: 'providers.probe', provider, listOnly });
}

/**
 * 接一个模型 (quick connect): where the key is from · (a relay's address) · the key · 连接. The endpoint's model list
 * picks the default model (quick.ts), then one short real message proves it works, and the profile is
 * saved — the default for new conversations when `makeDefault`. Used by the first-run wizard, the 「接一个模型」
 * dialog (a send with nothing to send it with, a conversation on a Claude account that is not logged in) and settings.
 */
export function QuickConnect({ onDone, makeDefault, autoFocus = true, preset: startPreset }: { onDone: (p: Provider) => void; makeDefault: boolean; autoFocus?: boolean; /** start on this PRESETS id (添加来源 picked it already) */ preset?: string }) {
  const [presetId, setPresetId] = useState(startPreset ?? 'relay');
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const relay = preset.type === 'auto';
  const [base, setBase] = useState('');
  const [key, setKey] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [plan, setPlan] = useState<QuickPlan | null>(null);
  const [err, setErr] = useState<{ text: string; raw?: string } | null>(null);
  // a failed chat check: the list worked, so 仍然保存 can keep the profile (the model can be changed later)
  const [fallback, setFallback] = useState<{ plan: QuickPlan; list: Listed } | null>(null);
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

  const save = async (p: QuickPlan, { models, modelNames, modelEfforts, modelContext }: Listed) => {
    setPhase('save');
    const st = useStore.getState();
    const name = uniqueName(relay ? relayName(base) : preset.name, st.providers.map((x) => x.name));
    const draft: Partial<Provider> = { name, type: p.type, baseUrl: p.baseUrl, apiKey: key.trim(), models, ...(modelNames ? { modelNames } : {}), ...(modelEfforts ? { modelEfforts } : {}), ...(modelContext ? { modelContext } : {}), ...(models.length ? { modelsAt: Date.now() } : {}) };
    if (p.defaultModel) draft.defaultModel = p.defaultModel;
    if (p.modelMap) draft.modelMap = p.modelMap;
    const saved = await ws.request<Provider>({ kind: 'providers.upsert', provider: draft });
    if (makeDefault) await st.setSetting('defaultProviderId', saved.id);
    await st.loadProviders();
    st.toast(tr('已接好「{name}」{v}{v2}', { name: saved.name, v: p.defaultModel ? ` · ${p.defaultModel}` : '', v2: makeDefault ? tr('，新对话默认用它') : '' }), true);
    onDone(saved);
  };

  const connect = async () => {
    if (busy) return;
    setErr(null);
    setFallback(null);
    const k = key.trim();
    const b = relay ? cleanBase(base) : preset.baseUrl ?? '';
    if (relay && !b) { setErr({ text: tr('先填中转站的地址。') }); return; }
    if (!k) { setErr({ text: tr('先粘贴 API Key。') }); return; }
    try {
      setPhase('list');
      const list = await probe({ type: 'anthropic', baseUrl: anthropicBase(b), apiKey: k }, true);
      if (!list.ok || !list.models.length) { setErr({ text: explainProbe(list, 'list'), raw: list.error }); return; }
      const p = quickPlan(preset, b, list.models);
      setPlan(p);
      setPhase('chat');
      setStarted(Date.now());
      const r = await probe({ type: p.type, baseUrl: p.baseUrl, apiKey: k, defaultModel: p.defaultModel, modelMap: p.modelMap }, false);
      if (!r.ok) { setErr({ text: explainProbe(r, 'chat'), raw: r.chat?.error ?? r.error }); setFallback({ plan: p, list }); return; }
      await save(p, r.models.length ? r : list);
    } catch (e: any) {
      setErr({ text: e?.message ?? String(e) });
    } finally {
      setPhase('idle');
    }
  };

  const forceSave = async () => {
    if (!fallback || busy) return;
    try { await save(fallback.plan, fallback.list); } catch (e: any) { setErr({ text: e?.message ?? String(e) }); } finally { setPhase('idle'); }
  };

  const secs = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
  const status = phase === 'list' ? tr('正在读取模型列表…')
    : phase === 'chat' ? tr('正在发一条很短的消息测试 {defaultModel}{v}… {secs} 秒', { defaultModel: plan?.defaultModel ?? '', v: tr('（要启动一次 Claude Code，约 10–40 秒）'), secs })
    : phase === 'save' ? tr('正在保存…') : '';
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) { e.preventDefault(); void connect(); } };

  return (
    <div className="qc" data-preset={preset.id}>
      <div className="qc-presets" role="radiogroup" aria-label={tr('API Key 从哪来')}>
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === preset.id} className={clsx('qc-preset', p.id === preset.id && 'on')} disabled={busy && p.id !== preset.id} onClick={() => pick(p.id)}>{p.name}</button>
        ))}
      </div>
      {relay && (
        <label className="qc-f">
          <span className="qc-l">{tr('地址')}</span>
          <input ref={first} className="field" data-qc="base" value={base} disabled={busy} onChange={(e) => setBase(e.target.value)} onKeyDown={enter} placeholder={tr('中转站给的地址，如 https://api.example.com')} spellCheck={false} autoComplete="off" />
        </label>
      )}
      <label className="qc-f">
        <span className="qc-l">API Key</span>
        <input ref={relay ? undefined : first} className="field" data-qc="key" type="password" value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} onKeyDown={enter} placeholder={relay ? tr('中转站给的 Key（通常以 sk- 开头）') : tr('在 {name} 官网创建的 API Key', { name: preset.name })} spellCheck={false} autoComplete="off" />
      </label>
      {preset.keyUrl && <div className="qc-hint"><a href={preset.keyUrl} target="_blank" rel="noreferrer">{tr('去 {name} 官网创建 API Key', { name: preset.name })} <Icon name="external" size={11} /></a></div>}
      {preset.note && <div className="qc-hint sub">{preset.note}</div>}
      <div className="qc-status" role="status" aria-live="polite">
        {busy && <><span className="spin" aria-hidden /> {status}</>}
        {!busy && err && <span className="qc-err" title={err.raw && err.raw !== err.text ? err.raw : undefined}>{err.text}</span>}
      </div>
      <div className="qc-actions">
        <button className="btn primary" data-qc="connect" disabled={busy} onClick={() => void connect()}>{busy ? tr('连接中…') : tr('连接')}</button>
        {fallback && !busy && <button className="btn ghost" data-qc="force" onClick={() => void forceSave()} title={tr('模型列表读到了，只是测试消息没通过：先保存，之后在设置 → 供应商 里改模型')}>{tr('仍然保存')}</button>}
      </div>
    </div>
  );
}
