import { SectionSide } from '@/features/sections/SectionSide';
import { tr } from '@/i18n';
import { HUB_PAGES, HUB_TITLE, type HubPageId } from './page';
import { showHubPage, useHub } from './state';

/** The sidebar while the hub is in front: one row per first-level page. */
export function ModelHubSide() {
  const page = useHub((s) => s.page);
  return (
    <SectionSide
      name="hub"
      title={HUB_TITLE}
      tab={page}
      onTab={(id) => showHubPage(id as HubPageId)}
      tabs={HUB_PAGES.map((p) => ({ id: p.id, label: p.label, icon: p.icon, title: p.desc }))}
    >
      <div className="sect-note">{tr('用量、隐私规则和备份都只在这台电脑上。')}</div>
    </SectionSide>
  );
}
