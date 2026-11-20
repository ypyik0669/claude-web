import { useState } from 'react';
import { useStore } from '@/store';
import { Composer } from '@/features/composer/Composer';
import { fillComposer } from '@/features/composer/fill';
import { Icon } from '@/ui/icons';
import { AppLogo } from '@/ui/AppLogo';
import { GREETING, STARTERS, firstTime, projectHasConversations } from '@/features/home/model';
import { Checklist } from '@/features/home/Checklist';
import { EngineNotice } from '@/features/home/EngineNotice';
import { MovedNotice } from '@/features/home/MovedNotice';
import { SidebarReveal, usePaneEdge } from './pane-edge';
import { tr } from '@/i18n';
import { LetterFlow } from '@/features/home/LetterFlow';
import { backdropOn } from '@/features/home/letter-flow';
import { Backdrop } from '@/themes/Backdrop';
import { useActivePack } from '@/themes/apply';
import { useOpeningBackdropOn } from '@/features/opening/OpeningBackdrop';

/**
 * The start page — an empty chat tile (redesign 2026-11 #pages 首页): Claude Web's own mark, 「今天想做点什么？」 and the
 * composer with its row (it creates the conversation in THIS tile). Nothing else stacked: three starters only while
 * the project in the box has no conversation yet (they only fill the box), the 入门清单 only the first time (no
 * conversation on this computer yet), the login / runtime notice only when something is wrong. The recent
 * conversations live in the sidebar (a phone's drawer). The background is still unless 外观 › 背景动画 is on.
 * Under the composer, once, for someone who used the old layout: 「东西搬到哪了」 (features/home/MovedNotice).
 */
export function Welcome({ paneId, tileId }: { paneId: string; tileId: string }) {
  const edge = usePaneEdge();
  const mobile = useStore((s) => s.mobile);
  // nothing until the settings are in: someone who turned it on would see the still page flash first
  const moving = useStore((s) => s.metaLoaded && backdropOn(s.settings));
  const theme = useStore((s) => s.theme);
  const ascii = useActivePack();
  // 放完留作背景 is on screen (features/opening): it shows through this page instead of 字流
  const openingBackdrop = useOpeningBackdropOn((s) => s.on);
  // the project the composer is about to start in (it reports it): the starters are for a project with no conversation
  const [proj, setProj] = useState<{ cwd: string; peer: string } | null>(null);
  const starters = useStore((s) => s.sessionsListed && !!proj && !projectHasConversations(proj, s.sessions, s.sessionMeta));
  const first = useStore((s) => firstTime({ listed: s.sessionsListed, sessions: s.sessions }));
  return (
    <div className="welcome-tile" data-home="">
      {/* 外观 → 背景动画 (off unless turned on): a character theme brings its own backdrop (themes/Backdrop); the classic themes get 字流 */}
      {!mobile && moving && ascii?.backdrop && <Backdrop scene="welcome" />}
      {/* keyed by the theme in effect (a system switch too): its colours are read when it starts */}
      {!mobile && moving && !ascii?.backdrop && !openingBackdrop && <LetterFlow key={String(theme)} />}
      {/* the empty page's top row: nothing but the sidebar reveal; on the desktop it is also the title bar (drag) */}
      <div className="welcome-top">{((edge.lead && !edge.strip) || mobile) && <SidebarReveal />}</div>
      <div className="welcome">
        <div className="home-col">
          {/* the app's own mark over the greeting (not the orange asterisk: #ia 「新对话页放自己的标志」) */}
          <div className="home-mark" aria-hidden><AppLogo size={mobile ? 36 : 40} /></div>
          <h1 className="greet">{GREETING}</h1>
          <Composer welcome target={{ paneId, tileId }} onProject={setProj} />
          {/* under the box on a desktop; on a phone the box sits at the bottom and these come above it (styles/phone.css) */}
          {starters && (
            <div className="starters" role="group" aria-label={tr('起手建议')}>
              {STARTERS.map((s) => (
                <button key={s.id} className="chip starter" data-starter={s.id} title={tr('填进输入框（不会直接发送）')} onClick={() => fillComposer({ tileId, text: s.text })}>
                  <Icon name={s.icon} size={mobile ? 16 : 14} />{s.label}
                </button>
              ))}
            </div>
          )}
          <EngineNotice />
          <MovedNotice />
          {first && <Checklist tileId={tileId} />}
        </div>
      </div>
    </div>
  );
}
