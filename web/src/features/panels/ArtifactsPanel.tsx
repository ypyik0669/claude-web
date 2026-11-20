import { useMemo } from 'react';
import { useScopedSession, useStore } from '@/store';
import { basename } from '@/util';
import { Icon } from '@/ui/icons';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { blockRemoteOpen } from '@/features/remote-guard';
import { useArtifacts } from '@/features/workbench/Artifacts';
import { KIND_INFO, artifactKind, isArtifactPath } from '@/features/artifacts/page';
import { openArtifacts } from '@/features/artifacts/state';
import { tr } from '@/i18n';

/** This conversation's Artifacts: the pages, documents, pictures and data it wrote (the Artifacts page's kinds). */
export function useConversationArtifacts(sessionId: string | null | undefined): { path: string; via: string }[] {
  const all = useArtifacts(sessionId);
  return useMemo(() => all.filter((a) => isArtifactPath(a.path)), [all]);
}

/**
 * The right panel's 「Artifacts」 (redesign 2026-11: the picker at the panel's top-left, a phone's ⋯ six-grid): what this
 * conversation made, newest first; a row opens it in a document tab (the full Artifact viewer — versions, comments,
 * sharing — is a later release), and the page with every conversation's is one link away.
 */
export function ArtifactsPanel() {
  const active = useScopedSession();
  const sid = active?.sessionId ?? null;
  const items = useConversationArtifacts(sid);
  const openTile = useStore((s) => s.openTile);
  const where = (p: string) => p.replace(/\\/g, '/').split('/').slice(-3, -1).join('/');
  return (
    <div className="arts-panel">
      {!items.length ? <EmptyState e={EMPTY.artifacts} /> : (
        <div className="arts-panel-list" role="list">
          {items.map((a) => {
            const k = artifactKind(a.path);
            return (
              <button key={a.path} type="button" role="listitem" className="arts-panel-row" data-path={a.path} title={a.path}
                onClick={() => { if (!sid || !blockRemoteOpen(sid, a.path)) openTile({ id: `d${Date.now()}`, kind: 'doc', path: a.path }, 'tab'); }}>
                <span className="arts-th" aria-hidden><Icon name={KIND_INFO[k].icon} size={18} /></span>
                <span className="arts-tx"><span className="arts-n">{basename(a.path)}</span><span className="arts-d">{KIND_INFO[k].label}{where(a.path) && <> · {where(a.path)}</>}</span></span>
              </button>
            );
          })}
        </div>
      )}
      <div className="arts-panel-foot">
        <button type="button" className="link" onClick={() => openArtifacts()}><Icon name="works" size={13} /> {tr('所有对话的 Artifacts')}</button>
      </div>
    </div>
  );
}
