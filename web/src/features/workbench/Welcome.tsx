import { useStore } from '@/store';
import { Composer } from '@/features/composer/Composer';
import { fillComposer } from '@/features/composer/fill';
import { Icon } from '@/ui/icons';
import { STARTERS } from '@/features/home/model';
import { Checklist } from '@/features/home/Checklist';
import { EngineNotice } from '@/features/home/EngineNotice';
import { HomeLists } from '@/features/home/HomeLists';
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
          <HomeLists onOpen={pick} />
        </div>
      </div>
    </div>
  );
}
