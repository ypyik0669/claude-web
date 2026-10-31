// 值班 Bot thread: something the bot proposes — new permission rules (in plain words), a routine, or doing a kind of
// thing without asking from now on. 采纳 / 不用; the bot itself can't change its policy, only this card can — and adopting
// a rule that lets it send, pay or delete on its own asks first (proposalRisks), as the policy editor does.
import { useMemo, useState } from 'react';
import type { InboxItem } from '@shared';
import { tr } from '@/i18n';
import { cadenceText, classLabel } from '../model';
import { answerInbox, showProfile, useBots } from '../state';
import { confirmRisk } from '../fields';
import { clock } from './nav';
import { proposalRisks, rulesWords, ruleWords, scopeWords } from './proposal';

/**
 * 规矩 (spec §2.4): after the bot's first routine, what it does on its own and what it asks first — its policy as it
 * stands, in plain words. 就这样 puts the card away; 改一下 opens the profile at 权限 (the card stays until put away).
 */
function RulesCard({ item }: { item: InboxItem }) {
  const policy = useBots((s) => s.bots.find((b) => b.id === item.botId)?.policy);
  const [busy, setBusy] = useState(false);
  const w = useMemo(() => (policy ? rulesWords(policy) : null), [policy]);
  const fine = async () => { setBusy(true); try { await answerInbox({ id: item.id, answer: 'archive' }); } finally { setBusy(false); } };
  return (
    <div className="bt-card bt-proposal bt-rules-card" data-id={item.id} data-type="rules">
      <div className="bt-card-h">{tr('规矩')}</div>
      {w && (
        <ul className="bt-rules">
          {w.ask.length > 0 && <li>{tr('{what}：先问我', { what: w.ask.join('、') })}</li>}
          {w.own.length > 0 && <li>{tr('{what}：直接做', { what: w.own.join('、') })}</li>}
          {w.never.length > 0 && <li>{tr('{what}：不做', { what: w.never.join('、') })}</li>}
          {w.scoped > 0 && <li>{tr('另有 {n} 条只在某些地方放行的规则', { n: w.scoped })}</li>}
        </ul>
      )}
      {item.done ? (
        <div className="bt-ap-done">{tr('就这样 · {time}', { time: clock(item.done.at) })}</div>
      ) : (
        <div className="bt-card-acts">
          <button className="btn sm primary" disabled={busy} onClick={() => void fine()}>{tr('就这样')}</button>
          <button className="btn sm" disabled={busy} onClick={() => { useBots.setState({ selected: item.botId }); showProfile(true, 'policy'); }}>{tr('改一下')}</button>
        </div>
      )}
    </div>
  );
}

export function ProposalCard({ item }: { item: InboxItem }) {
  if (item.proposal?.type === 'rules') return <RulesCard item={item} />;
  return <OtherProposal item={item} />;
}

function OtherProposal({ item }: { item: InboxItem }) {
  const [busy, setBusy] = useState(false);
  const p = item.proposal;
  const act = async (answer: 'adopt' | 'archive') => {
    // the bot wrote these rules: adopting one that lets it send, pay or delete on its own (or anywhere) asks first,
    // like the same change made in the policy editor
    const rules = p?.type === 'policy' ? p.rules : p?.type === 'trust_up' ? [{ cls: p.cls, level: 'do' as const, scope: p.scope }] : [];
    const risks = answer === 'adopt' ? proposalRisks(rules) : [];
    if (risks.length && !(await confirmRisk(risks.join('\n')))) return;
    setBusy(true);
    try { await answerInbox({ id: item.id, answer }); } finally { setBusy(false); }
  };
  return (
    <div className="bt-card bt-proposal" data-id={item.id} data-type={p?.type}>
      <div className="bt-card-h">{tr('提议')} · {item.title}</div>
      {p?.type === 'policy' && (
        <>
          <ul className="bt-rules">{p.rules.map((r, i) => <li key={i}>{ruleWords(r)}</li>)}</ul>
          {p.why && <div className="bt-ap-hint">{tr('它说的理由：{why}', { why: p.why })}</div>}
        </>
      )}
      {p?.type === 'routine' && <div className="bt-run-said">{tr('例行「{name}」 · {when}', { name: p.routine.name, when: cadenceText(p.routine) })}</div>}
      {p?.type === 'trust_up' && <div className="bt-run-said">{tr('以后「{cls}」直接做', { cls: classLabel(p.cls) })}{scopeWords(p.scope) ? ` · ${scopeWords(p.scope)}` : ''}</div>}
      {!p && item.body && <pre className="bt-draft-body">{item.body}</pre>}
      {item.done ? (
        <div className="bt-ap-done">{item.done.answer === 'adopt' ? tr('已采纳 · {time}', { time: clock(item.done.at) }) : tr('没采纳')}</div>
      ) : (
        <div className="bt-card-acts">
          <button className="btn sm primary" disabled={busy} onClick={() => void act('adopt')}>{tr('采纳')}</button>
          <button className="btn sm" disabled={busy} onClick={() => void act('archive')}>{tr('不用')}</button>
        </div>
      )}
    </div>
  );
}
