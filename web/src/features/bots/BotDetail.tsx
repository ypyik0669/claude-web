import { useEffect, useState } from 'react';
import type { BotCharter, BotOutput, BotStatus, BotTier, ImGatewayInfo, MemoryItem } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { dlg } from '@/ui/dialog';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { Icon } from '@/ui/icons';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { stateLabel } from './model';
import { setBotTab, updateBot, type BotTab } from './state';
import { BlurField, NumField, currentBot, splitList, toggleUnleash } from './fields';
import { RoutineTable } from './RoutineTable';
import { RunList } from './RunList';
import { PolicyEditor } from './PolicyEditor';

const TABS: { id: BotTab; label: () => string }[] = [
  { id: 'routines', label: () => tr('例行') },
  { id: 'runs', label: () => tr('运行') },
  { id: 'policy', label: () => tr('策略') },
  { id: 'memory', label: () => tr('记忆') },
  { id: 'self', label: () => tr('自建') },
];

/** The charter: five fields, each saved when it loses the focus. */
function CharterCard({ bot }: { bot: BotStatus }) {
  const [open, setOpen] = useState(true);
  const c = bot.charter;
  // merged into the charter as stored at the moment of saving: tabbing on before bots.changed is back can't undo the last field
  const save = (patch: Partial<BotCharter>) => { const cur = currentBot(bot.id); if (cur) void updateBot(bot.id, { charter: { ...cur.charter, ...patch } }); };
  return (
    <section className={clsx('bd-card bd-charter', open && 'open')}>
      <button className="bd-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span>{tr('章程')}</span>
        {!open && <span className="bd-card-sum">{c.role}</span>}
      </button>
      {open && (
        <div className="bd-form">
          <label><span>{tr('职责')}</span><BlurField multiline label={tr('职责')} value={c.role} onSave={(role) => save({ role })} /></label>
          <label><span>{tr('给谁')}</span><BlurField label={tr('给谁')} value={c.audience ?? ''} onSave={(v) => save({ audience: v || undefined })} /></label>
          <label><span>{tr('看哪些来源')}</span><BlurField multiline label={tr('看哪些来源')} placeholder={tr('一行一个，或用逗号隔开')} value={c.sources.join('\n')} onSave={(v) => save({ sources: splitList(v) })} /></label>
          <label><span>{tr('怎么汇报')}</span><BlurField label={tr('怎么汇报')} value={c.report ?? ''} onSave={(v) => save({ report: v || undefined })} /></label>
          <label><span>{tr('怎样算做完')}</span><BlurField label={tr('怎样算做完')} value={c.done ?? ''} onSave={(v) => save({ done: v || undefined })} /></label>
        </div>
      )}
    </section>
  );
}

type ImOut = Extract<BotOutput, { kind: 'im' }>;
type FileOut = Extract<BotOutput, { kind: 'file' }>;

/** Where the bot's results go: the inbox always, an IM chat and a file when set. */
function Outputs({ bot }: { bot: BotStatus }) {
  const [gateways, setGateways] = useState<ImGatewayInfo[]>([]);
  useEffect(() => {
    let live = true;
    ws.request<ImGatewayInfo[]>({ kind: 'im.list' }).then((g) => { if (live) setGateways(Array.isArray(g) ? g : []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const im = bot.outputs.find((o): o is ImOut => o.kind === 'im');
  const file = bot.outputs.find((o): o is FileOut => o.kind === 'file');
  const save = (next: { im?: ImOut | null; file?: FileOut | null }) => {
    const cur = currentBot(bot.id)?.outputs ?? bot.outputs;
    const i = next.im === undefined ? cur.find((o): o is ImOut => o.kind === 'im') : next.im ?? undefined;
    const f = next.file === undefined ? cur.find((o): o is FileOut => o.kind === 'file') : next.file ?? undefined;
    const outputs: BotOutput[] = [{ kind: 'inbox' }];
    if (i) outputs.push(i);
    if (f) outputs.push(f);
    void updateBot(bot.id, { outputs });
  };
  const options = [{ value: '', label: tr('不发') }, ...gateways.map((g) => ({ value: g.id, label: g.name || g.id }))];
  // a gateway the bot names that the list doesn't have (removed, or not loaded yet) still shows
  if (im && !gateways.some((g) => g.id === im.gatewayId)) options.push({ value: im.gatewayId, label: im.gatewayId });
  return (
    <div className="bd-form bd-outputs">
      <div className="bd-row"><span>{tr('收件箱')}</span><span className="bd-fixed">{tr('总是发到收件箱')}</span></div>
      <div className="bd-row">
        <span>{tr('IM')}</span>
        <span className="bd-pair">
          <Select label={tr('IM 网关')} value={im?.gatewayId ?? ''} options={options} onValueChange={(v) => save({ im: v ? { kind: 'im', gatewayId: String(v), chatId: im?.chatId ?? '' } : null })} />
          {im && <BlurField label={tr('聊天 ID')} placeholder={tr('聊天 ID')} value={im.chatId} onSave={(chatId) => save({ im: { ...im, chatId: chatId.trim() } })} />}
        </span>
      </div>
      <div className="bd-row"><span>{tr('文件')}</span><BlurField label={tr('写到文件')} placeholder={tr('文件路径（不填就不写）')} value={file?.path ?? ''} onSave={(p) => save({ file: p.trim() ? { kind: 'file', path: p.trim() } : null })} /></div>
    </div>
  );
}

/** Model level, budgets, outputs and quiet hours. */
function Settings({ bot }: { bot: BotStatus }) {
  const tiers: { value: BotTier; label: string }[] = [
    { value: 'cheap', label: tr('省钱') },
    { value: 'balanced', label: tr('均衡') },
    { value: 'best', label: tr('最强') },
  ];
  const quiet = bot.quiet;
  const saveQuiet = (patch: { from?: string; to?: string }) => {
    const cur = currentBot(bot.id);
    if (!cur) return;
    const from = patch.from ?? cur.quiet?.from ?? '';
    const to = patch.to ?? cur.quiet?.to ?? '';
    void updateBot(bot.id, { quiet: from && to ? { from, to } : undefined });
  };
  const saveBudget = (patch: Partial<BotStatus['budget']>) => { const cur = currentBot(bot.id); if (cur) void updateBot(bot.id, { budget: { ...cur.budget, ...patch } }); };
  return (
    <section className="bd-card">
      <div className="bd-form">
        <div className="bd-row"><span>{tr('模型档位')}</span><Segmented label={tr('模型档位')} options={tiers} value={bot.tier} onChange={(tier) => { if (tier !== bot.tier) void updateBot(bot.id, { tier }); }} /></div>
        <div className="bd-row">
          <span>{tr('预算')}</span>
          <span className="bd-pair">
            <span className="bd-unit">{tr('每天 $')}</span><NumField label={tr('每天预算（美元）')} placeholder={tr('不限')} value={bot.budget.dailyUsd} onSave={(dailyUsd) => saveBudget({ dailyUsd })} />
            <span className="bd-unit">{tr('每周 $')}</span><NumField label={tr('每周预算（美元）')} placeholder={tr('不限')} value={bot.budget.weeklyUsd} onSave={(weeklyUsd) => saveBudget({ weeklyUsd })} />
          </span>
        </div>
        <div className="bd-row">
          <span>{tr('勿扰时段')}</span>
          <span className="bd-pair">
            <BlurField type="time" label={tr('勿扰开始')} value={quiet?.from ?? ''} onSave={(from) => saveQuiet({ from })} />
            <span className="bd-unit">–</span>
            <BlurField type="time" label={tr('勿扰结束')} value={quiet?.to ?? ''} onSave={(to) => saveQuiet({ to })} />
          </span>
        </div>
      </div>
      <Outputs bot={bot} />
    </section>
  );
}

/** 记忆: what the bot remembers (memory.db, scope 'bot', key = the bot's id). */
function MemoryTab({ bot }: { bot: BotStatus }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setErr('');
    ws.request<MemoryItem[]>({ kind: 'memory.search', scope: 'bot', botId: bot.id, limit: 200 })
      .then((m) => { if (live) setItems((Array.isArray(m) ? m : []).filter((x) => x.scope === 'bot')); })
      .catch((e: any) => { if (live) { setItems([]); setErr(String(e?.message ?? e)); } });
    return () => { live = false; };
  }, [bot.id, tick]);
  const remove = async (m: MemoryItem) => {
    if (!(await dlg.confirm(tr('删除这条记忆？'), { message: m.text, danger: true, focusCancel: true, okLabel: tr('删除') }))) return;
    try { await ws.request({ kind: 'memory.remove', id: m.id }); setTick((t) => t + 1); } catch (e: any) { useStore.getState().toast(tr('删除失败：{message}', { message: String(e?.message ?? e) })); }
  };
  if (err) return <div className="bd-note">{tr('读不到记忆：{err}', { err })}</div>;
  if (!items) return <div className="bd-note">{tr('读取中…')}</div>;
  if (!items.length) return <div className="bd-note">{tr('它还没记下什么。运行中学到的事会记在这里。')}</div>;
  return (
    <ul className="bd-memory">
      {items.map((m) => (
        <li key={m.id}>
          <span className="bd-mem-text">{m.text}</span>
          <button className="icon-btn" title={tr('删除')} aria-label={tr('删除')} onClick={() => void remove(m)}><Icon name="trash" size={13} /></button>
        </li>
      ))}
    </ul>
  );
}

/** 自建: the routines the bot made itself. */
function SelfTab({ bot }: { bot: BotStatus }) {
  const mine = bot.routines.filter((r) => r.selfMade);
  return (
    <div className="bd-self">
      <div className="bd-note">{tr('二期起 Bot 会自己提议例行和脚本，都会列在这里，可一键撤回')}</div>
      {mine.length > 0 && <RoutineTable bot={bot} routines={mine} />}
    </div>
  );
}

/** The page's middle column: one bot — name, charter, settings, then routines / runs / policy / memory / self. */
export function BotDetail({ bot, tab }: { bot: BotStatus; tab: BotTab }) {
  const unleashed = !!bot.policy.unleashed;
  const rename = async () => {
    const name = (await dlg.prompt(tr('Bot 的名字'), bot.name))?.trim();
    if (name && name !== bot.name) void updateBot(bot.id, { name });
  };
  return (
    <div className="bot-detail" data-tab={tab} data-id={bot.id}>
      <div className="bd-head">
        <h3 className="bd-name">{bot.name}</h3>
        <button className="icon-btn" title={tr('改名')} aria-label={tr('改名')} onClick={() => void rename()}><Icon name="edit" size={13} /></button>
        {unleashed && <span className="badge err" title={tr('已放开全部限制')}>{tr('无闸')}</span>}
        {!unleashed && bot.policy.autoPilot?.on && <span className="badge" title={tr('范围内的动作都直接做，不问你；到期自动关')}>{tr('全自动')}</span>}
        <span className="bot-state" data-state={bot.state}>{stateLabel(bot.state)}</span>
        <span className="grow" />
        <label className="switch-inline bd-unleash">
          {tr('放开全部')}
          <Switch on={unleashed} onChange={(on) => void toggleUnleash(bot, on)} />
        </label>
      </div>
      <CharterCard bot={bot} />
      <Settings bot={bot} />
      <div className="bd-tabs" role="tablist" aria-label={bot.name}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={clsx('bd-tab', tab === t.id && 'on')} onClick={() => setBotTab(t.id)}>{t.label()}</button>
        ))}
      </div>
      <div className="bd-tab-body" role="tabpanel">
        {tab === 'routines' && <RoutineTable bot={bot} routines={bot.routines} adding />}
        {tab === 'runs' && <RunList bot={bot} />}
        {tab === 'policy' && <PolicyEditor bot={bot} />}
        {tab === 'memory' && <MemoryTab bot={bot} />}
        {tab === 'self' && <SelfTab bot={bot} />}
      </div>
    </div>
  );
}
