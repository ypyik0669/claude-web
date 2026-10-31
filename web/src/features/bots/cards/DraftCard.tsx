// 值班 Bot thread: a draft — its text, then 发送 (copied for you to send, marked sendable) / 丢弃 / 以后不用草稿.
import { useState } from 'react';
import type { BotStatus, InboxItem } from '@shared';
import { useStore } from '@/store';
import { dlg } from '@/ui/dialog';
import { copyText } from '@/ui/clipboard';
import { tr } from '@/i18n';
import { answerInbox, updateBot } from '../state';
import { policyPatch } from '../fields';
import { clock } from './nav';

export function DraftCard({ item, bot }: { item: InboxItem; bot?: BotStatus }) {
  const [busy, setBusy] = useState(false);
  const text = item.body ?? item.title;
  const send = async () => {
    try { await copyText(text); } catch { useStore.getState().toast(tr('没能复制')); return; }
    setBusy(true);
    try { await answerInbox({ id: item.id, answer: 'send' }); } finally { setBusy(false); }
    useStore.getState().toast(tr('已复制，去发出去吧'), true);
  };
  const discard = async () => {
    setBusy(true);
    try { await answerInbox({ id: item.id, answer: 'archive' }); } finally { setBusy(false); }
  };
  const noMoreDrafts = async () => {
    if (!bot) return;
    const ok = await dlg.confirm(tr('{name} 以后不用草稿？', { name: bot.name }), { message: tr('以后它要对外发的东西会直接按权限走：「先问我」的照样会来问你。'), okLabel: tr('不用草稿') });
    if (ok) await updateBot(bot.id, { policy: { ...policyPatch(bot.policy), signOff: false } });
  };
  return (
    <div className="bt-card bt-draft" data-id={item.id}>
      <div className="bt-card-h">{tr('草稿')} · {item.title}</div>
      {item.body && <pre className="bt-draft-body">{item.body}</pre>}
      {item.done ? (
        <div className="bt-ap-done">{item.done.answer === 'send' ? tr('已发送 · {time}', { time: clock(item.done.at) }) : tr('已丢弃')}</div>
      ) : (
        <div className="bt-card-acts">
          <button className="btn sm primary" disabled={busy} onClick={() => void send()}>{tr('发送')}</button>
          <button className="btn sm" disabled={busy} onClick={() => void discard()}>{tr('丢弃')}</button>
          {bot?.policy.signOff !== false && <button className="btn sm ghost" onClick={() => void noMoreDrafts()}>{tr('以后不用草稿')}</button>}
        </div>
      )}
    </div>
  );
}
