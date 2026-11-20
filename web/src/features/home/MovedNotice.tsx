import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { MOVED_NOTICE_KEY, movedLines, showMovedNotice } from './moved-notice';

/**
 * The start page's one-time 「东西搬到哪了」 card (2026-11 redesign): a short where-it-went list for people who used the
 * old layout, dismissed for good with 知道了 (meta.json, `ui.movedNoticeSeen`). See `moved-notice.ts`.
 */
export function MovedNotice() {
  const metaLoaded = useStore((s) => s.metaLoaded);
  const seen = useStore((s) => s.settings[MOVED_NOTICE_KEY] === true);
  const onboarded = useStore((s) => s.settings.onboarded === true);
  const projects = useStore((s) => s.workspaces.length);
  const mobile = useStore((s) => s.mobile);
  if (!showMovedNotice({ metaLoaded, seen, onboarded, projects })) return null;
  const dismiss = () => void useStore.getState().setSetting(MOVED_NOTICE_KEY, true);
  return (
    <section className="moved-notice" aria-labelledby="moved-notice-h" data-id="moved-notice">
      <div className="mn-head">
        <Icon name="sparkle" size={16} />
        <h2 id="moved-notice-h">{tr('东西搬到哪了')}</h2>
      </div>
      <p className="mn-sub">{tr('这一版界面做了减法，入口少了，东西都还在：')}</p>
      <dl className="mn-list">
        {movedLines(mobile).map((l) => (
          <div key={l.id} className="mn-row" data-id={l.id}>
            <dt>{l.from}</dt>
            <dd>{l.to}</dd>
          </div>
        ))}
      </dl>
      <div className="mn-acts">
        <button type="button" className="btn sm primary" data-act="dismiss" onClick={dismiss}>{tr('知道了')}</button>
      </div>
    </section>
  );
}
