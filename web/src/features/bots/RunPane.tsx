import type { BotStatus } from '@shared';

/** The page's right column: the bot's current / latest run. (Placeholder — Task 17 fills it.) */
export function RunPane({ bot }: { bot: BotStatus }) {
  return (
    <div className="bot-run-pane">
      <div className="rp-name">{bot.name}</div>
    </div>
  );
}
