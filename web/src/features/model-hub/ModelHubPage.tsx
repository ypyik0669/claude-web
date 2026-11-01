import { OverPage } from '@/features/sections/OverPage';
import { HUB_TITLE, hubPage } from './page';
import { closeHub, useHub } from './state';
import { ControlPage } from './pages/ControlPage';
import { UsagePage } from './pages/UsagePage';
import { PrivacyPage } from './pages/PrivacyPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * The hub: one left rail entry (`gateway`, labelled 用量与隐私), four first-level pages. The pages are mounted once
 * they have been seen and then only hidden — a scroll position and a half-filled form survive a page switch.
 */
export function ModelHubPage() {
  const open = useHub((s) => s.open);
  const page = useHub((s) => s.page);
  const seen = useHub((s) => s.seen);
  const def = hubPage(page);
  return (
    <OverPage
      name="hub"
      label={HUB_TITLE}
      open={open}
      onClose={closeHub}
      title={def.title}
      desc={def.desc}
      tab={page}
      tabs={[]}
      showTabs={false}
      onTab={() => {}}
    >
      {seen.includes('usage') && <div className="hub-pane" hidden={page !== 'usage'}><UsagePage /></div>}
      {seen.includes('privacy') && <div className="hub-pane" hidden={page !== 'privacy'}><PrivacyPage /></div>}
      {seen.includes('control') && <div className="hub-pane" hidden={page !== 'control'}><ControlPage /></div>}
      {seen.includes('settings') && <div className="hub-pane" hidden={page !== 'settings'}><SettingsPage /></div>}
    </OverPage>
  );
}
