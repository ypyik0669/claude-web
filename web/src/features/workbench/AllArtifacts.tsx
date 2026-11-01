// 生成的文件 across conversations (spec 2026-10-16 pages §6): what Claude wrote in the recent conversations here — pages,
// documents, pictures, data still on disk — each with the conversation it came from. Loaded when the group is opened.
import { useEffect, useState } from 'react';
import type { ArtifactRef } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { fileMenuProps } from '@/features/files/FileMenu';
import { openPublish, openPublished } from '@/features/cloud/cloud-open';
import { previewFile } from './right-panel';

export function AllArtifacts() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ArtifactRef[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    ws.request<{ items: ArtifactRef[] }>({ kind: 'artifacts.list' }).then((r) => { if (live) setItems(r.items ?? []); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [open]);
  const goTo = (id: string) => {
    const st = useStore.getState();
    if (st.open[id]) st.setActive(id);
    else void st.loadHistory(id);
  };
  return (
    <div className={clsx('fv-group', 'all-artifacts', open && 'open')}>
      <button className="fv-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span className="grow">{tr('最近所有对话生成的文件')}</span>
        {items && <span className="n">{items.length}</span>}
      </button>
      {open && (!items ? <div className="fv-empty">{tr('加载中…')}</div> : !items.length ? <div className="fv-empty">{tr('最近的对话里还没有生成网页、文档、图片这类文件。')}</div> : (
        <div className="list">
          <button className="sub link-btn all-arts-published" data-act="published" onClick={() => openPublished()}><Icon name="share" size={12} /> {tr('已发布的文件')}</button>
          {items.map((a) => (
            <div key={a.path} className="row clickable" title={a.path} {...fileMenuProps(a.path)}
              onClick={() => previewFile(a.path)}>
              <span><Icon name="read" size={13} /></span>
              <div className="grow">
                <div>{basename(a.path)}</div>
                <button className="sub link-btn" onClick={(e) => { e.stopPropagation(); goTo(a.sessionId); }} title={tr('打开那个对话')}>{a.title || tr('另一个对话')}</button>
              </div>
              <button className="icon-btn" data-act="publish" title={tr('发布…')} aria-label={tr('发布 {name}', { name: basename(a.path) })} onClick={(e) => { e.stopPropagation(); openPublish(a.path); }}><Icon name="share" size={13} /></button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
