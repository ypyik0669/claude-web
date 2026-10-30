import { useEffect, useMemo, useState } from 'react';
import type { BotRun, BotStatus } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { applyTranscript, createConversation } from '@/model/conversation';
import { ItemList } from '@/features/chat/ChatView';
import { unwrapHarnessMessage } from '@/features/background/model';
import { EmptyState } from '@/ui/EmptyState';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { usd } from './model';
import { loadRuns, useBots } from './state';
import { openRunChat } from './RunList';

/** How often a running run's conversation is read again. */
const REFRESH_MS = 3000;

/** A run's conversation read from disk (transcript.load), again every few seconds while it runs — like 后台's AgentDrawer. */
function DiskConversation({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [msgs, setMsgs] = useState<unknown[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setMsgs(null); setErr('');
    let on = true;
    const read = () => ws.request<unknown[]>({ kind: 'transcript.load', sessionId })
      .then((m) => { if (on) setMsgs(Array.isArray(m) ? m : []); })
      .catch((e: any) => { if (on) setErr(String(e?.message ?? e)); });
    void read();
    const t = live ? setInterval(read, REFRESH_MS) : undefined;
    return () => { on = false; if (t) clearInterval(t); };
  }, [sessionId, live]);
  const conv = useMemo(() => {
    if (!msgs) return null;
    const c = createConversation();
    applyTranscript(c, (msgs as any[]).map(unwrapHarnessMessage), { live });
    return c;
  }, [msgs, live]);
  if (err) return <div className="bd-note">{tr('读不到它的对话：{err}', { err })}</div>;
  if (!conv) return <div className="bd-note">{tr('读取中…')}</div>;
  if (!conv.items.length) return <div className="bd-note">{tr('它还没说话。')}</div>;
  return <ItemList items={conv.items} version={msgs?.length ?? 0} actions="none" />;
}

/** The conversation itself: the live one when this window has it open, else from disk. */
function RunConversation({ run }: { run: BotRun & { sessionId: string } }) {
  const open = useStore((s) => s.open[run.sessionId]);
  if (open) return <ItemList items={open.conv.items} version={open.version} actions="none" />;
  return <DiskConversation sessionId={run.sessionId} live={!run.endedAt} />;
}

const hasSession = (r: BotRun | undefined): r is BotRun & { sessionId: string } => !!r?.sessionId;

/** The page's right column: the bot's latest run — the one running, else the last one — as its conversation. */
export function RunPane({ bot }: { bot: BotStatus }) {
  // the runs so far, not only what is pushed from now on (else this is empty until the 运行 tab is opened)
  useEffect(() => { void loadRuns(bot.id); }, [bot.id]);
  // the newest run that has a conversation (a skipped one has none and would blank the pane)
  const latest = useBots((s) => s.runs[bot.id]?.find((r) => !!r.sessionId));
  const routine = latest && bot.routines.find((r) => r.id === latest.routineId);
  const going = !!latest && !latest.endedAt && !latest.skipped;
  return (
    <aside className="bot-run-pane" aria-label={tr('{name} 的运行', { name: bot.name })}>
      {hasSession(latest) ? (
        <>
          <div className="rp-head">
            <div className="rp-title">
              <div className="rp-name">{routine?.name ?? latest.routineId}</div>
              <div className="rp-sub">{going ? tr('在跑') : latest.ok === false ? tr('没成') : tr('跑完了')}{latest.costUsd !== undefined ? ` · ${usd(latest.costUsd)}` : ''}</div>
            </div>
            <button className="btn sm" title={tr('在对话里打开，可以插话')} onClick={() => openRunChat(latest.sessionId)}><Icon name="chat" size={12} />{tr('打开对话')}</button>
          </div>
          <div className="rp-body"><RunConversation run={latest} /></div>
        </>
      ) : (
        <EmptyState e={{ what: tr('运行'), when: tr('例行开始跑'), line: tr('没有在跑的运行') }} />
      )}
    </aside>
  );
}
