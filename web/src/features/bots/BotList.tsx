import { useEffect, useRef, useState } from 'react';
import type { BotStatus } from '@shared';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { Menu } from '@/features/sidebar/menus';
import { useCafe } from '@/features/cafe/state';
import { bakeCharacter } from '@/features/cafe/bake';
import { tr } from '@/i18n';
import { stateLabel, usd } from './model';
import { deleteBot, pauseBot, runNow, selectBot, stopBot, unleashBot } from './state';

/** A cafe character standing still when `avatar` names one, else the name's first letter. */
export function BotAvatar({ bot }: { bot: BotStatus }) {
  const def = useCafe((s) => (bot.avatar ? s.byId.get(bot.avatar) : undefined));
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c || !def) return;
    c.clearRect(0, 0, 26, 26);
    c.drawImage(bakeCharacter(def, undefined, 'se', 'stand', 0) as CanvasImageSource, 1, 1);
  }, [def]);
  if (def) return <canvas className="bot-avatar" ref={ref} width={26} height={26} aria-hidden />;
  return <span className="bot-avatar letter" aria-hidden>{[...bot.name.trim()][0] ?? '?'}</span>;
}

/** A bot's actions: pause / continue, stop what runs, run a routine now, 放开全部 / 收回, delete. */
export function BotMenu({ bot, onClose }: { bot: BotStatus; onClose: () => void }) {
  const [routines, setRoutines] = useState(false);
  const act = (fn: () => unknown) => () => { onClose(); void fn(); };
  const remove = async () => {
    if (await dlg.confirm(tr('删除 Bot「{name}」？', { name: bot.name }), { danger: true, focusCancel: true, okLabel: tr('删除') })) void deleteBot(bot.id);
  };
  const unleashed = !!bot.policy.unleashed;
  // 放开全部 turns every gate off (spec §10): say what it will now do unasked; 收回 just goes
  const unleash = async () => {
    if (!unleashed && !(await dlg.confirm(tr('放开「{name}」的全部限制？', { name: bot.name }), { message: tr('放开后，它在你不在时也会直接对外发送、付款和不可恢复地删除，不再先问你；只有停止和审计还在。'), danger: true, focusCancel: true, okLabel: tr('放开全部') }))) return;
    void unleashBot(bot.id, !unleashed);
  };
  return (
    <Menu onClose={onClose} label={bot.name} className="bot-menu" align="right">
      <button data-id="pause" onClick={act(() => pauseBot(bot.id, !bot.paused))}><Icon name={bot.paused ? 'play' : 'pause'} size={14} /> {bot.paused ? tr('继续') : tr('暂停')}</button>
      {(bot.state === 'running' || bot.state === 'queued') && <button data-id="stop" onClick={act(() => stopBot(bot.id))}><Icon name="stop" size={14} /> {tr('停止')}</button>}
      <button data-id="run" onClick={() => setRoutines(!routines)} aria-expanded={routines}><Icon name="bolt" size={14} /> <span style={{ flex: 1 }}>{tr('立即运行')}</span><Icon name={routines ? 'chevronDown' : 'chevronRight'} size={12} /></button>
      {routines && (
        <div className="sub-menu">
          {bot.routines.map((r) => <button key={r.id} data-routine={r.id} onClick={act(() => runNow(bot.id, r.id))}>{r.name}</button>)}
          {!bot.routines.length && <div className="menu-note">{tr('还没有例行任务')}</div>}
        </div>
      )}
      <button data-id="unleash" onClick={act(unleash)}><Icon name={unleashed ? 'lock' : 'shield'} size={14} /> {unleashed ? tr('收回') : tr('放开全部')}</button>
      {!bot.manager && <button data-id="delete" className="danger" onClick={act(remove)}><Icon name="trash" size={14} /> {tr('删除…')}</button>}
    </Menu>
  );
}

function BotRow({ bot, on }: { bot: BotStatus; on: boolean }) {
  const [menu, setMenu] = useState(false);
  const trust = Object.keys(bot.trust).length;
  return (
    <div
      className={clsx('bot-row', on && 'on', bot.manager && 'manager')}
      data-id={bot.id}
      role="button"
      tabIndex={0}
      aria-current={on ? 'true' : undefined}
      onClick={() => selectBot(bot.id)}
      onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBot(bot.id); } }}
      onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
    >
      <BotAvatar bot={bot} />
      <div className="bot-main">
        <div className="bot-line">
          <span className="bot-name">{bot.name}</span>
          {bot.manager && <span className="bot-tag">{tr('总管')}</span>}
          {bot.policy.unleashed && <span className="badge err" title={tr('已放开全部限制')}>{tr('无闸')}</span>}
          <span className="grow" />
          <span className="bot-state" data-state={bot.state}>{stateLabel(bot.state)}</span>
        </div>
        <div className="bot-line sub">
          <span className="bot-role">{bot.charter.role}</span>
          <span className="grow" />
          {trust > 0 && <span className="bot-trust" title={tr('已信任 {n} 类操作', { n: trust })}>{Array.from({ length: Math.min(trust, 7) }, (_, i) => <i key={i} />)}</span>}
          <span className="bot-cost" title={tr('今天的花费')}>{usd(bot.todayUsd)}</span>
        </div>
      </div>
      <span className="bot-more">
        <button className="icon-btn" title={tr('更多')} aria-label={tr('更多')} aria-haspopup="menu" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><Icon name="more" size={14} /></button>
        {menu && <BotMenu bot={bot} onClose={() => setMenu(false)} />}
      </span>
    </div>
  );
}

/** The page's left column: every bot, the manager first. */
export function BotList({ bots, selected }: { bots: BotStatus[]; selected?: string }) {
  return (
    <div className="bot-list" role="list" aria-label={tr('Bot')}>
      {bots.map((b) => <BotRow key={b.id} bot={b} on={b.id === selected} />)}
    </div>
  );
}
