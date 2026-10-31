// 值班 Bot thread: something the bot proposes — new permission rules (in plain words), a routine, or doing a kind of
// thing without asking from now on. 采纳 / 不用; the bot itself can't change its policy, only this card can — and adopting
// a rule that lets it send, pay or delete on its own asks first (proposalRisks), as the policy editor does.
import { useState } from 'react';
import type { InboxItem } from '@shared';
import { tr } from '@/i18n';
import { cadenceText, classLabel } from '../model';
import { answerInbox } from '../state';
import { confirmRisk } from '../fields';
import { clock } from './nav';
import { proposalRisks, ruleWords, scopeWords } from './proposal';

export function ProposalCard({ item }: { item: InboxItem }) {
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
