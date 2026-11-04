import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { tr, trAs } from '@/i18n';

/**
 * Over the composer while 操控电脑 is on in this conversation: which applications the user let it operate (they go
 * with the process — a restart asks again), and 关掉, which takes the tools away from the next message on.
 */
export function ComputerPill({ sessionId, on }: { sessionId: string; on: boolean }) {
  const apps = useStore((s) => s.open[sessionId]?.info?.computerApps);
  const toast = useStore((s) => s.toast);
  if (!on) return null;
  const off = () => { void useStore.getState().setLiveFeatures(sessionId, { computerUse: false }).catch((e) => toast(e.message)); };
  return (
    <div className="cu-pill-row">
      <div className="cu-pill" data-id="computer-pill" role="status">
        <Icon name="machine" size={13} />
        <span className="cu-pill-t">
          {apps?.length ? tr('正在操控 · 已允许 {apps}', { apps: apps.join('、') }) : tr('操控电脑已开 · 要用哪个应用会先问你')}
        </span>
        <button type="button" className="cu-pill-off" onClick={off} title={tr('关掉操控电脑：从下一句起不再能操作应用，已允许的也一并收回')}>{trAs('关掉', 'Turn off')}</button>
      </div>
    </div>
  );
}
