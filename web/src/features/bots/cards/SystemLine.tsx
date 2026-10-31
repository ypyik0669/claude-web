// 值班 Bot thread: a system event — a centered small gray line (「已创建例行 ⏲ 早间简报」); with a detail it opens.
import { useState } from 'react';
import type { BotTimelineEntry } from '@shared';
import { Expandable } from '@/features/chat/Expandable';

const ICONS: Record<NonNullable<BotTimelineEntry['icon']>, string> = { routine: '⏲', rename: '✎', memory: '◆', policy: '⚑', profile: '☺', bot: '●' };

export function SystemLine({ entry }: { entry: BotTimelineEntry }) {
  const [open, setOpen] = useState(false);
  const text = `${entry.icon ? `${ICONS[entry.icon]} ` : ''}${entry.text ?? ''}`;
  return (
    <div className="bt-sys" data-icon={entry.icon}>
      {entry.detail
        ? <button className="bt-sys-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{text}</button>
        : <span className="bt-sys-line">{text}</span>}
      {open && entry.detail && (
        <div className="bt-sys-detail">
          <Expandable text={entry.detail} lines={20}>{(visible) => <pre>{visible}</pre>}</Expandable>
        </div>
      )}
    </div>
  );
}
