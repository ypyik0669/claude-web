// 值班 Bot: the create flow — three entries (one sentence → a generated draft, a template, the current conversation),
// then every field of the draft on one screen, then 保存并先跑一次 (create and start the first routine at once) or 保存.
// (A true shadow run — nothing reaches the outside — is phase 2.)
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BotDraft, BotGenerated, BotOutput, BotTemplate, BotTier, ImGatewayInfo, Routine } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { imeComposing } from '@/ui/ime';
import { trapTab } from '@/ui/focus-trap';
import { pickFolder } from '@/ui/pick-folder';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { tr } from '@/i18n';
import { draftFromTemplate, draftProblem, fasterThanHourly, lastUserText, MIN_EVERY_MINUTES, monthlyEstimate, normalizeDraft, PER_RUN_USD, underMinimum, usd } from './model';
import { BlurField, NumField, splitList } from './fields';
import { createBot, generate, selectBot, setBotTab, startCreate, startRun, useBots } from './state';

type Draft = BotDraft['bot'];
type ImOut = Extract<BotOutput, { kind: 'im' }>;
type FileOut = Extract<BotOutput, { kind: 'file' }>;
/** a draft arrived: `generated` ones get the 15-minute clamp; a template's risk shows on the preview */
type OnDraft = (d: BotGenerated, risk?: string) => void;

/** The active conversation's folder (the default 工作目录). */
const useActiveCwd = () => useStore((s) => (s.activeId ? s.open[s.activeId]?.cwd ?? '' : ''));
/** The active conversation's latest prompt ('' when there is none). */
const activePrompt = (s: ReturnType<typeof useStore.getState>): string => {
  const o = s.activeId ? s.open[s.activeId] : undefined;
  return o ? lastUserText(o.conv.items) : '';
};
const useActivePrompt = () => useStore(activePrompt);

/** A template as a card: name, what it does, its risk in red. */
function TemplateCard({ t, onPick }: { t: BotTemplate; onPick: (t: BotTemplate) => void }) {
  return (
    <button type="button" className="bc-tpl" onClick={() => onPick(t)}>
      <span className="bc-tpl-name">{t.name}</span>
      <span className="bc-tpl-desc">{t.desc}</span>
      {t.risk && <span className="bc-risk">{t.risk}</span>}
    </button>
  );
}

const STARTERS = ['morning', 'pr', 'inbox'];

/** The empty page's three starter templates (晨报 / PR 巡检 / 收件箱分拣); a click opens the create flow on it. */
export function StarterTemplates() {
  const templates = useBots((s) => s.templates);
  const starters = STARTERS.map((id) => templates.find((t) => t.id === id)).filter((t): t is BotTemplate => !!t);
  if (!starters.length) return null;
  return <div className="bc-starters">{starters.map((t) => <TemplateCard key={t.id} t={t} onPick={(x) => startCreate(x.id)} />)}</div>;
}

/** Step 1: the three entries. */
function Entries({ cwd, onDraft, onBusy }: { cwd: string; onDraft: OnDraft; onBusy: (busy: boolean) => void }) {
  const templates = useBots((s) => s.templates);
  const prompt = useActivePrompt();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'' | 'text' | 'conv'>('');
  const run = async (src: 'text' | 'conv', t: string) => {
    if (!t.trim() || busy) return;
    setBusy(src); onBusy(true);
    const d = await generate(t.trim(), cwd);
    setBusy(''); onBusy(false);
    if (d) onDraft(d);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (imeComposing(e.nativeEvent)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run('text', text); }
  };
  return (
    <div className="bc-entries">
      <section className="bc-entry">
        <h4>{tr('一句话')}</h4>
        <textarea className="field" rows={3} autoFocus aria-label={tr('想让它做什么')} placeholder={tr('比如：每个工作日早上看一遍这个仓库的 issue 和 PR，整理成一页纸给我')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <div className="bc-entry-foot">
          <button className="btn primary sm" disabled={!text.trim() || !!busy} onClick={() => void run('text', text)}>{busy === 'text' ? tr('生成中…') : tr('生成')}</button>
        </div>
      </section>
      <section className="bc-entry">
        <h4>{tr('从当前对话')}</h4>
        {prompt
          ? <div className="bc-quote" title={prompt}>{prompt}</div>
          : <div className="bd-note">{tr('先打开一个对话，再从它最近一句话生成')}</div>}
        <div className="bc-entry-foot">
          <button className="btn sm" disabled={!prompt || !!busy} onClick={() => void run('conv', prompt)}>{busy === 'conv' ? tr('生成中…') : tr('用这句话生成')}</button>
        </div>
      </section>
      <section className="bc-entry wide">
        <h4>{tr('模板')}</h4>
        {templates.length
          ? <div className="bc-tpls">{templates.map((t) => <TemplateCard key={t.id} t={t} onPick={(x) => onDraft(draftFromTemplate(x, cwd), x.risk)} />)}</div>
          : <div className="bd-note">{tr('模板还没有加载，稍后再试')}</div>}
      </section>
    </div>
  );
}

/** One routine of the draft, every field editable. */
function RoutineRow({ r, onChange, onRemove }: { r: Routine; onChange: (r: Routine) => void; onRemove: () => void }) {
  const mode = r.cron && !r.everyMinutes ? 'cron' : 'every';
  return (
    <div className="bc-routine">
      <div className="bd-row">
        <span>{tr('名字')}</span>
        <BlurField label={tr('例行名字')} value={r.name} onSave={(name) => onChange({ ...r, name })} />
        <button className="btn sm ghost" onClick={onRemove}>{tr('删除')}</button>
      </div>
      <label className="bd-row"><span>{tr('要做什么')}</span><BlurField multiline label={tr('要做什么')} value={r.prompt} onSave={(prompt) => onChange({ ...r, prompt })} /></label>
      <div className="bd-row">
        <span>{tr('节奏')}</span>
        <span className="bd-pair">
          <Segmented label={tr('节奏')} value={mode} options={[{ value: 'every', label: tr('每隔') }, { value: 'cron', label: 'cron' }]}
            onChange={(m) => onChange(m === 'cron' ? { ...r, everyMinutes: undefined, cron: r.cron || '0 9 * * 1-5' } : { ...r, cron: undefined, everyMinutes: r.everyMinutes || 60 })} />
          {mode === 'every'
            ? <><NumField label={tr('间隔（分钟）')} value={r.everyMinutes} onSave={(n) => onChange({ ...r, everyMinutes: n })} /><span className="bd-unit">{tr('分钟')}</span></>
            : <BlurField className="mono" label="cron" placeholder="0 9 * * 1-5" value={r.cron ?? ''} onSave={(cron) => onChange({ ...r, cron: cron.trim() })} />}
          {fasterThanHourly(r) && <span className="bd-hint">{tr('约 {usd}/月', { usd: usd(monthlyEstimate(r, PER_RUN_USD)) })}</span>}
        </span>
      </div>
      {underMinimum(r) && <div className="bc-note warn" role="note">{tr('比每 {n} 分钟还勤，费用会很高；值班一般不需要这么快', { n: MIN_EVERY_MINUTES })}</div>}
      <label className="bd-row"><span>{tr('预检脚本')}</span><BlurField className="mono" label={tr('预检脚本')} placeholder={tr('输出没变就跳过、不唤醒模型（可不填）')} value={r.precheck ?? ''} onSave={(p) => onChange({ ...r, precheck: p.trim() || undefined })} /></label>
    </div>
  );
}

/** Step 2: the whole draft on one screen. */
function Preview({ d, set, risk, clamped }: { d: Draft; set: (p: Partial<Draft>) => void; risk?: string; clamped: string[] }) {
  const root = useRef<HTMLDivElement>(null);
  // the draft just appeared: the focus goes to its name
  useEffect(() => { root.current?.querySelector<HTMLInputElement>('input.field')?.focus(); }, []);
  const [gateways, setGateways] = useState<ImGatewayInfo[]>([]);
  useEffect(() => {
    let live = true;
    ws.request<ImGatewayInfo[]>({ kind: 'im.list' }).then((g) => { if (live) setGateways(Array.isArray(g) ? g : []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const c = d.charter;
  const charter = (p: Partial<Draft['charter']>) => set({ charter: { ...c, ...p } });
  const routine = (i: number, r: Routine | null) => set({ routines: r ? d.routines.map((x, k) => (k === i ? r : x)) : d.routines.filter((_, k) => k !== i) });
  const addRoutine = () => set({ routines: [...d.routines, { id: '', name: tr('例行'), prompt: '', everyMinutes: 60, enabled: true, onFail: 'inbox', acceptance: { kind: 'none' } }] });
  const im = d.outputs.find((o): o is ImOut => o.kind === 'im');
  const file = d.outputs.find((o): o is FileOut => o.kind === 'file');
  const outputs = (i: ImOut | undefined, f: FileOut | undefined) => set({ outputs: [{ kind: 'inbox' }, ...(i ? [i] : []), ...(f ? [f] : [])] });
  const gwOptions = [{ value: '', label: tr('不发') }, ...gateways.map((g) => ({ value: g.id, label: g.name || g.id }))];
  const tiers: { value: BotTier; label: string }[] = [{ value: 'cheap', label: tr('省钱') }, { value: 'balanced', label: tr('均衡') }, { value: 'best', label: tr('最强') }];
  const pick = async () => { const p = await pickFolder({ start: d.cwd || undefined }); if (p) set({ cwd: p }); };
  return (
    <div ref={root} className="bd-form bc-preview">
      {risk && <div className="bc-risk" role="note">{risk}</div>}
      <label><span>{tr('名字')}</span><BlurField label={tr('名字')} value={d.name} onSave={(name) => set({ name })} /></label>
      <div className="bd-row">
        <span>{tr('工作目录')}</span>
        <span className="bc-cwd mono" title={d.cwd}>{d.cwd || tr('还没选')}</span>
        <button className="btn sm" onClick={() => void pick()}>{tr('选择…')}</button>
      </div>
      <h4>{tr('章程')}</h4>
      <label><span>{tr('职责')}</span><BlurField multiline label={tr('职责')} value={c.role} onSave={(role) => charter({ role })} /></label>
      <label><span>{tr('给谁')}</span><BlurField label={tr('给谁')} value={c.audience ?? ''} onSave={(v) => charter({ audience: v || undefined })} /></label>
      <label><span>{tr('看哪些来源')}</span><BlurField multiline label={tr('看哪些来源')} placeholder={tr('一行一个，或用逗号隔开')} value={c.sources.join('\n')} onSave={(v) => charter({ sources: splitList(v) })} /></label>
      <label><span>{tr('怎么汇报')}</span><BlurField label={tr('怎么汇报')} value={c.report ?? ''} onSave={(v) => charter({ report: v || undefined })} /></label>
      <label><span>{tr('怎样算做完')}</span><BlurField label={tr('怎样算做完')} value={c.done ?? ''} onSave={(v) => charter({ done: v || undefined })} /></label>
      <h4>{tr('例行')}</h4>
      {clamped.length > 0 && <div className="bc-note" role="note">{tr('「{names}」原本比每 {n} 分钟还勤，已放慢到每 {n} 分钟', { names: clamped.join('、'), n: MIN_EVERY_MINUTES })}</div>}
      {d.routines.map((r, i) => <RoutineRow key={i} r={r} onChange={(x) => routine(i, x)} onRemove={() => routine(i, null)} />)}
      <div><button className="btn sm" onClick={addRoutine}>{tr('添加例行')}</button></div>
      <h4>{tr('设置')}</h4>
      <div className="bd-row"><span>{tr('模型档位')}</span><Segmented label={tr('模型档位')} options={tiers} value={d.tier} onChange={(tier) => set({ tier })} /></div>
      <div className="bd-row">
        <span>{tr('预算')}</span>
        <span className="bd-pair">
          <span className="bd-unit">{tr('每天 $')}</span><NumField label={tr('每天预算（美元）')} placeholder={tr('不限')} value={d.budget.dailyUsd} onSave={(dailyUsd) => set({ budget: { ...d.budget, dailyUsd } })} />
          <span className="bd-unit">{tr('每周 $')}</span><NumField label={tr('每周预算（美元）')} placeholder={tr('不限')} value={d.budget.weeklyUsd} onSave={(weeklyUsd) => set({ budget: { ...d.budget, weeklyUsd } })} />
        </span>
      </div>
      <div className="bd-row"><span>{tr('收件箱')}</span><span className="bd-fixed">{tr('总是发到收件箱')}</span></div>
      <div className="bd-row">
        <span>{tr('IM')}</span>
        <span className="bd-pair">
          <Select label={tr('IM 网关')} value={im?.gatewayId ?? ''} options={gwOptions} onValueChange={(v) => outputs(v ? { kind: 'im', gatewayId: String(v), chatId: im?.chatId ?? '' } : undefined, file)} />
          {im && <BlurField label={tr('聊天 ID')} placeholder={tr('聊天 ID')} value={im.chatId} onSave={(chatId) => outputs({ ...im, chatId: chatId.trim() }, file)} />}
        </span>
      </div>
      <div className="bd-row"><span>{tr('文件')}</span><BlurField label={tr('写到文件')} placeholder={tr('文件路径（不填就不写）')} value={file?.path ?? ''} onSave={(p) => outputs(im, p.trim() ? { kind: 'file', path: p.trim() } : undefined)} /></div>
      <div className="bc-safety">{tr('默认只读、只起草；对外发送、付款、删除会先问你')}</div>
    </div>
  );
}

/** The create flow, as a dialog over the Bot page. */
export function CreateBot({ onClose }: { onClose: () => void }) {
  const activeCwd = useActiveCwd();
  const box = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [risk, setRisk] = useState<string | undefined>();
  const [clamped, setClamped] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** after 保存并先跑一次: the bot, and whether its first run started (else why not) */
  const [made, setMade] = useState<{ botId: string; runError: string | null } | null>(null);
  const onDraft: OnDraft = (d, r) => {
    const n = normalizeDraft({ ...d, cwd: d.cwd || activeCwd });
    setDraft(n.draft); setClamped(n.clamped); setRisk(r); setErr('');
  };
  // opened from a starter card: straight to that template's preview; else the focus goes into the dialog
  useEffect(() => {
    const id = useBots.getState().createTemplate;
    const t = id ? useBots.getState().templates.find((x) => x.id === id) : undefined;
    if (t) onDraft(draftFromTemplate(t, activeCwd), t.risk);
    if (id) useBots.setState({ createTemplate: undefined });
    if (!box.current?.contains(document.activeElement)) box.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<Draft>) => { setDraft((x) => (x ? { ...x, ...p } : x)); setErr(''); };
  const create = async (runFirst: boolean) => {
    if (!draft || busy) return;
    const problem = draftProblem(draft);
    if (problem) { setErr(problem); return; }
    if (runFirst && !draft.routines.length) { setErr(tr('先加一条例行，才能跑')); return; }
    setBusy(true);
    const bot = await createBot(draft);
    if (!bot) { setBusy(false); return; }
    if (!runFirst) { setBusy(false); onClose(); return; }
    const first = bot.routines[0];
    const runError = first?.id ? await startRun(bot.id, first.id) : tr('没有找到要跑的例行');
    setBusy(false);
    setMade({ botId: bot.id, runError });
  };
  const back = () => { setDraft(null); setErr(''); setClamped([]); setRisk(undefined); };
  const goSee = (botId: string, tab: 'runs' | 'routines') => { selectBot(botId); setBotTab(tab); onClose(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); e.preventDefault(); onClose(); }
    else trapTab(e, box.current);
  };
  return (
    <div className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && !busy && !generating && onClose()} onKeyDown={onKey}>
      <div ref={box} tabIndex={-1} className="modal dialog bot-create" role="dialog" aria-modal="true" aria-label={tr('新建 Bot')}>
        <h3>{tr('新建 Bot')}</h3>
        <div className="bc-body">
          {draft ? <Preview d={draft} set={set} risk={risk} clamped={clamped} /> : <Entries cwd={activeCwd} onDraft={onDraft} onBusy={setGenerating} />}
        </div>
        {err && <div className="bd-err" role="alert">{err}</div>}
        {made ? (
          <div className="actions">
            {made.runError === null
              ? <span className="bc-started">{tr('已创建并开始第一次运行，去「运行」看它做了什么')}</span>
              : <span className="bc-started err" role="alert">{tr('已创建，但第一次运行没开始：{reason}', { reason: made.runError })}</span>}
            <button className="btn primary" autoFocus onClick={() => goSee(made.botId, made.runError === null ? 'runs' : 'routines')}>{tr('去看看')}</button>
          </div>
        ) : (
          <div className="actions">
            {draft && <button className="btn" disabled={busy} onClick={back}>{tr('上一步')}</button>}
            <span className="grow" />
            <button className="btn" onClick={onClose}>{tr('取消')}</button>
            {draft && <button className="btn" disabled={busy} onClick={() => void create(false)}>{tr('保存')}</button>}
            {draft && <button className="btn primary" disabled={busy} onClick={() => void create(true)}>{tr('保存并先跑一次')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
