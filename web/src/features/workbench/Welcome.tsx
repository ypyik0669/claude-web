import { useMemo } from 'react';
import { useStore } from '@/store';
import { Composer } from '@/features/composer/Composer';
import { fillComposer } from '@/features/composer/fill';
import { Icon } from '@/ui/icons';
import { CHECKLIST_KEY, STARTERS } from '@/features/home/model';
import { Checklist } from '@/features/home/Checklist';
import { EngineNotice } from '@/features/home/EngineNotice';
import { HomeLists } from '@/features/home/HomeLists';
import { DiscoveryHint } from '@/features/sidebar/hint';
import { hintReady } from '@/features/sidebar/newcomer';
import { SidebarReveal, usePaneEdge } from './pane-edge';

/**
 * The start page — an empty chat tile (spec §5.8, mock-home.png): 「今天想做点什么？」 · the composer (it creates the
 * conversation in THIS tile, on the project used last) · four starters (they only fill the box) · the login / runtime
 * notice when something is wrong · the 入门清单 · 最近任务 / 定时任务 / 已归档.
 */
export function Welcome({ paneId, tileId }: { paneId: string; tileId: string }) {
  const open = useStore((s) => s.open);
  const loadHistory = useStore((s) => s.loadHistory);
  const dispatch = useStore((s) => s.dispatchLayout);
  const edge = usePaneEdge();
  const mobile = useStore((s) => s.mobile);
  const pick = (sid: string) => {
    dispatch({ t: 'session.assign', paneId, tileId, sessionId: sid });
    if (!open[sid]) void loadHistory(sid, { focus: false });
  };
  return (
    <div className="welcome-tile">
      {/* the empty page's top row: nothing but the sidebar reveal; on the desktop it is also the title bar (drag) */}
      <div className="welcome-top">{((edge.lead && !edge.strip) || mobile) && <SidebarReveal />}</div>
      <div className="welcome">
        <div className="home-col">
          <h1 className="greet"><span className="spark"><Icon name="claude" size={26} /></span>今天想做点什么？</h1>
          <Composer welcome target={{ paneId, tileId }} />
          <div className="starters" role="group" aria-label="起手建议">
            {STARTERS.map((s) => (
              <button key={s.id} className="chip starter" data-starter={s.id} title="填进输入框（不会直接发送）" onClick={() => fillComposer({ tileId, text: s.text })}>
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
