import { useEffect, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { clsx } from '@/util';
import { sessionPeer } from '@/features/peers';
import { TERMS } from '@/ui/terms';
import { Icon } from '@/ui/icons';
import { FileTree } from './FileTree';
import { SearchView } from './SearchView';
import { Artifacts, useArtifacts } from './Artifacts';
import { useGitStatus } from './git-status';
import { useRightPanel } from './right-panel';

/** The last open request (`useRightPanel().explorer.n`) the right panel's 文件 applied (each is applied once). */
let appliedIntent = 0;

/**
 * 文件 (redesign phase 2, spec §5.6): the project's file tree and the text search / replace in one tab, switched at
 * the top (文件 · 搜索), with this conversation's generated files (Write / Artifact) as a group above the tree.
 * Both halves stay mounted once shown (`hidden`), so the tree's open folders and the search's query / results
 * survive switching back and forth; the search mounts the first time it is asked for (it focuses its box).
 * `inDock`: the right panel's own copy, the one the open requests (··· 文件 / 搜索 / 生成的文件) go to.
 */
export function FilesView({ visible, inDock }: { visible: boolean; inDock?: boolean }) {
  const active = useScopedSession();
  const sessions = useStore((s) => s.sessions);
  const sid = active?.sessionId ?? null;
  const cwd = active?.cwd ?? '';
  const peer = sessionPeer(sid, sessions);
  const [mode, setMode] = useState<'tree' | 'search'>('tree');
  const [searched, setSearched] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  /** 生成的文件 was asked for (··· / the palette): the group shows even when there are none yet */
  const [askedArtifacts, setAskedArtifacts] = useState(false);
  const artifacts = useArtifacts(sid);
  const gitStatus = useGitStatus(cwd, visible && mode === 'tree' && !peer);

  const intent = useRightPanel((s) => s.explorer);
  useEffect(() => {
    if (!inDock || !intent || intent.n <= appliedIntent) return;
    appliedIntent = intent.n;
    if (intent.mode === 'search') { setMode('search'); setSearched(true); }
    else setMode('tree');
    if (intent.mode === 'artifacts') { setShowArtifacts(true); setAskedArtifacts(true); }
  }, [intent?.n]);
  // another conversation: its own generated files (an empty group is shown only when it was asked for)
  const [shownSid, setShownSid] = useState(sid);
  if (shownSid !== sid) { setShownSid(sid); setAskedArtifacts(false); }

  if (!active) return <div className="empty">还没有打开对话。打开一个对话后，这里是它所在项目的文件。</div>;
  if (peer) return <div className="empty">这个对话在机器「{peer.name}」上，它的文件在那台机器上。</div>;
  const pick = (m: 'tree' | 'search') => { setMode(m); if (m === 'search') setSearched(true); };
  return (
    <div className="files-view">
      <div className="fv-head">
        <span className="seg" role="tablist" aria-label="文件或搜索">
          <button role="tab" aria-selected={mode === 'tree'} className={clsx(mode === 'tree' && 'active')} onClick={() => pick('tree')}>文件</button>
          <button role="tab" aria-selected={mode === 'search'} className={clsx(mode === 'search' && 'active')} onClick={() => pick('search')}>搜索</button>
        </span>
      </div>
      <div className="fv-body" hidden={mode !== 'tree'}>
        {(artifacts.length > 0 || askedArtifacts) && (
          <div className={clsx('fv-group', showArtifacts && 'open')}>
            <button className="fv-group-head" aria-expanded={showArtifacts} onClick={() => setShowArtifacts(!showArtifacts)}>
              <Icon name={showArtifacts ? 'chevronDown' : 'chevronRight'} size={12} />
              <span className="grow">本对话{TERMS.artifacts}</span>
              <span className="n">{artifacts.length}</span>
            </button>
            {showArtifacts && (artifacts.length
              ? <Artifacts sessionId={sid!} compact />
              : <div className="fv-empty">还没有生成的文件。Claude 新建的文件（Write / Artifact）之后会出现在这里。</div>)}
          </div>
        )}
        <FileTree root={cwd} gitStatus={gitStatus} />
      </div>
      {searched && <div className="fv-body" hidden={mode !== 'search'}><SearchView root={cwd} /></div>}
    </div>
  );
}
