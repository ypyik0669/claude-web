// 值班 Bot (spec 2026-10-30-duty-bots-design §6): the inbox — 待批 / 发现 / 草稿 / 提议, each item with its bot, time
// and whether it can be taken back; approve / approve with a scope / reject / open the conversation; many at once.
// In the mission panel's 需要你 lane and, on a phone, the Bot page's first screen. Answers go to the server, which pushes
// the item back done (bots.inbox) — nothing changes here before that.
import { useMemo, useState } from 'react';
import type { InboxAnswer, InboxItem, PolicyScope } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { ago, clsx } from '@/util';
import { tr } from '@/i18n';
import { classLabel, groupInbox, INBOX_KINDS, inboxKindLabel } from './model';
import { closeBots, useBots } from './state';
import { callParams, ruleUnlimitedRisk, scopeDefaults, scopeFields, ScopeEditor } from './scope-form';
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

/**
 * Obvious secrets in a call, masked for showing (the same kinds the server's redact masks): auth headers, bearer
 * tokens, user:pass@ in a URL, the value of a key named like token / secret / password, sk- / ghp_ style keys.
 */
export function maskSecrets(s: string): string {
  return s
    .replace(/\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)(\s*[:=]\s*)[^'"\n]+/gi, '$1$2[redacted]')
    .replace(/\bbearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(\/\/)[^\s/@'":]+:[^\s/@'"]+@/g, '$1[redacted]@')
    .replace(/([?&;:\s"'{,$]|^)([\w-]*(?:token|secret|password|passwd|pwd|api[_-]?key|signature|credential)[\w-]*)(["']?\s*[=:]\s*)("[^"]{0,256}"|'[^']{0,256}'|[^&\s'",}]+)/gi, '$1$2$3[redacted]')
    .replace(/\b(sk|rk|pk)-[\w-]{8,}/g, '$1-[redacted]')
    .replace(/\b(ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abprs])[-_][\w-]{8,}/g, '$1_[redacted]');
}

/**
 * The whole call an approval is about, for the card: the command as typed for a shell call, else every parameter
 * (the inner tool's, under its name, when a wrapper carries them) — so the message text of an IM / MCP send, the full
 * URL and body are seen before 批准. Secrets masked. '' when the item carries no input.
 */
export function callDetail(item: Pick<InboxItem, 'input'>): string {
  const input = item.input;
  if (!input || !Object.keys(input).length) return '';
  const p = callParams(input);
  const inner = p !== input && typeof input.tool_name === 'string' ? `${input.tool_name}\n` : '';
  const body = typeof p.command === 'string' ? p.command : JSON.stringify(p, null, 2);
  return maskSecrets(inner + body);
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

function Item({ item, botName, routineName, picked, onPick, busy, act }: {
  item: InboxItem; botName: string; routineName?: string; picked: boolean; onPick: (on: boolean) => void; busy: boolean;
  act: (item: InboxItem, a: InboxAnswer['answer'], scope?: PolicyScope) => void;
}) {
  const [scoping, setScoping] = useState(false);
  const detail = item.kind === 'approval' ? callDetail(item) : '';
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
      {detail && (
        <details className="ib-body ib-call" open>
          <summary>{tr('要做的事')}</summary>
          <pre>{detail}</pre>
        </details>
      )}
      {item.body && (
        <details className="ib-body">
          <summary>{tr('正文')}</summary>
          <pre>{item.body}</pre>
        </details>
      )}
      {scoping ? (
        <ScopeEditor
          head={item.cls ? tr('以后在这个范围里，「{cls}」直接做，不再问你：', { cls: classLabel(item.cls) }) : tr('以后在这个范围里，这类操作直接做，不再问你：')}
          fields={scopeFields(item.cls)}
          initial={{ form: scopeDefaults(item), unlimited: { domains: false, channels: false, recipients: false, maxAmount: false, perDay: false, until: false } }}
          risk={ruleUnlimitedRisk}
          amountRequired={item.cls === 'pay'}
          okLabel={tr('批准并记住范围')}
          busy={busy}
          onCancel={() => setScoping(false)}
          onSend={(scope) => act(item, 'approve_scope', scope)}
        />
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
