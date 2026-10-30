// 值班 Bot (spec 2026-10-30-duty-bots-design §6): the inbox — 待批 / 发现 / 草稿 / 提议, each item with its bot, time
// and whether it can be taken back; approve / approve with a scope / reject / open the conversation; many at once.
// In the mission panel's 需要你 lane and, on a phone, the Bot page's first screen. Answers go to the server, which pushes
// the item back done (bots.inbox) — nothing changes here before that.
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { InboxAnswer, InboxItem, PolicyScope } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { SwitchChip } from '@/ui/Switch';
import { ago, clsx } from '@/util';
import { tr } from '@/i18n';
import { classLabel, groupInbox, INBOX_KINDS, inboxKindLabel } from './model';
import { closeBots, useBots } from './state';
import { confirmRisk, splitList } from './fields';
import { copyText } from '@/ui/clipboard';

export interface InboxAction { id: InboxAnswer['answer']; label: string; danger?: boolean; needsScope?: boolean }

/** The buttons an item gets, by kind. */
export function inboxActions(item: InboxItem): InboxAction[] {
  switch (item.kind) {
    case 'approval': return [{ id: 'approve', label: tr('批准') }, { id: 'approve_scope', label: tr('批并以后直接做'), needsScope: true }, { id: 'reject', label: tr('拒绝'), danger: true }];
    case 'finding': return [{ id: 'archive', label: tr('归档') }];
    case 'draft': return [{ id: 'send', label: tr('复制并标为可发') }, { id: 'archive', label: tr('归档') }];
    case 'proposal': return [{ id: 'adopt', label: tr('采纳') }, { id: 'archive', label: tr('忽略') }];
  }
}

export type ScopeField = 'domains' | 'channels' | 'recipients' | 'maxAmount' | 'perDay' | 'until';
const LIST_FIELDS = ['domains', 'channels', 'recipients'] as const;
export type ScopeForm = Record<ScopeField, string>;
export type ScopeUnlimited = Record<ScopeField, boolean>;

const strs = (...vs: unknown[]): string[] => vs.flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])).map((s) => s.trim()).filter(Boolean);
const hostsIn = (s: string): string[] => [...s.matchAll(/https?:\/\/([^\s/?#"'<>()，,]+)/gi)].map((m) => m[1].replace(/:\d+$/, '').toLowerCase()).filter((h) => !h.includes('@'));

/**
 * What the scope form starts with: the hosts of the URLs the call names, its channel(s), its recipients — the same
 * kinds the server's targetOf reads (the params of an ExecuteExtraTool / MCP call when they are wrapped). Rough on
 * purpose: the user sees and edits every field before anything is sent.
 */
export function scopeDefaults(item: Pick<InboxItem, 'toolName' | 'input'>): ScopeForm {
  const input = item.input ?? {};
  const p = (input.params && typeof input.params === 'object' ? input.params : input) as Record<string, unknown>;
  const hosts = [...new Set([p.command, p.url, p.uri, input.command, input.url].flatMap((t) => (typeof t === 'string' ? hostsIn(t) : [])))];
  return {
    domains: hosts.join(', '),
    channels: [...new Set(strs(p.channel, p.channel_id, p.channels, p.channel_ids))].join(', '),
    recipients: [...new Set(strs(p.to, p.recipient, p.recipients, p.cc, p.bcc))].join(', '),
    maxAmount: '',
    perDay: '',
    until: '',
  };
}

/** The fields the form shows: the three lists, 每天最多, 有效期; 金额上限 too for a payment. */
export function scopeFields(cls: InboxItem['cls']): ScopeField[] {
  return cls === 'pay' ? ['domains', 'channels', 'recipients', 'maxAmount', 'perDay', 'until'] : ['domains', 'channels', 'recipients', 'perDay', 'until'];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 有效期 as typed: whole days from now (≥ 1) or a date (YYYY-MM-DD, valid to the end of that day, not in the past). */
export function parseUntil(text: string, now: number): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) { const n = Number(t); return n >= 1 ? now + n * DAY_MS : null; }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (!m) return null;
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  if (end.getMonth() !== Number(m[2]) - 1 || end.getTime() <= now) return null;
  return end.getTime();
}

export type ScopeResult = { scope: PolicyScope } | { problem: string };

/**
 * The scope the user confirmed, field by field — nothing blank ever means "no limit":
 * - every shown field is either filled in or has its 无限制 ticked (each tick was confirmed with its own risk);
 * - at least one list (域名 / 频道 / 收件人) is filled in — a scope of numbers alone would match every destination;
 * - only when every shown field is ticked 无限制 is the scope `{ unlimited: true }`.
 * 每天最多 is a whole number ≥ 1, 金额上限 a number ≥ 0, 有效期 whole days ≥ 1 or a date.
 */
export function buildScope(form: ScopeForm, unlimited: ScopeUnlimited, fields: ScopeField[], now: number): ScopeResult {
  if (fields.every((f) => unlimited[f])) return { scope: { unlimited: true } };
  const out: PolicyScope = {};
  for (const f of fields) {
    if (unlimited[f]) continue;
    const text = form[f].trim();
    const blank = { problem: tr('「{field}」要填，或者勾它的「无限制」', { field: fieldLabel(f) }) };
    if (!text) return blank;
    if (f === 'domains' || f === 'channels' || f === 'recipients') {
      const list = splitList(text);
      if (!list.length) return blank;
      out[f] = list;
    } else if (f === 'perDay') {
      const n = Number(text);
      if (!(Number.isInteger(n) && n >= 1)) return { problem: tr('每天最多要填不小于 1 的整数') };
      out.perDay = n;
    } else if (f === 'maxAmount') {
      const n = Number(text);
      if (!(Number.isFinite(n) && n >= 0)) return { problem: tr('金额上限要填不小于 0 的数') };
      out.maxAmount = n;
    } else {
      const until = parseUntil(text, now);
      if (until === null) return { problem: tr('有效期填天数（至少 1），或者一个以后的日期，如 2026-12-31') };
      out.until = until;
    }
  }
  if (!out.domains && !out.channels && !out.recipients) return { problem: tr('域名、频道、收件人至少填一项：只限次数或金额，等于对谁都直接做') };
  return { scope: out };
}

function fieldLabel(f: ScopeField): string {
  switch (f) {
    case 'domains': return tr('域名');
    case 'channels': return tr('频道');
    case 'recipients': return tr('收件人');
    case 'maxAmount': return tr('金额上限');
    case 'perDay': return tr('每天最多');
    case 'until': return tr('有效期');
  }
}

/** What 无限制 on one field lets the bot do from now on without asking (spec §10), said before it is ticked. */
function unlimitedRisk(f: ScopeField): string {
  switch (f) {
    case 'domains': return tr('域名不限后，这类操作它以后对任何网站都直接做，不再问你。确定？');
    case 'channels': return tr('频道不限后，它以后可以往任何频道、群发消息，不再问你。确定？');
    case 'recipients': return tr('收件人不限后，它以后可以给任何人发消息、发邮件，不再问你。确定？');
    case 'maxAmount': return tr('金额不限后，它可以在你不在时无上限花钱。确定？');
    case 'perDay': return tr('次数不限后，它一天里可以不停地做下去，没有次数上限。确定？');
    case 'until': return tr('不设有效期后，这条范围会一直有效，直到你自己删掉它。确定？');
  }
}

const msg = (e: unknown) => (e as { message?: string })?.message ?? String(e);

/** One answer; false (and a toast — e.g. 「另一个 claude-web 正在值班」) when the server refused it: the item stays. */
async function send(a: InboxAnswer): Promise<boolean> {
  try { await ws.request({ kind: 'bots.inbox.answer', answer: a }); return true; } catch (e) { useStore.getState().toast(tr('处理失败：{message}', { message: msg(e) })); return false; }
}

/** Answer the items one after another; the first refusal stops the rest. How many went through. */
export async function answerInOrder(ids: string[], answer: InboxAnswer['answer'], sendOne: (a: InboxAnswer) => Promise<boolean>): Promise<number> {
  let n = 0;
  for (const id of ids) {
    if (!(await sendOne({ id, answer }))) break;
    n++;
  }
  return n;
}

/** The batch's one question: how many, and how many of them can't be taken back or go out / pay / delete. */
export function batchConfirm(list: InboxItem[], answer: 'approve' | 'archive'): { title: string; message?: string; danger: boolean } {
  if (answer === 'archive') return { title: tr('归档这 {n} 条？', { n: list.length }), danger: false };
  const undo = list.filter((i) => i.undoable === false).length;
  const risky = list.filter((i) => i.cls === 'send' || i.cls === 'pay' || i.cls === 'delete').length;
  const parts = [undo ? tr('其中 {n} 条不可撤', { n: undo }) : '', risky ? tr('{n} 条是对外发送、付款或删除', { n: risky }) : ''].filter(Boolean);
  return { title: tr('批准这 {n} 条？', { n: list.length }), message: parts.length ? parts.join('；') : undefined, danger: undo > 0 || risky > 0 };
}

/** 批并以后直接做: the scope it may do this kind of thing in from now on, prefilled from the call. */
function ScopeEditor({ item, busy, onSend, onCancel }: { item: InboxItem; busy: boolean; onSend: (s: PolicyScope) => void; onCancel: () => void }) {
  const [form, setForm] = useState<ScopeForm>(() => scopeDefaults(item));
  const [unlimited, setUnlimited] = useState<ScopeUnlimited>({ domains: false, channels: false, recipients: false, maxAmount: false, perDay: false, until: false });
  const [problem, setProblem] = useState('');
  const fields = scopeFields(item.cls);
  const tick = async (f: ScopeField, on: boolean) => {
    if (on && !(await confirmRisk(unlimitedRisk(f)))) return;
    setUnlimited((u) => ({ ...u, [f]: on }));
    setProblem('');
  };
  const submit = () => {
    const r = buildScope(form, unlimited, fields, Date.now());
    if ('problem' in r) { setProblem(r.problem); return; }
    onSend(r.scope);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(e.nativeEvent)) return;
    if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };
  return (
    <div className="ib-scope bd-form" onClick={(e) => e.stopPropagation()}>
      <div className="ib-scope-h">{item.cls ? tr('以后在这个范围里，「{cls}」直接做，不再问你：', { cls: classLabel(item.cls) }) : tr('以后在这个范围里，这类操作直接做，不再问你：')}</div>
      {fields.map((f) => (
        <div className="bd-row" key={f} data-field={f}>
          <span>{fieldLabel(f)}</span>
          <span className="bd-pair">
            <input
              className="field"
              aria-label={fieldLabel(f)}
              disabled={unlimited[f]}
              value={unlimited[f] ? '' : form[f]}
              placeholder={unlimited[f] ? tr('无限制') : f === 'until' ? tr('天数，或 2026-12-31') : f === 'perDay' ? tr('次数') : f === 'maxAmount' ? tr('金额') : tr('用逗号隔开')}
              inputMode={f === 'maxAmount' ? 'decimal' : f === 'perDay' ? 'numeric' : undefined}
              onChange={(e) => { const v = e.target.value; setForm((s) => ({ ...s, [f]: v })); setProblem(''); }}
              onKeyDown={onKey}
            />
            <SwitchChip on={unlimited[f]} onChange={(on) => void tick(f, on)}>{tr('无限制')}</SwitchChip>
          </span>
        </div>
      ))}
      {problem && <div className="ib-problem">{problem}</div>}
      <div className="ib-acts">
        <button className="btn sm primary" disabled={busy} onClick={submit}>{tr('批准并记住范围')}</button>
        <button className="btn sm" onClick={onCancel}>{tr('取消')}</button>
      </div>
    </div>
  );
}

function Item({ item, botName, routineName, picked, onPick, busy, act }: {
  item: InboxItem; botName: string; routineName?: string; picked: boolean; onPick: (on: boolean) => void; busy: boolean;
  act: (item: InboxItem, a: InboxAnswer['answer'], scope?: PolicyScope) => void;
}) {
  const [scoping, setScoping] = useState(false);
  const openChat = () => {
    if (!item.sessionId) return;
    closeBots();
    void useStore.getState().loadHistory(item.sessionId);
  };
  return (
    <div className="ib-item" data-kind={item.kind} data-id={item.id}>
      <div className="ib-line">
        <input type="checkbox" className="ib-pick" checked={picked} aria-label={tr('选中')} onChange={(e) => onPick(e.target.checked)} />
        <span className="ib-title">{item.title}</span>
      </div>
      <div className="ib-line sub">
        <span>{botName}</span>
        {item.cls && <span>· {classLabel(item.cls)}</span>}
        {item.toolName && <span className="mono">· {item.toolName}</span>}
        {item.routineId && <span>· {tr('例行「{name}」', { name: routineName ?? item.routineId })}</span>}
        {item.runId && <span className="mono" title={item.runId}>· {tr('运行 {id}', { id: item.runId.slice(-6) })}</span>}
        <span>· {ago(item.at)}</span>
        {item.undoable === false && <span className="ib-undo">{tr('不可撤')}</span>}
      </div>
      {item.body && (
        <details className="ib-body">
          <summary>{tr('正文')}</summary>
          <pre>{item.body}</pre>
        </details>
      )}
      {scoping ? (
        <ScopeEditor item={item} busy={busy} onCancel={() => setScoping(false)} onSend={(scope) => act(item, 'approve_scope', scope)} />
      ) : (
        <div className="ib-acts">
          {inboxActions(item).map((a) => (
            <button key={a.id + a.label} className={clsx('btn sm', a.danger && 'danger', a.id === 'approve' && 'primary')} disabled={busy} onClick={() => (a.needsScope ? setScoping(true) : act(item, a.id))}>{a.label}</button>
          ))}
          {item.sessionId && <button className="btn sm ghost" onClick={openChat}>{tr('看对话')}</button>}
        </div>
      )}
    </div>
  );
}

/** The inbox: the waiting items in four groups (empty groups are left out); `botId` keeps one bot's. */
export function Inbox({ botId, empty }: { botId?: string; /** shown when nothing waits (else nothing is drawn) */ empty?: string }) {
  const inbox = useBots((s) => s.inbox);
  const bots = useBots((s) => s.bots);
  const items = useMemo(() => inbox.filter((i) => !i.done && (!botId || i.botId === botId)), [inbox, botId]);
  const groups = useMemo(() => groupInbox(items), [items]);
  const names = useMemo(() => new Map(bots.map((b) => [b.id, b.name])), [bots]);
  const routineNames = useMemo(() => new Map(bots.flatMap((b) => b.routines.map((r) => [`${b.id}/${r.id}`, r.name] as const))), [bots]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  // only what is still waiting counts as picked
  const pickedItems = useMemo(() => items.filter((i) => picked.has(i.id)), [items, picked]);
  const pickedApprovals = pickedItems.filter((i) => i.kind === 'approval');
  const pickedArchivable = pickedItems.filter((i) => i.kind !== 'approval');

  const mark = (ids: string[], on: boolean) => setBusy((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });

  const act = async (item: InboxItem, answer: InboxAnswer['answer'], scope?: PolicyScope) => {
    if (answer === 'send') {
      // a draft: its text goes on the clipboard (the user sends it), then it is marked sendable
      const text = item.body ?? item.title;
      try { await copyText(text); } catch { useStore.getState().toast(tr('没能复制')); return; }
    }
    mark([item.id], true);
    const ok = await send({ id: item.id, answer, scope });
    mark([item.id], false);
    if (ok && answer === 'send') useStore.getState().toast(tr('已复制'), true);
  };

  /** Many at once, one after another (skipping any already being answered); the first refusal stops the rest, which stay picked. */
  const batch = async (all: InboxItem[], answer: 'approve' | 'archive') => {
    const list = all.filter((i) => !busy.has(i.id));
    if (!list.length) return;
    const { title, message, danger } = batchConfirm(list, answer);
    if (!(await dlg.confirm(title, { message, danger, focusCancel: danger, okLabel: answer === 'approve' ? tr('批准') : tr('归档') }))) return;
    const ids = list.map((i) => i.id);
    mark(ids, true);
    let n = 0;
    try { n = await answerInOrder(ids, answer, send); } finally { mark(ids, false); }
    const sent = new Set(ids.slice(0, n));
    setPicked((s) => new Set([...s].filter((id) => !sent.has(id))));
  };

  if (!items.length) return empty ? <div className="ib-empty">{empty}</div> : null;
  return (
    <div className="bots-inbox" aria-label={tr('收件箱')}>
      {pickedItems.length > 0 && (
        <div className="ib-batch" role="toolbar" aria-label={tr('批量操作')}>
          <span>{tr('已选 {n}', { n: pickedItems.length })}</span>
          <span className="grow" />
          <button className="btn sm primary" disabled={!pickedApprovals.length} onClick={() => void batch(pickedApprovals, 'approve')}>{tr('批量批准')}{pickedApprovals.length ? ` ${pickedApprovals.length}` : ''}</button>
          <button className="btn sm" disabled={!pickedArchivable.length} onClick={() => void batch(pickedArchivable, 'archive')}>{tr('批量归档')}{pickedArchivable.length ? ` ${pickedArchivable.length}` : ''}</button>
          <button className="btn sm ghost" onClick={() => setPicked(new Set())}>{tr('取消')}</button>
        </div>
      )}
      {INBOX_KINDS.map((k) => groups[k].length > 0 && (
        <section key={k} className="ib-group" data-kind={k}>
          <div className="ib-group-h"><b>{inboxKindLabel(k)}</b><span className="badge">{groups[k].length}</span></div>
          {groups[k].map((i) => (
            <Item
              key={i.id}
              item={i}
              botName={names.get(i.botId) ?? i.botId}
              routineName={i.routineId ? routineNames.get(`${i.botId}/${i.routineId}`) : undefined}
              picked={picked.has(i.id)}
              onPick={(on) => setPicked((s) => { const n = new Set(s); if (on) n.add(i.id); else n.delete(i.id); return n; })}
              busy={busy.has(i.id)}
              act={(item, a, scope) => void act(item, a, scope)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
