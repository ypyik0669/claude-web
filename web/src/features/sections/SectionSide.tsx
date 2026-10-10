import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import type { OverTab } from './OverPage';

/**
 * The sidebar column while a page section is in front (spec 2026-10-10-ui-structure §2.2): the section's name, its
 * one action, and its parts as rows — what the page itself shows as tabs where this column is not on screen. Under
 * the rows, whatever the section lists (`children`).
 */
export function SectionSide({ name, title, tab, tabs, onTab, action, children }: {
  /** `auto` / `ext`: prefixes the class the rows are found by (`auto-side`) */
  name: string;
  title: string;
  tab: string;
  tabs: OverTab[];
  onTab(id: string): void;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={clsx('sect-side', `${name}-side`)} data-tab={tab}>
      <div className="sect-top">
        <span className="sect-title">{title}</span>
        {action}
      </div>
      <nav className="sect-nav" aria-label={title}>
        {tabs.map((t) => (
          <button key={t.id} className={clsx('nav', tab === t.id && 'active')} data-id={t.id} aria-current={tab === t.id ? 'page' : undefined} title={t.title} onClick={() => onTab(t.id)}>
            <Icon name={t.icon} size={16} />
            <span className="l">{t.label}</span>
            {t.count}
          </button>
        ))}
      </nav>
      {children && <div className="sect-list">{children}</div>}
    </div>
  );
}
