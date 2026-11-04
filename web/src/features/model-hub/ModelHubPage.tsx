import { OverPage } from '@/features/sections/OverPage';
import { useGateway } from '@/features/gateway/state';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { HUB_TITLE, hubPage } from './page';
import { closeHub, useHub } from './state';
import { OverviewPage } from './pages/OverviewPage';
import { SourcesPage } from './pages/SourcesPage';
import { RoutingPage } from './pages/RoutingPage';
import { UsagePage } from './pages/UsagePage';
import { PrivacyPage } from './pages/PrivacyPage';
import { PluginsPage } from './pages/PluginsPage';
import { AgentsPage } from './pages/AgentsPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * The model hub: one left rail entry (`gateway`, labelled 模型), nine first-level pages. The pages are mounted once
 * they have been seen and then only hidden — a scroll position and a half-filled form survive a page switch.
 */
export function ModelHubPage() {
  const open = useHub((s) => s.open);
  const page = useHub((s) => s.page);
  const seen = useHub((s) => s.seen);
  const status = useGateway((s) => s.status);
  const accounts = useGateway((s) => s.accounts.length);
  const toast = useStore((s) => s.toast);
  const def = hubPage(page);
  const on = status?.enabled === true;
  const refresh = async () => {
    try { await useGateway.getState().load(); toast(tr('已刷新'), true); } catch (e: any) { toast(e.message); }
  };
  const actions = (
    <div className="hub-head-actions">
      <span className={`hub-pill ${on ? 'ok' : 'off'}`}><span className="dot" />{on ? tr('网关运行中') : tr('网关未启用')}</span>
      <span className="hub-count">{tr('{n} 个账号', { n: accounts })}</span>
      <button className="icon-btn" title={tr('刷新')} aria-label={tr('刷新')} onClick={() => void refresh()}>
        <Icon name="refresh" size={15} />
      </button>
    </div>
  );
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
      actions={actions}
    >
      {seen.includes('overview') && <div className="hub-pane" hidden={page !== 'overview'}><OverviewPage /></div>}
      {seen.includes('sources') && <div className="hub-pane" hidden={page !== 'sources'}><SourcesPage /></div>}
      {seen.includes('routing') && <div className="hub-pane" hidden={page !== 'routing'}><RoutingPage /></div>}
      {seen.includes('usage') && <div className="hub-pane" hidden={page !== 'usage'}><UsagePage /></div>}
      {seen.includes('privacy') && <div className="hub-pane" hidden={page !== 'privacy'}><PrivacyPage /></div>}
      {seen.includes('plugins') && <div className="hub-pane" hidden={page !== 'plugins'}><PluginsPage /></div>}
      {seen.includes('agents') && <div className="hub-pane" hidden={page !== 'agents'}><AgentsPage /></div>}
      {seen.includes('settings') && <div className="hub-pane" hidden={page !== 'settings'}><SettingsPage /></div>}
    </OverPage>
  );
}
