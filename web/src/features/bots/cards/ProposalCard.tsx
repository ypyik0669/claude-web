// 值班 Bot thread: something the bot proposes — new permission rules (in plain words), a routine, or doing a kind of
// thing without asking from now on. 采纳 / 不用; the bot itself can't change its policy, only this card can.
import { useState } from 'react';
import type { InboxItem, PolicyRule, PolicyScope } from '@shared';
import { tr } from '@/i18n';
import { cadenceText, classLabel, levelLabel } from '../model';
import { answerInbox } from '../state';
import { clock } from './nav';

function scopeWords(s?: PolicyScope): string {
  if (!s) return '';
  if (s.unlimited) return tr('不限范围');
  const parts = [...(s.domains ?? []), ...(s.channels ?? []), ...(s.recipients ?? [])];
  if (s.maxAmount !== undefined) parts.push(tr('不超过 {n}', { n: s.maxAmount }));
  if (s.perDay !== undefined) parts.push(tr('每天最多 {n} 次', { n: s.perDay }));
  return parts.join('、');
}

const ruleWords = (r: PolicyRule) => {
  const scope = scopeWords(r.scope);
  return `${classLabel(r.cls)}：${levelLabel(r.level)}${scope ? `（${scope}）` : ''}`;
};

export function ProposalCard({ item }: { item: InboxItem }) {
  const [busy, setBusy] = useState(false);
  const p = item.proposal;
  const act = async (answer: 'adopt' | 'archive') => {
    setBusy(true);
    try { await answerInbox({ id: item.id, answer }); } finally { setBusy(false); }
  };
  return (
    <div className="bt-card bt-proposal" data-id={item.id} data-type={p?.type}>
      <div className="bt-card-h">{tr('提议')} · {item.title}</div>
      {p?.type === 'policy' && (
        <>
          <ul className="bt-rules">{p.rules.map((r, i) => <li key={i}>{ruleWords(r)}</li>)}</ul>
          {p.why && <div className="bt-ap-hint">{p.why}</div>}
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
