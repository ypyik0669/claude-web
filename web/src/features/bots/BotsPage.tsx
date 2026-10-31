// 值班 Bot（spec 2026-10-31 聊天优先 §1 / §6）: the page over the main area. A desktop: three columns — the roster
// (always there, whether the app's sidebar is open or not), the conversation with the chosen bot, and its profile at
// the right when asked for; no page head row (the roster's head says Bot, the conversation's head is the bot). A
// phone: three screens — the roster, the conversation (or the New Bot page), the profile — all mounted, one shown.
// No bot yet (the manager aside): the New Bot page.
import { useEffect, useMemo } from 'react';
import { useStore } from '@/store';
import { OverPage } from '@/features/sections/OverPage';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { BotAvatar } from './BotAvatar';
import { BotProfile } from './BotProfile';
import { BotThread } from './BotThread';
import { NewBot } from './NewBot';
import { Roster } from './Roster';
import { rosterGroups } from './model';
import { soleBot } from './roster-model';
import { closeBots, setPhoneScreen, showProfile, useBots } from './state';

/** Esc from inside the page: the profile first, then the New Bot page (back to a conversation), then a phone's screens. */
export function botsEscape(): boolean {
  const s = useBots.getState();
  const mobile = useStore.getState().mobile;
  const hasBot = !!s.selected && s.bots.some((b) => b.id === s.selected);
  if (mobile) {
    if (s.phoneScreen === 'profile') { showProfile(false); return true; }
    if (s.phoneScreen === 'thread') { setPhoneScreen('roster'); return true; }
    return false;
  }
  if (s.profileOpen && s.view === 'thread' && hasBot) { showProfile(false); return true; }
  if (s.view === 'new' && hasBot) { useBots.setState({ view: 'thread' }); return true; }
  return false;
}

export function BotsPage() {
  const open = useBots((s) => s.open);
  const bots = useBots((s) => s.bots);
  const inbox = useBots((s) => s.inbox);
  const selected = useBots((s) => s.selected);
  const view = useBots((s) => s.view);
  const phoneScreen = useBots((s) => s.phoneScreen);
  const profileOpen = useBots((s) => s.profileOpen);
  const mobile = useStore((s) => s.mobile);
  const bot = useMemo(() => bots.find((b) => b.id === selected), [bots, selected]);
  const own = useMemo(() => bots.some((b) => !b.manager), [bots]);
  // the New Bot page: asked for, or nothing chosen and no bot of your own yet
  const showNew = view === 'new' || (!bot && !own);

  // a desktop opens on a conversation, never on an empty column: the first in the roster's order (who needs you first)
  useEffect(() => {
    if (!open || mobile || bot || view !== 'thread' || !own) return;
    const g = rosterGroups(bots, inbox);
    const first = g.attention[0] ?? g.rest[0] ?? g.hidden[0];
    if (first) useBots.setState({ selected: first.id });
  }, [open, mobile, bot, view, own, bots, inbox]);

  // a phone with one bot of its own: straight into its conversation, also when the list arrives after the page opened
  // (openBots does it when it is already known); once a bot is chosen the roster stays reachable with 返回
  useEffect(() => {
    if (!open || !mobile || selected || phoneScreen !== 'roster') return;
    const only = soleBot(bots);
    if (only) useBots.setState({ selected: only, view: 'thread', phoneScreen: 'thread' });
  }, [open, mobile, selected, phoneScreen, bots]);

  const thread = bot && <BotThread bot={bot} />;
  return (
    <OverPage
      name="bots"
      label={tr('Bot')}
      open={open}
      onClose={closeBots}
      title={tr('Bot')}
      desc={tr('住在你电脑里的值班队友')}
      tab=""
      tabs={[]}
      showTabs={false}
      onTab={() => {}}
      onEscape={botsEscape}
      head={false}
    >
      {mobile ? (
        <div className="bots-phone" data-screen={phoneScreen}>
          <div className="bots-ph-screen" data-screen="roster" hidden={phoneScreen !== 'roster'}><Roster phone /></div>
          <div className="bots-ph-screen" data-screen="profile" hidden={phoneScreen !== 'profile'}>
            <div className="bots-ph-bar">
              <button className="btn sm ghost" aria-label={tr('返回对话')} onClick={() => showProfile(false)}><Icon name="chevronLeft" size={14} />{bot?.name ?? tr('返回')}</button>
            </div>
            <div className="bots-ph-body">{bot && <BotProfile bot={bot} shown={open && phoneScreen === 'profile'} />}</div>
          </div>
          <div className="bots-ph-screen" data-screen="thread" hidden={phoneScreen !== 'thread'}>
            <div className="bots-ph-bar">
              <button className="btn sm ghost" aria-label={tr('返回名册')} onClick={() => setPhoneScreen('roster')}><Icon name="chevronLeft" size={14} />{tr('名册')}</button>
              <span className="grow" />
              {bot && !showNew && (
                <button className="icon-btn bots-ph-face" title={tr('资料')} aria-label={tr('资料')} onClick={() => showProfile(true)}>
                  <BotAvatar name={bot.name} avatar={bot.avatar} size={26} />
                </button>
              )}
            </div>
            <div className="bots-ph-body" hidden={showNew}>{thread}</div>
            <div className="bots-ph-body" hidden={!showNew}><NewBot /></div>
          </div>
        </div>
      ) : (
        <div className="bots-body">
          <div className="bots-col bots-col-roster"><Roster /></div>
          <div className="bots-col bots-col-thread" hidden={showNew}>{thread}</div>
          <div className="bots-col bots-col-new" hidden={!showNew}><NewBot /></div>
          <div className="bots-col bots-col-profile" hidden={showNew || !profileOpen || !bot}>{bot && <BotProfile bot={bot} shown={open && !showNew && profileOpen} />}</div>
        </div>
      )}
    </OverPage>
  );
}
