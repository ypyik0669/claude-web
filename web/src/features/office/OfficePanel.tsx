// The right panel's 网吧: the same cafe, small, on the zone of the conversation in front. A customer opens its own
// conversation on the 后台 page (there is room for it there); the lead is the conversation itself.
import { lazy, Suspense } from 'react';
import { useStore } from '@/store';
import { openAgent, openBackground } from '@/features/background/state';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { tr } from '@/i18n';

const Office = lazy(() => import('./Office').then((m) => ({ default: m.Office })));

export function OfficePanel() {
  const sid = useStore((s) => s.activeId);
  return (
    <div className="office-panel">
      <ErrorBoundary area={tr('网吧')}>
        <Suspense fallback={null}>
          <Office
            compact
            follow={sid ?? undefined}
            onOpenAgent={(s, taskId, agentKey) => { if (openBackground(s, taskId)) openAgent({ sessionId: s, taskId, agentKey }); }}
            onOpenChat={(s) => useStore.getState().openInPane(s, 'replace')}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
