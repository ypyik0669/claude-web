import type { BotStatus } from '@shared';
import type { BotTab } from './state';

/** The page's middle column: one bot's routines / runs / policy / memory / self. (Placeholder — Task 17 fills it.) */
export function BotDetail({ bot, tab }: { bot: BotStatus; tab: BotTab }) {
  return (
    <div className="bot-detail" data-tab={tab}>
      <h3 className="bd-name">{bot.name}</h3>
    </div>
  );
}
