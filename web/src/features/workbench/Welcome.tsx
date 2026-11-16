import { useMemo } from 'react';
import { useOpenSettled, useStore } from '@/store';
import { Composer } from '@/features/composer/Composer';
import { fillComposer } from '@/features/composer/fill';
import { Icon } from '@/ui/icons';
import { CHECKLIST_KEY, GREETING, STARTERS } from '@/features/home/model';
import { Checklist } from '@/features/home/Checklist';
import { EngineNotice } from '@/features/home/EngineNotice';
import { HomeLists } from '@/features/home/HomeLists';
import { DiscoveryHint } from '@/features/sidebar/hint';
import { hintReady } from '@/features/sidebar/newcomer';
import { SidebarReveal, usePaneEdge } from './pane-edge';
import { tr } from '@/i18n';
import { LetterFlow } from '@/features/home/LetterFlow';
import { backdropOn } from '@/features/home/letter-flow';
import { Backdrop } from '@/themes/Backdrop';
import { useActivePack } from '@/themes/apply';

/**
 * The start page — an empty chat tile (spec §5.8, mock-home.png): 「今天想做点什么？」 · the composer (it creates the
 * conversation in THIS tile, on the project used last) · four starters (they only fill the box) · the login / runtime
 * notice when something is wrong · the 入门清单 · 最近任务 / 定时任务 / 已归档.
 */
export function Welcome({ paneId, tileId }: { paneId: string; tileId: string }) {
  const open = useOpenSettled(); // not for each frame of a stream
  const loadHistory = useStore((s) => s.loadHistory);
  const dispatch = useStore((s) => s.dispatchLayout);
  const edge = usePaneEdge();
  const mobile = useStore((s) => s.mobile);
  // nothing until the settings are in: someone who turned it off would see the default flash for a second
  const moving = useStore((s) => s.metaLoaded && backdropOn(s.settings));
  const theme = useStore((s) => s.theme);
  const ascii = useActivePack();
  const pick = (sid: string) => {
    dispatch({ t: 'session.assign', paneId, tileId, sessionId: sid });
    if (!open[sid]) void loadHistory(sid, { focus: false });
  };
  return (
    <div className="welcome-tile">
      {/* 外观 → 背景动画: a character theme brings its own backdrop (themes/Backdrop); the classic themes get 字流 */}
      {!mobile && moving && ascii?.backdrop && <Backdrop scene="welcome" />}
      {/* keyed by the theme in effect (a system switch too): its colours are read when it starts */}
      {!mobile && moving && !ascii?.backdrop && <LetterFlow key={String(theme)} />}
      {/* the empty page's top row: nothing but the sidebar reveal; on the desktop it is also the title bar (drag) */}
      <div className="welcome-top">{((edge.lead && !edge.strip) || mobile) && <SidebarReveal />}</div>
      <div className="welcome">
        <div className="home-col">
          <h1 className="greet"><span className="spark"><Icon name="claude" size={26} /></span>{GREETING}</h1>
          <Composer welcome target={{ paneId, tileId }} />
          <div className="starters" role="group" aria-label={tr('起手建议')}>
            {STARTERS.map((s) => (
              <button key={s.id} className="chip starter" data-starter={s.id} title={tr('填进输入框（不会直接发送）')} onClick={() => fillComposer({ tileId, text: s.text })}>
                <Icon name={s.icon} size={14} />{s.label}
              </button>
            ))}
          </div>
          <EngineNotice />
          <Checklist tileId={tileId} />
          <HomeDiscovery />
          <HomeLists onOpen={pick} />
        </div>
      </div>
    </div>
  );
}

/** 对话库 discovery (Codex, OpenCode… found on this machine, not joined) while the sidebar still holds it back for the checklist. */
function HomeDiscovery() {
  const sources = useStore((s) => s.librarySources);
  const sidebarShows = useStore((s) => hintReady(s.settings[CHECKLIST_KEY], Date.now()));
  const pending = useMemo(() => sources.filter((x) => x.kind !== 'claude' && x.detected && !x.joined && !x.dismissed), [sources]);
  if (!pending.length || sidebarShows) return null;
  return <DiscoveryHint pending={pending} home />;
}
