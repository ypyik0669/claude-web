// 附件卡片 (2026-11-17): a file / folder / pasted text in the row over the composer's text, the way the official
// desktop app shows them — its name (or, for a reference by path, the path) on two lines at most, a type label
// (MD / PDF / 文件夹) and its size under it, × at the top right. Pictures keep their thumbnails (Composer.tsx).
import { fmtSize } from '@/model/attachments';
import { Icon } from '@/ui/icons';
import { tr, trAs } from '@/i18n';
import { extLabel, shortPath } from './attach-card';

export interface AttachmentCardProps {
  kind: 'file' | 'folder' | 'text';
  name: string;
  /** a reference by its path on this disk (a pasted folder / file in the desktop app): shown instead of the name */
  path?: string;
  size?: number;
  /** an uploaded folder: how many of its files go */
  count?: number;
  /** the hover text (default: the whole path, else the name) */
  title?: string;
  onRemove(): void;
}

export function AttachmentCard({ kind, name, path, size, count, title, onRemove }: AttachmentCardProps) {
  const label = kind === 'folder' ? trAs('文件夹', 'Folder') : extLabel(name) || tr('文件');
  const meta = count !== undefined ? tr('{n} 个文件', { n: count }) : fmtSize(size);
  const hover = title ?? (path ? `${path}\n${tr('按路径引用，不上传：Claude 直接读这台电脑上的它')}` : name);
  return (
    <span className="att-card" data-att={kind} data-ref={path ? '' : undefined} title={hover}>
      <span className="att-card-name">{path ? shortPath(path) : name}</span>
      <span className="att-card-meta">
        <span className="att-card-type">{kind === 'folder' && <Icon name="folder" size={11} />}{label}</span>
        {meta && <span className="sz">{meta}</span>}
      </span>
      <button type="button" className="att-card-x" onClick={onRemove} title={tr('移除')} aria-label={tr('移除 {name}', { name })}><Icon name="close" size={10} /></button>
    </span>
  );
}
