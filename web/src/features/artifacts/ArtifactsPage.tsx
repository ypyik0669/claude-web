// The Artifacts page (redesign 2026-11 stage 1): a whole page over the main area with what Claude wrote in the recent
// conversations here (`artifacts.list`: pages, documents, pictures, data still on disk), one card each — open it, go
// to the conversation it came from, publish it. The first, simple version: the Artifacts library of the plan (its own
// index, previews, sharing, other computers) replaces it in a later release.
import { useEffect, useMemo, useState } from 'react';
import type { ArtifactRef } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { ago, basename, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { OverPage, type OverTab } from '@/features/sections/OverPage';
import { fileMenuProps } from '@/features/files/FileMenu';
import { openPublish, openPublished } from '@/features/cloud/cloud-open';
import { ARTIFACTS_DESC, ARTIFACTS_TITLE, KIND_INFO, artifactKind, filterArtifacts, kindsOf, type ArtifactFilter } from './page';
import { closeArtifacts, useArtifacts } from './state';
import { tr } from '@/i18n';

/** The folder a file is in, shortened to its last two parts (the card's second line says where it lives). */
const where = (p: string) => p.replace(/\\/g, '/').split('/').slice(-3, -1).join('/');

export function ArtifactsPage() {
  const open = useArtifacts((s) => s.open);
  const openedAt = useArtifacts((s) => s.openedAt);
  const openTile = useStore((s) => s.openTile);
  const [items, setItems] = useState<ArtifactRef[] | null>(null);
  const [filter, setFilter] = useState<ArtifactFilter>('all');
  // read again on every open: a conversation may have written something since
  useEffect(() => {
    if (!open) return;
    let live = true;
    ws.request<{ items: ArtifactRef[] }>({ kind: 'artifacts.list' }).then((r) => { if (live) setItems(r.items ?? []); }).catch(() => { if (live) setItems((x) => x ?? []); });
    return () => { live = false; };
  }, [open, openedAt]);
  const kinds = useMemo(() => kindsOf(items ?? []), [items]);
  const shown = useMemo(() => filterArtifacts(items ?? [], kinds.includes(filter as never) ? filter : 'all'), [items, filter, kinds]);
  const tabs: OverTab[] = useMemo(() => [
    { id: 'all', label: tr('全部'), icon: 'works', count: items?.length ? <span className="n">{items.length}</span> : undefined },
    ...kinds.map((k) => ({ id: k, label: KIND_INFO[k].label, icon: KIND_INFO[k].icon, count: <span className="n">{(items ?? []).filter((a) => artifactKind(a.path) === k).length}</span> })),
  ], [items, kinds]);
  const goTo = (id: string) => {
    const st = useStore.getState();
    if (st.open[id]) st.setActive(id);
    else void st.loadHistory(id);
  };
  // opening a tile sends the main area somewhere: the page closes by itself (automation/state.ts installAutomation)
  const openFile = (path: string) => openTile({ id: `d${Date.now()}`, kind: 'doc', path }, 'tab');
  return (
    <OverPage
      name="arts"
      label={ARTIFACTS_TITLE}
      open={open}
      onClose={closeArtifacts}
      title={ARTIFACTS_TITLE}
      desc={ARTIFACTS_DESC}
      tab={filter}
      tabs={tabs}
      showTabs={kinds.length > 1}
      onTab={(t) => setFilter(t as ArtifactFilter)}
      actions={<button className="btn sm arts-published" data-act="published" title={tr('已发布的文件')} onClick={() => openPublished()}><Icon name="share" size={13} /><span className="l">{tr('已发布的文件')}</span></button>}
    >
      <div className="over-body arts-body">
        {!items ? <div className="arts-loading">{tr('加载中…')}</div> : !items.length ? <EmptyState e={EMPTY.artifactsPage} /> : (
          <div className="arts-grid">
            {shown.map((a) => {
              const k = artifactKind(a.path);
              const ext = /\.([a-z0-9]+)$/i.exec(a.path)?.[1]?.toUpperCase() ?? '';
              return (
                <div key={a.path} className={clsx('arts-card', `k-${k}`)} data-path={a.path} {...fileMenuProps(a.path, a.sessionId)}>
                  <button type="button" className="arts-open" title={a.path} onClick={() => openFile(a.path)}>
                    <span className="arts-th" aria-hidden><Icon name={KIND_INFO[k].icon} size={22} />{ext && <span className="x">{ext}</span>}</span>
                    <span className="arts-tx">
                      <span className="arts-n">{basename(a.path)}</span>
                      <span className="arts-d" title={a.path}>{ago(a.at)}{where(a.path) && <> · {where(a.path)}</>}</span>
                    </span>
                  </button>
                  <div className="arts-foot">
                    <button type="button" className="link arts-from" title={tr('打开那个对话')} onClick={() => goTo(a.sessionId)}><Icon name="chat" size={12} /><span>{a.title || tr('另一个对话')}</span></button>
                    <button type="button" className="icon-btn arts-share" data-act="publish" title={tr('发布…')} aria-label={tr('发布 {name}', { name: basename(a.path) })} onClick={() => openPublish(a.path)}><Icon name="share" size={14} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </OverPage>
  );
}
