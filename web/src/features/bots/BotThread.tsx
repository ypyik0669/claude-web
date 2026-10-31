// 值班 Bot: the middle column — the conversation with one bot (spec 2026-10-31 §1). The header (face, name, what it is
// doing; a click opens its profile), a banner when other bots wait for you, then the ordinary conversation view with the
// bot's cards (runs, approvals, drafts, proposals, system lines) between the turns, and a plain input box. A run card's
// 打开 shows that run's conversation in this column (← 返回 comes back); the thread underneath is hidden, not unmounted.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotRun, BotStatus } from '@shared';
import { useStore } from '@/store';
import { PaneContext } from '@/store/paneContext';
import { ChatView } from '@/features/chat/ChatView';
import { Composer } from '@/features/composer/Composer';
import { tr } from '@/i18n';
import { BotAvatar, type BotAvatarState } from './BotAvatar';
import { pendingByBot, rowState } from './model';
import { threadOnScreen } from './roster-model';
import { loadRuns, openThread, markSeen, useBots } from './state';
import { useThreadExtras } from './useThreadExtras';
import { ThreadNavContext, type ThreadNav } from './cards/nav';
import { RunView } from './cards/RunView';

const NO_RUNS: BotRun[] = [];

/** The header's one line: what it is doing, else the error and the next step, else 在线. */
export function activityLine(b: Pick<BotStatus, 'activity' | 'error' | 'paused'>): string {
  if (b.error) return b.error.next ? `${b.error.reason} · ${b.error.next}` : b.error.reason;
  if (b.activity) return b.activity;
  if (b.paused) return tr('已暂停');
  return tr('在线');
}

function faceState(b: BotStatus): BotAvatarState {
  const s = rowState(b);
  return s === 'attention' || s === 'error' || s === 'working' ? s : 'idle';
}

/** 「{n} 件事等你批 · 查看」: other bots' waiting items; 查看 opens the first of them. */
function OthersBanner({ botId }: { botId: string }) {
  const inbox = useBots((s) => s.inbox);
  const { n, first } = useMemo(() => {
    const by = pendingByBot(inbox);
    delete by[botId];
    const ids = Object.keys(by);
    return { n: ids.reduce((a, id) => a + by[id], 0), first: inbox.find((i) => !i.done && i.botId !== botId)?.botId ?? ids[0] };
  }, [inbox, botId]);
  if (!n || !first) return null;
  return (
    <div className="bt-banner" role="status">
      <span>{tr('{n} 件事等你批', { n })}</span>
      <button className="btn sm ghost" onClick={() => void openThread(first)}>{tr('查看')}</button>
    </div>
  );
}

export function BotThread({ bot }: { bot: BotStatus }) {
  const id = bot.id;
  const sessionId = bot.threadId ?? null;
  const mobile = useStore((s) => s.mobile);
  // on screen: on a phone only while the conversation screen shows (not the roster's or the profile's)
  const visible = useBots((s) => threadOnScreen(s, id, mobile));
  const profileOpen = useBots((s) => s.profileOpen);
  const loaded = useStore((s) => !!sessionId && !!s.open[sessionId]);
  const runs = useBots((s) => s.runs[id] ?? NO_RUNS);
  const extras = useThreadExtras(bot);
  const [runView, setRunView] = useState<{ sessionId: string; title: string } | null>(null);

  // another bot: back to its own conversation
  useEffect(() => setRunView(null), [id]);

  // shown but not open in this window (a reload, a bot picked elsewhere): open it, once per bot
  const tried = useRef('');
  useEffect(() => {
    if (!visible || loaded || tried.current === id) return;
    tried.current = id;
    void openThread(id);
  }, [visible, loaded, id]);

  // its runs, once per bot when its conversation first shows: the run cards need the records (until then they say the
  // routine and the time, 打开 disabled)
  const runsFor = useRef('');
  useEffect(() => {
    if (!visible || runsFor.current === id) return;
    runsFor.current = id;
    void loadRuns(id);
  }, [visible, id]);

  // seen while it is on screen: new entries as they come
  useEffect(() => { if (visible && bot.unseen > 0) void markSeen(id); }, [visible, bot.unseen, id]);

  const nav = useMemo<ThreadNav>(() => ({ openRun: (sid, title) => setRunView({ sessionId: sid, title }) }), []);
  const runLive = !!runView && runs.some((r) => r.sessionId === runView.sessionId && !r.endedAt && !r.skipped);
  const ctx = useMemo(() => ({ paneId: `bot:${id}`, tileId: 'bot', sessionId }), [id, sessionId]);

  return (
    <section className="bot-thread" data-bot={id} aria-label={tr('和「{name}」的对话', { name: bot.name })}>
      <button className="bt-head" aria-expanded={profileOpen} title={tr('资料')} onClick={() => useBots.setState((s) => ({ profileOpen: !s.profileOpen }))}>
        <BotAvatar name={bot.name} avatar={bot.avatar} size={30} state={faceState(bot)} />
        <span className="bt-head-text">
          <span className="bt-head-name">{bot.name}</span>
          <span className="bt-head-act" aria-live="polite" data-error={bot.error ? '' : undefined}>{activityLine(bot)}</span>
        </span>
      </button>
      <OthersBanner botId={id} />
      {runView && (
        <div className="bt-runview">
          <div className="bt-runview-h">
            <button className="btn sm ghost" onClick={() => setRunView(null)}>{tr('← 返回')}</button>
            <span>{tr('例行「{name}」的那次运行', { name: runView.title })}</span>
          </div>
          <div className="bt-runview-body"><RunView sessionId={runView.sessionId} live={runLive} /></div>
        </div>
      )}
      <div className="bt-main" hidden={!!runView}>
        <ThreadNavContext.Provider value={nav}>
          <PaneContext.Provider value={ctx}>
            {loaded ? (
              <>
                <div className="bt-chat"><ChatView extras={extras} /></div>
                <Composer variant="bot" visible={visible && !runView} />
              </>
            ) : (
              <div className="bt-waking" role="status">{tr('正在叫醒 {name}…', { name: bot.name })}</div>
            )}
          </PaneContext.Provider>
        </ThreadNavContext.Provider>
      </div>
    </section>
  );
}
