// 自动化 › Bot › 设置 (界面改版 2026-11 阶段 2, spec #ia: 「Bot 的几项挪到 自动化 › Bot › 设置」): the settings of all
// bots — the rows that were 设置 › 通用 › 值班 Bot — drawn with the settings' own row and controls (EntryRow), so they
// look and save the same. The roster's gear opens it; so do the old settings ids of these rows (`openSettings({
// reveal: 'bots.…' })`) and the settings search, which lands here with the row highlighted.
import { useEffect, useRef } from 'react';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { BOT_ENTRIES } from '@/features/settings/catalog';
import { EntryRow } from '@/features/settings/SettingsModal';
import { useBots } from './state';

export function BotSettings({ shown }: { shown: boolean }) {
  const reveal = useBots((s) => s.settingsReveal);
  const box = useRef<HTMLDivElement>(null);
  // a row asked for: into view once the view is on screen (it is mounted hidden before that)
  useEffect(() => {
    if (!shown || !reveal) return;
    box.current?.querySelector(`[data-entry="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: 'center' });
  }, [shown, reveal]);
  return (
    <div className="bot-settings" ref={box} data-id="bot-settings">
      <div className="bs-head">
        <Icon name="settings" size={16} />
        <h2>{tr('设置')}</h2>
      </div>
      <p className="bs-lead">{tr('所有 Bot 共用的设置：同时跑几个、每天花多少、默认用哪个来源，以及关了窗口要不要接着值班。每个 Bot 自己的在它的资料里。')}</p>
      <div className="sp-card">
        {BOT_ENTRIES.map((e) => <EntryRow key={e.id} e={e} area={tr('自动化 · Bot · 设置')} reveal={reveal} />)}
      </div>
    </div>
  );
}
