import { SyncPanel } from '@/features/sync/SyncPanel';
import { RemoteSyncPanel } from '@/features/sync/RemoteSyncPanel';
import { tr } from '@/i18n';

/** 备份 (spec §6.12): the providers, model settings and privacy rules, to a file or a remote store. */
export function SettingsPage() {
  return (
    <div className="hub-body">
      <div className="hub-settings">
        <section className="hub-card">
          <div className="hd"><h3>{tr('备份与同步')}</h3></div>
          <div className="bd">
            <RemoteSyncPanel />
            <div style={{ height: 10 }} />
            <SyncPanel />
          </div>
        </section>
      </div>
    </div>
  );
}
