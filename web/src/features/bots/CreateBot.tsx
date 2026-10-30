import { tr } from '@/i18n';

/** The create flow. (Placeholder — Task 18 fills it.) */
export function CreateBot({ onClose }: { onClose: () => void }) {
  return (
    <div className="bot-create" role="dialog" aria-label={tr('新建 Bot')}>
      <span>{tr('新建 Bot')}</span>
      <button className="btn sm" onClick={onClose}>{tr('取消')}</button>
    </div>
  );
}
