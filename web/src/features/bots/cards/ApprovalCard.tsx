// 值班 Bot thread: an approval (spec 2026-10-31 §1) — 「〈类别〉· 〈Bot〉想要 〈做什么〉」, gray 「请核对后再批准」, the
// whole call (secrets masked), the key facts, then an equal-width 拒绝｜允许 ▾ (the body is 仅这次, the narrowest).
// Answered it stays as 「已允许 · 9:42」 / 「已拒绝」 / 「已过期」. Answers go to the server, which pushes the item back done.
import { useMemo, useRef, useState } from 'react';
import type { InboxItem, PolicyScope } from '@shared';
import { tr } from '@/i18n';
import { MenuHost, useAnchoredMenu } from '@/features/sidebar/menus';
import { classLabel } from '../model';
import { answerInbox, useBots } from '../state';
import { callDetail } from '../Inbox';
import { callParams, ruleUnlimitedRisk, scopeDefaults, scopeFields, ScopeEditor, type ScopeField, type ScopeInitial } from '../scope-form';
import { confirmRisk } from '../fields';
import { approvalChoices, RUN_SCOPE_MS, type ApprovalChoice } from './approval-menu';
import { clock } from './nav';

const NONE = { domains: false, channels: false, recipients: false, maxAmount: false, perDay: false, until: false };
const ALL = { domains: true, channels: true, recipients: true, maxAmount: true, perDay: true, until: true };

/** The facts row: amount, recipients, channels, domains — what the call says, nothing guessed. */
function facts(item: InboxItem): { label: string; value: string }[] {
  const d = scopeDefaults(item);
  const p = callParams(item.input);
  const out: { label: string; value: string }[] = [];
  const amount = p.amount ?? p.price ?? p.total;
  if (typeof amount === 'number' || typeof amount === 'string') out.push({ label: tr('金额'), value: `${amount}${typeof p.currency === 'string' ? ` ${p.currency}` : ''}` });
  if (d.recipients) out.push({ label: tr('收件人'), value: d.recipients });
  if (d.channels) out.push({ label: tr('频道'), value: d.channels });
  if (d.domains) out.push({ label: tr('域名'), value: d.domains });
  return out;
}

/** The same call still waiting (an expired card's 「以后总是允许？」 answers that one). */
function useTwin(item: InboxItem): InboxItem | undefined {
  const inbox = useBots((s) => s.inbox);
  return useMemo(() => {
    if (!item.done?.note) return undefined;
    const key = JSON.stringify(item.input ?? {});
    return inbox.find((i) => !i.done && i.id !== item.id && i.kind === 'approval' && i.botId === item.botId && i.toolName === item.toolName && JSON.stringify(i.input ?? {}) === key);
  }, [inbox, item]);
}

function AllowMenu({ choices, onPick, onClose }: { choices: ApprovalChoice[]; onPick: (c: ApprovalChoice) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnchoredMenu(ref, onClose, { align: 'right' });
  return (
    <MenuHost onClose={onClose}>
      <div ref={ref} className="menu bt-allow-menu" role="menu" onClick={(e) => e.stopPropagation()}>
        {choices.map((c) => <button key={c.id} role="menuitem" data-choice={c.id} onClick={() => { onClose(); onPick(c); }}>{c.label}</button>)}
      </div>
    </MenuHost>
  );
}

/** The scope form for a choice that needs one, prefilled from the call. */
function ChoiceEditor({ item, choice, busy, onSend, onCancel }: { item: InboxItem; choice: ApprovalChoice; busy: boolean; onSend: (s: PolicyScope) => void; onCancel: () => void }) {
  const cls = item.cls ? classLabel(item.cls) : '';
  // 这次运行内 has its own 有效期 (30 minutes), so the form leaves that field out
  const fields: ScopeField[] = choice.editor === 'run' ? scopeFields(item.cls).filter((f) => f !== 'until') : scopeFields(item.cls);
  const initial: ScopeInitial = choice.editor === 'unlimited' ? { form: scopeDefaults(item), unlimited: { ...ALL } } : { form: scopeDefaults(item), unlimited: { ...NONE } };
  const head = choice.editor === 'unlimited'
    ? tr('以后「{cls}」都直接做，不再问你。要留一点限制，就取消某项的「无限制」：', { cls: cls || tr('这类操作') })
    : choice.editor === 'run'
      ? tr('接下来 30 分钟里，在这个范围内直接做：')
      : tr('以后在这个范围里，「{cls}」直接做，不再问你：', { cls: cls || tr('这类操作') });
  const send = async (s: PolicyScope) => {
    if (s.unlimited && !(await confirmRisk(tr('总是允许后，「{cls}」这类操作它以后对谁都直接做，不再问你。确定？', { cls: cls || tr('这类操作') })))) return;
    onSend(choice.editor === 'run' ? { ...s, until: Date.now() + RUN_SCOPE_MS } : s);
  };
  return (
    <ScopeEditor
      className="ib-scope bd-form bt-scope"
      head={head}
      fields={fields}
      initial={initial}
      risk={ruleUnlimitedRisk}
      amountRequired={choice.amountRequired}
      okLabel={tr('允许')}
      busy={busy}
      onCancel={onCancel}
      onSend={(s) => void send(s)}
    />
  );
}

function doneText(d: NonNullable<InboxItem['done']>): string {
  if (d.note) return tr('已过期');
  if (d.answer === 'reject') return tr('已拒绝');
  return tr('已允许 · {time}', { time: clock(d.at) });
}

export function ApprovalCard({ item, botName }: { item: InboxItem; botName: string }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<{ choice: ApprovalChoice; target: InboxItem } | null>(null);
  const [busy, setBusy] = useState(false);
  const detail = useMemo(() => callDetail(item), [item]);
  const keyFacts = useMemo(() => facts(item), [item]);
  const twin = useTwin(item);

  const answer = async (target: InboxItem, a: 'approve' | 'approve_scope' | 'reject', scope?: PolicyScope) => {
    setBusy(true);
    try { await answerInbox({ id: target.id, answer: a, scope }); } finally { setBusy(false); setEditing(null); }
  };
  const pick = (c: ApprovalChoice, target = item) => {
    if (c.editor) setEditing({ choice: c, target });
    else void answer(target, c.answer as 'approve' | 'approve_scope', c.scope);
  };

  const head = tr('{cls} · {bot} 想要 {what}', { cls: item.cls ? classLabel(item.cls) : tr('操作'), bot: botName, what: item.title });
  return (
    <div className="bt-card bt-approval" data-id={item.id} data-done={item.done ? (item.done.note ? 'expired' : item.done.answer) : undefined}>
      <div className="bt-ap-h">{head}</div>
      {!item.done && <div className="bt-ap-hint">{tr('请核对后再批准')}{item.undoable === false ? ` · ${tr('做了就撤不回')}` : ''}</div>}
      {detail && <pre className="bt-ap-evidence">{detail}</pre>}
      {keyFacts.length > 0 && (
        <div className="bt-ap-facts">{keyFacts.map((f) => <span key={f.label}><b>{f.label}</b> {f.value}</span>)}</div>
      )}
      {editing ? (
        <ChoiceEditor item={editing.target} choice={editing.choice} busy={busy} onCancel={() => setEditing(null)} onSend={(s) => void answer(editing.target, 'approve_scope', s)} />
      ) : item.done ? (
        <div className="bt-ap-done">
          <span>{doneText(item.done)}</span>
          {item.done.note && (twin
            ? <button className="btn sm ghost" onClick={() => { const cs = approvalChoices(twin, Date.now()); pick(cs.find((x) => x.id === 'target') ?? cs[cs.length - 1], twin); }}>{tr('以后总是允许？')}</button>
            : <span className="bt-ap-note">{tr('下次它再问到这件事时，可以选「对这个目标总是允许」')}</span>)}
        </div>
      ) : (
        <div className="bt-ap-acts">
          <button className="btn" disabled={busy} onClick={() => void answer(item, 'reject')}>{tr('拒绝')}</button>
          <span className="bt-allow">
            <button className="btn primary bt-allow-main" disabled={busy} onClick={() => void answer(item, 'approve')}>{tr('允许')}</button>
            <button className="btn primary bt-allow-more" disabled={busy} aria-label={tr('更多允许方式')} aria-haspopup="menu" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}>▾</button>
            {menu && <AllowMenu choices={approvalChoices(item, Date.now())} onPick={(c) => pick(c)} onClose={() => setMenu(false)} />}
          </span>
        </div>
      )}
    </div>
  );
}
