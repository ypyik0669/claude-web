// 值班 Bot 名册（spec 2026-10-31 聊天优先 §1 / §6）: every bot as a contact — face, name and 职位, its last line, the
// time, and a dot for what it wants. 需要你 on top, the manager ★, the hidden ones folded at the bottom. On a desktop it
// is the Bot page's own first column (there whether the app's sidebar is open or not — the sidebar shows the
// conversations while the page is in front); on a phone it is the page's first screen.
import { useMemo, useState } from 'react';
import type { BotStatus } from '@shared';
import { Menu } from '@/features/sidebar/menus';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { EMPTY, emptyText } from '@/ui/terms';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { BotAvatar, type BotAvatarState } from './BotAvatar';
import { lastLineOf, pendingByBot, rowState, usd } from './model';
import { rosterView, rowTime } from './roster-model';
import { deleteBot, openThread, pauseBot, showNewBot, stopAll, updateBot, useBots } from './state';

function faceState(b: BotStatus): BotAvatarState {
  const s = rowState(b);
  return s === 'attention' || s === 'error' || s === 'working' ? s : 'idle';
}

/** 置顶 / 隐藏 / 暂停 / 删除 (the manager can't be hidden or deleted). */
function RowMenu({ bot, onClose }: { bot: BotStatus; onClose: () => void }) {
  const act = (fn: () => unknown) => () => { onClose(); void fn(); };
  const remove = async () => {
    if (await dlg.confirm(tr('删除 Bot「{name}」？', { name: bot.name }), { message: tr('它的例行、记忆和对话都会删掉。'), danger: true, focusCancel: true, okLabel: tr('删除') })) void deleteBot(bot.id);
  };
  return (
    <Menu onClose={onClose} label={bot.name} className="bot-menu" align="right">
      <button data-id="pin" onClick={act(() => updateBot(bot.id, { pinned: !bot.pinned }))}><Icon name={bot.pinned ? 'pinOff' : 'pin'} size={14} /> {bot.pinned ? tr('取消置顶') : tr('置顶')}</button>
      {!bot.manager && <button data-id="hide" onClick={act(() => updateBot(bot.id, { hidden: !bot.hidden }))}><Icon name="eye" size={14} /> {bot.hidden ? tr('不再隐藏') : tr('隐藏')}</button>}
      <button data-id="pause" onClick={act(() => pauseBot(bot.id, !bot.paused))}><Icon name={bot.paused ? 'play' : 'pause'} size={14} /> {bot.paused ? tr('继续') : tr('暂停')}</button>
      {!bot.manager && <button data-id="delete" className="danger" onClick={act(remove)}><Icon name="trash" size={14} /> {tr('删除…')}</button>}
    </Menu>
  );
}

function Row({ bot, pending, on }: { bot: BotStatus; pending: number; on: boolean }) {
  const [menu, setMenu] = useState(false);
  const st = rowState(bot);
  const open = () => void openThread(bot.id);
  return (
    <div
      className={clsx('bot-row', on && 'on', bot.manager && 'manager')}
      data-id={bot.id}
      data-state={st}
      role="button"
      tabIndex={0}
      aria-current={on ? 'true' : undefined}
      onClick={open}
      onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
    >
      <BotAvatar name={bot.name} avatar={bot.avatar} size={34} state={faceState(bot)} />
      <div className="br-main">
        <div className="br-line">
          <span className="br-name">{bot.name}</span>
          {bot.manager && <span className="br-star" title={tr('总管')} aria-label={tr('总管')}>★</span>}
          {bot.title && <span className="br-title">{bot.title}</span>}
          <span className="grow" />
          <span className="br-time">{rowTime(bot.lastLine?.at)}</span>
        </div>
        <div className="br-line sub">
          <span className="br-last">{lastLineOf(bot, pending)}</span>
          <span className="grow" />
          {st === 'attention' && <span className="br-count" title={tr('需要你')}>{pending || bot.pendingInbox || ''}</span>}
          {st === 'fresh' && <span className="br-dot" title={tr('有新结果')} />}
          {bot.paused && <Icon name="pause" size={12} />}
        </div>
      </div>
      <span className="bot-more">
        <button className="icon-btn" title={tr('更多')} aria-label={tr('更多')} aria-haspopup="menu" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><Icon name="more" size={14} /></button>
        {menu && <RowMenu bot={bot} onClose={() => setMenu(false)} />}
      </span>
    </div>
  );
}

/** One line under the list: what runs, what waits, today's cost — and 全部停 while something goes. */
function LoadLine() {
  const load = useBots((s) => s.load);
  const going = load.running + load.queued > 0;
  const stop = async () => { if (await dlg.confirm(tr('停下所有 Bot？'))) void stopAll(); };
  return (
    <div className="bots-load" role="status">
      <span className="bl-text">{tr('在跑 {running} · 排队 {queued} · 今天 {today}', { running: load.running, queued: load.queued, today: usd(load.todayUsd) })}</span>
      <span className="grow" />
      {going && <button className="btn sm ghost" onClick={() => void stop()}><Icon name="stop" size={12} />{tr('全部停')}</button>}
    </div>
  );
}

/** The roster's body: the search box, then the groups. */
function RosterBody({ phone }: { phone?: boolean }) {
  const bots = useBots((s) => s.bots);
  const inbox = useBots((s) => s.inbox);
  const selected = useBots((s) => s.selected);
  const view = useBots((s) => s.view);
  const [q, setQ] = useState('');
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const v = useMemo(() => rosterView(bots, inbox, q), [bots, inbox, q]);
  const pending = useMemo(() => pendingByBot(inbox), [inbox]);
  const pinned = useMemo(() => (phone ? bots.filter((b) => b.pinned && !b.hidden) : []), [bots, phone]);
  const row = (b: BotStatus) => <Row key={b.id} bot={b} pending={pending[b.id] ?? 0} on={view === 'thread' && b.id === selected} />;
  return (
    <div className="bot-roster" data-phone={phone ? '' : undefined}>
      <div className="br-search">
        <Icon name="search" size={14} />
        <input
          className="field"
          type="search"
          value={q}
          placeholder={tr('搜索 Bot')}
          aria-label={tr('搜索 Bot')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (imeComposing(e.nativeEvent)) return; if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); } }}
        />
      </div>
      {pinned.length > 0 && (
        <div className="br-pinned" aria-label={tr('置顶')}>
          {pinned.map((b) => (
            <button key={b.id} className="br-pin" title={b.name} onClick={() => void openThread(b.id)}>
              <BotAvatar name={b.name} avatar={b.avatar} size={40} state={faceState(b)} />
              <span>{b.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="br-list" role="list" aria-label={tr('Bot')}>
        {v.attention.length > 0 && (
          <section className="br-group" data-group="attention">
            <div className="br-group-h">{tr('需要你 ({n})', { n: v.attention.length })}</div>
            {v.attention.map(row)}
          </section>
        )}
        {v.rest.length > 0 && <section className="br-group" data-group="rest">{v.rest.map(row)}</section>}
        {v.manager && <section className="br-group" data-group="manager">{row(v.manager)}</section>}
        {v.hiddenCount > 0 && (
          <section className="br-group" data-group="hidden">
            <button className="br-group-h br-fold" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen(!hiddenOpen)}>
              <Icon name={hiddenOpen ? 'chevronDown' : 'chevronRight'} size={12} />{tr('隐藏的 Bot ({n})', { n: v.hiddenCount })}
            </button>
            {hiddenOpen && v.hidden.map(row)}
          </section>
        )}
        {!v.shown && !v.hiddenCount && <div className="br-none">{q.trim() ? tr('没有找到') : emptyText(EMPTY.bots)}</div>}
      </div>
      <LoadLine />
    </div>
  );
}

/** The roster: its head (Bot, ＋ 新 Bot), the search box, the groups, the load line. `phone`: the page's first screen
 *  (the pinned bots as faces on top); else the desktop page's first column. */
export function Roster({ phone }: { phone?: boolean }) {
  return (
    <div className={phone ? 'bots-phone-roster' : 'bots-roster-col'}>
      <div className="br-top">
        {/* a phone's page head already says Bot: the roster's own title would say it twice */}
        {!phone && <span className="sect-title">{tr('Bot')}</span>}
        <span className="grow" />
        <button className="icon-btn" title={tr('新 Bot')} aria-label={tr('新 Bot')} data-act="new-bot" onClick={showNewBot}><Icon name="plus" size={16} /></button>
      </div>
      <RosterBody phone={phone} />
    </div>
  );
}
