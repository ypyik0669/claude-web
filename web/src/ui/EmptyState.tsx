import type { ReactNode } from 'react';
import { clsx } from '@/util';
import { emptyText, type EmptyTerm } from './terms';

/**
 * An empty list / panel (spec §5.8): the one sentence 「还没有 X。Y 之后会出现在这里。」 (`EMPTY` in ui/terms.ts) and
 * at most one button under it.
 */
export function EmptyState({ e, action, className }: { e: EmptyTerm; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('empty empty-state', className)} role="status">
      <div className="es-text">{emptyText(e)}</div>
      {action && <div className="es-act">{action}</div>}
    </div>
  );
}
