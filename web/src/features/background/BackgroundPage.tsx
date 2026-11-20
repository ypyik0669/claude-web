import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import type { BgSession } from '@shared';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { Menu } from '@/features/sidebar/menus';
import { OverPage } from '@/features/sections/OverPage';
import { openLibrary } from '@/features/cafe/state';
import type { OfficeControls } from '@/features/office/Office';
import { AgentDrawer } from './AgentDrawer';
import { BG_TITLE, liveCounts } from './model';
import { liveSummary, type RunView } from './run-list';
import { closeAgent, closeBackground, openAgent, openChat, selectBackground, setBgView, setRunView, useBackground, useRunView } from './state';
import { sessionAt } from './history-model';
import { pickHistory, useHistory } from './history-state';
import { playPause, seekReplay, setReplaySpeed, stopReplay, useReplay } from './replay';
import { HistoryView } from './HistoryView';
import { ReplayBar } from './ReplayBar';
import { RunList } from './RunList';
import { tr } from '@/i18n';

// the cafe is a three.js scene: loaded when the page first shows it (the first screen's entry stays small)
const Office = lazy(() => import('@/features/office/Office').then((m) => ({ default: m.Office })));

/**
 * 跑过的 → 在网吧里回放: the run at the replay's moment, as the cafe's one conversation. A new picture when a state
 * changes, and once a second of real time (the cards' running times) — not at every tick of the clock.
 */
function useCafeReplay(): { session: BgSession; title: string; bar: React.ReactNode; onStop: () => void } | undefined {
  const show = useReplay((s) => (s.show?.where === 'cafe' ? s.show : undefined));
  const t = useReplay((s) => (s.show?.where === 'cafe' ? s.t : 0));
  const playing = useReplay((s) => s.show?.where === 'cafe' && s.playing);
  const speed = useReplay((s) => s.speed);
  const at = show ? show.start + t : 0;
  const view = show ? sessionAt(show.sessionId, show.task, at) : undefined;
  const sig = view ? `${view.tasks[0].status}|${view.tasks[0].agents.map((a) => a.key + a.state[0]).join(',')}` : '';
  const tick = show ? Math.floor(t / (speed * 1000)) : -1;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const session = useMemo(() => view, [show, sig, tick]);
  if (!show || !session) return undefined;
  return {
    session,
    title: show.title,
    bar: <ReplayBar compact t={t} dur={show.end - show.start} playing={playing} speed={speed} onPlay={playPause} onSeek={seekReplay} onSpeed={setReplaySpeed} />,
    onStop: stopReplay,
  };
}

/** The cafe of every conversation's background (or the run 跑过的 replays in it), filling the page's body. */
function OfficeBlock({ follow, controls }: { follow?: string; controls: React.MutableRefObject<OfficeControls | null> }) {
  const replay = useCafeReplay();
  return (
    <ErrorBoundary area={tr('后台 · 网吧')}>
      <Suspense fallback={null}>
        <Office
          follow={replay ? replay.session.sessionId : follow}
          replay={replay}
          controls={controls}
          onFloor={(sid) => { if (!replay) selectBackground(sid); }}
          onOpenAgent={(sid, taskId, agentKey) => {
            if (!replay) { selectBackground(sid); openAgent({ sessionId: sid, taskId, agentKey }); return; }
            // a replayed run's agent: its conversation read from disk, like 跑过的 does
            const task = useReplay.getState().show?.task;
            if (task) openAgent({ sessionId: sid, taskId, agentKey, task });
          }}
          onOpenChat={(sid) => openChat(sid)}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

/** An agent's own conversation beside the list or the cafe (a replayed run's agent comes with its task). */
function LiveDrawer() {
  const drawer = useBackground((s) => (s.drawer?.from === 'history' ? undefined : s.drawer));
  const sessions = useBackground((s) => s.sessions);
  const task = drawer?.task ?? (drawer ? sessions[drawer.sessionId]?.tasks.find((t) => t.id === drawer.taskId) : undefined);
  const agent = task?.agents.find((a) => a.key === drawer!.agentKey);
  if (!drawer || !task || !agent) return null;
  return <ErrorBoundary area={tr('后台 · 子代理对话')}><AgentDrawer sessionId={drawer.sessionId} task={task} agent={agent} /></ErrorBoundary>;
}

/** 在跑 N / 跑过的: what runs now (the list, the cafe) or what every conversation ran. A phone leaves out the number
 *  (the 运行中 tab right under it says it; the head of a 360 px screen has no room for it). */
function ViewSwitch({ view, running, phone }: { view: 'live' | 'history'; running: number; phone: boolean }) {
  return (
    <div className="bg-views" role="tablist" aria-label={tr('在跑 / 跑过的')}>
      <button type="button" role="tab" aria-selected={view === 'live'} data-view="live" className={clsx(view === 'live' && 'on')} onClick={() => setBgView('live')}>
        {tr('在跑')}{running > 0 && !phone && <span className="n">{running}</span>}
      </button>
      <button type="button" role="tab" aria-selected={view === 'history'} data-view="history" className={clsx(view === 'history' && 'on')} onClick={() => setBgView('history')}>{tr('跑过的')}</button>
    </div>
  );
}

/** 列表 / 网吧 at the end of the tab row (a desktop): the cafe is another way to look at 运行中. Remembered. */
function RunViewSwitch({ view }: { view: RunView }) {
  const opt = (v: RunView, icon: IconName, label: string) => (
    <button type="button" role="radio" aria-checked={view === v} data-view={v} className={clsx(view === v && 'on')} onClick={() => setRunView(v)}><Icon name={icon} size={13} />{label}</button>
  );
  return (
    <div className="bg-runview" role="radiogroup" aria-label={tr('列表 / 网吧')}>
      {opt('list', 'menu', tr('列表'))}
      {opt('cafe', 'cafe', tr('网吧'))}
    </div>
  );
}

/**
 * A phone's ⋯ on 在跑: 列表 / 3D 网吧 (the cafe is not the default there: it drains a battery), and while the cafe is
 * shown, its tools — day / night, zoom, the whole cafe, the character library — which on a desktop float over it.
 */
function PhoneMore({ view, cafe }: { view: RunView; cafe: React.MutableRefObject<OfficeControls | null> }) {
  const [open, setOpen] = useState(false);
  const light = useStore((s) => s.settings['office.light']);
  const close = () => setOpen(false);
  const act = (fn: () => void) => () => { close(); fn(); };
  const setLight = (v: 'day' | 'night' | null) => act(() => void useStore.getState().setSetting('office.light', v));
  const radio = (on: boolean, id: string, icon: IconName, label: string, pick: () => void) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={on} data-id={id} className={clsx(on && 'on')} onClick={pick}>
      <Icon name={icon} size={14} />{label}<Icon name="check" size={14} className="ck" />
    </button>
  );
  return (
    <span className="bg-more">
      <button type="button" className="icon-btn" title={tr('更多')} aria-label={tr('更多')} aria-haspopup="menu" aria-expanded={open} data-act="more" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        <Icon name="more" size={18} />
      </button>
      {open && (
        <Menu onClose={close} label={tr('运行中')} className="bg-more-menu" align="right">
          <div className="menu-label">{tr('怎么看')}</div>
          {radio(view === 'list', 'list', 'menu', tr('列表'), act(() => setRunView('list')))}
          {radio(view === 'cafe', 'cafe', 'cafe', tr('3D 网吧'), act(() => setRunView('cafe')))}
          {view === 'cafe' && (
            <>
              <div className="menu-label">{tr('网吧')}</div>
              {radio(!light, 'light-auto', 'monitor', tr('跟着主题'), setLight(null))}
              {radio(light === 'day', 'light-day', 'sun', tr('白天'), setLight('day'))}
              {radio(light === 'night', 'light-night', 'moon', tr('夜里'), setLight('night'))}
              <div className="menu-sep" />
              <button type="button" data-id="zoom-in" onClick={act(() => cafe.current?.zoom(1.25))}><Icon name="plus" size={14} />{tr('放大')}</button>
              <button type="button" data-id="zoom-out" onClick={act(() => cafe.current?.zoom(1 / 1.25))}><Icon name="minus" size={14} />{tr('缩小')}</button>
              <button type="button" data-id="whole" onClick={act(() => cafe.current?.whole())}><Icon name="cafe" size={14} />{tr('整个网吧')}</button>
              <button type="button" data-id="library" onClick={act(openLibrary)}><Icon name="user" size={14} />{tr('角色库')}</button>
            </>
          )}
        </Menu>
      )}
    </span>
  );
}

/**
 * 自动化 › 运行中 (the background page; spec 2026-10-12-background-office-design.md, redesign 2026-11): what every
 * conversation has going besides its turn — the agents of its workflows, its sub-agents, its background commands.
 * 在跑 is a list grouped by what each conversation runs (RunList) or the 3D cafe of the same snapshot — 列表 / 网吧,
 * remembered on a desktop, the list first on a phone. 跑过的 (2026-11-19): every conversation's finished work, from
 * disk. The page lies over the main area like 自动化's other tabs; the sidebar stays the conversation list.
 */
export function BackgroundPage() {
  const open = useBackground((s) => s.open);
  const sessions = useBackground((s) => s.sessions);
  const selected = useBackground((s) => s.selected);
  const drawer = useBackground((s) => !!s.drawer && s.drawer.from !== 'history');
  const view = useBackground((s) => s.view);
  const historySeen = useBackground((s) => s.historySeen);
  const picked = useHistory((s) => !!s.pick);
  const mobile = useStore((s) => s.mobile);
  const runView = useRunView();
  const history = view === 'history';
  const cafe = !history && runView === 'cafe';
  // the cafe (three.js, its own chunk) is mounted the first time it is shown, then only hidden like the page
  const [cafeSeen, setCafeSeen] = useState(false);
  if (cafe && !cafeSeen) setCafeSeen(true);
  const controls = useRef<OfficeControls | null>(null);
  const runningAll = useMemo(() => Object.values(sessions).reduce((n, s) => n + liveCounts(s).tasks, 0), [sessions]);
  const summary = useMemo(() => liveSummary(sessions), [sessions]);
  return (
    <OverPage
      name="bg"
      label={BG_TITLE}
      open={open}
      onClose={() => { if (drawer) closeAgent(); else closeBackground(); }}
      // a phone on one run of 跑过的: back to the list first
      onEscape={() => { if (history && mobile && picked && !useBackground.getState().drawer) { pickHistory(undefined); return true; } return false; }}
      title={BG_TITLE}
      desc={history ? tr('每个对话跑完的工作流、子代理和后台命令') : summary}
      tab=""
      tabs={[]}
      showTabs={false}
      onTab={() => {}}
      tabsEnd={!history && !mobile ? <RunViewSwitch view={runView} /> : undefined}
      actions={(
        <>
          <ViewSwitch view={view} running={runningAll} phone={mobile} />
          {mobile && !history && <PhoneMore view={runView} cafe={controls} />}
        </>
      )}
    >
      <div className={clsx('over-body bg-body', cafe ? 'cafe' : 'list', drawer && 'with-drawer')} data-view={runView} hidden={history}>
        <div className="bg-live-main" hidden={cafe}><ErrorBoundary area={tr('后台 · 列表')}><RunList shown={open && !history && !cafe} /></ErrorBoundary></div>
        {cafeSeen && <div className="bg-office-wrap" hidden={!cafe}><OfficeBlock follow={selected} controls={controls} /></div>}
        <LiveDrawer />
      </div>
      {/* 跑过的: mounted once shown, then only hidden (its list, its scroll, its replay stay) */}
      {historySeen && (
        <div className="over-body hx-body" hidden={!history}>
          <ErrorBoundary area={tr('后台 · 跑过的')}><HistoryView shown={open && history} /></ErrorBoundary>
        </div>
      )}
    </OverPage>
  );
}
