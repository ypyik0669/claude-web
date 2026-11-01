import { useEffect, useMemo, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { clsx } from '@/util';
import { sessionPeer } from '@/features/peers';
import { EMPTY, TERMS } from '@/ui/terms';
import { EmptyState } from '@/ui/EmptyState';
import { Icon } from '@/ui/icons';
import { FileTree } from './FileTree';
import { SearchView } from './SearchView';
import { Artifacts, useArtifacts } from './Artifacts';
import { useGitStatus } from './git-status';
import { useRightPanel, previewFile, closePreview, activatePreview, type PreviewFile } from './right-panel';
import { DocTile } from './tiles/DocTile';
import { basename } from '@/util';
import { dlg } from '@/ui/dialog';
import { tr } from '@/i18n';
import { AllArtifacts } from './AllArtifacts';
import { RootGroups } from './RootGroups';
import { projectRoots } from '@/features/paths';
import { walkTools } from '@/model/conversation';
import { desktop } from '@/desktop';
import { keyLabel, SHORTCUTS } from './shortcuts';
import { openExplorer } from './right-panel';
import { touchedFiles } from './touched-files';

/** The last open request (`useRightPanel().explorer.n`) the right panel's 文件 applied (each is applied once). */
let appliedIntent = 0;

/**
 * 文件 (redesign phase 2, spec §5.6): the project's file tree and the text search / replace in one tab, switched at
 * the top (文件 · 搜索), with this conversation's generated files (Write / Artifact) as a group above the tree.
 * Both halves stay mounted once shown (`hidden`), so the tree's open folders and the search's query / results
 * survive switching back and forth; the search mounts the first time it is asked for (it focuses its box).
 * `inDock`: the right panel's own copy, the one the open requests (··· 文件 / 搜索 / 生成的文件) go to.
 * Files opened from the tree, the search, the chat's links (`previewFile`) show in that copy's preview on the left,
 * the tree as a column on the right (like the official app); the tree column can be hidden (`ui.filesTreeHidden`).
 */
export function FilesView({ visible, inDock }: { visible: boolean; inDock?: boolean }) {
  const active = useScopedSession();
  const sessions = useStore((s) => s.sessions);
  const sid = active?.sessionId ?? null;
  const cwd = active?.cwd ?? '';
  // a project with extra folders: a group per folder (stage C2)
  const workspaces = useStore((s) => s.workspaces);
  // a conversation without a folder: the one picked in the empty state, browsed here only (stage E4)
  const [browseRoot, setBrowseRoot] = useState('');
  const roots = useMemo(() => projectRoots(cwd || browseRoot, workspaces), [cwd, browseRoot, workspaces]);
  const peer = sessionPeer(sid, sessions);
  const [mode, setMode] = useState<'tree' | 'search'>('tree');
  const [searched, setSearched] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  /** 生成的文件 was asked for (··· / the palette): the group shows even when there are none yet */
  const [askedArtifacts, setAskedArtifacts] = useState(false);
  const artifacts = useArtifacts(sid);
  // 本对话的文件 (stage E4): what Claude read or changed here, first time first
  const conv = useStore((s) => (sid ? s.open[sid]?.conv : undefined));
  const version = useStore((s) => (sid ? s.open[sid]?.version : undefined));
  const touched = useMemo(() => (conv ? touchedFiles([...walkTools(conv.items)].filter((x) => x.depth === 0).map((x) => ({ name: x.tool.name, input: x.tool.input }))) : []), [conv, version]);
  const [showTouched, setShowTouched] = useState(true);
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

  const previews = useRightPanel((s) => s.preview);
  const treeHidden = useStore((s) => s.settings['ui.filesTreeHidden'] === true);
  const withPreview = !!inDock && previews.files.length > 0;
  const preview = withPreview && <PreviewPane files={previews.files} active={previews.active} treeHidden={treeHidden} />;

  if (!active) return preview ? <div className={clsx('files-view with-preview', treeHidden && 'tree-hidden')}>{preview}</div> : <EmptyState e={EMPTY.filesNoChat} />;
  if (peer) return <div className="empty">{tr('这个对话在机器「{name}」上，它的文件在那台机器上。', { name: peer.name })}</div>;
  const pick = (m: 'tree' | 'search') => { setMode(m); if (m === 'search') setSearched(true); };
  const searchKey = keyLabel(SHORTCUTS.find((x) => x.id === 'files.search')!);
  // 打开文件: the desktop's own file box; a browser has none — go to the search instead
  const openFile = async () => {
    const p = desktop?.pickFile ? await desktop.pickFile() : null;
    if (p) previewFile(p);
    else if (!desktop?.pickFile) pick('search');
  };
  return (
    <div className={clsx('files-view', withPreview && 'with-preview', withPreview && treeHidden && 'tree-hidden')}>
      {preview}
      <div className="fv-side" hidden={withPreview && treeHidden}>
      <div className="fv-head">
        <span className="seg" role="tablist" aria-label={tr('文件或搜索')}>
          <button role="tab" aria-selected={mode === 'tree'} className={clsx(mode === 'tree' && 'active')} onClick={() => pick('tree')}>{tr('文件')}</button>
          <button role="tab" aria-selected={mode === 'search'} className={clsx(mode === 'search' && 'active')} onClick={() => pick('search')}>{tr('搜索')}</button>
        </span>
      </div>
      <div className="fv-body" hidden={mode !== 'tree'}>
        <div className={clsx('fv-group fv-touched', showTouched && 'open')}>
          <button className="fv-group-head" aria-expanded={showTouched} onClick={() => setShowTouched(!showTouched)}>
            <Icon name={showTouched ? 'chevronDown' : 'chevronRight'} size={12} />
            <span className="grow">{tr('本对话的文件')}</span>
            <span className="n">{touched.length}</span>
          </button>
          {showTouched && (touched.length
            ? <div className="fv-touched-list">{touched.map((p) => (
                <button key={p} className="fv-touched-it" title={p} onClick={() => previewFile(p)}>
                  <Icon name="files" size={12} /><span className="grow">{p.split(/[\/]/).pop()}</span>
                </button>
              ))}</div>
            : <EmptyState e={EMPTY.filesSession} action={<>
                <button className="btn sm" onClick={() => void openFile()}>{tr('打开文件')}</button>
                <button className="btn sm" onClick={() => openExplorer('search')}>{tr('搜索文件')} <kbd>{searchKey}</kbd></button>
              </>} />)}
        </div>
        {(artifacts.length > 0 || askedArtifacts) && (
          <div className={clsx('fv-group', showArtifacts && 'open')}>
            <button className="fv-group-head" aria-expanded={showArtifacts} onClick={() => setShowArtifacts(!showArtifacts)}>
              <Icon name={showArtifacts ? 'chevronDown' : 'chevronRight'} size={12} />
              <span className="grow">{tr('本对话{artifacts}', { artifacts: TERMS.artifacts })}</span>
              <span className="n">{artifacts.length}</span>
            </button>
            {showArtifacts && (artifacts.length
              ? <Artifacts sessionId={sid!} compact />
              : <div className="fv-empty">{tr('还没有生成的文件。Claude 新建的文件（Write / Artifact）之后会出现在这里。')}</div>)}
          </div>
        )}
        <AllArtifacts />
        {roots.length ? <RootGroups roots={roots}>{(r) => <FileTree root={r} gitStatus={r === cwd ? gitStatus : undefined} />}</RootGroups> : <FileTree root="" onPickRoot={setBrowseRoot} />}
      </div>
      {searched && <div className="fv-body" hidden={mode !== 'search'}><RootGroups roots={roots}>{(r) => <SearchView root={r} />}</RootGroups></div>}
      </div>
    </div>
  );
}

/** The previewed files: a tab per file and the tree's show / hide switch; every preview stays mounted (`hidden`). */
function PreviewPane({ files, active, treeHidden }: { files: PreviewFile[]; active: string | null; treeHidden: boolean }) {
  const close = async (f: PreviewFile) => {
    if (useStore.getState().dirtyDocs[f.id] && !(await dlg.confirm(tr('「{name}」还没保存，仍然关闭？', { name: basename(f.path) }), { danger: true }))) return;
    closePreview(f.id);
  };
  const toggleTree = () => void useStore.getState().setSetting('ui.filesTreeHidden', !treeHidden);
  return (
    <div className="fv-preview">
      <div className="fv-ptabs" role="tablist" aria-label={tr('预览的文件')}>
        <div className="fv-ptab-list">
          {files.map((f) => (
            <div key={f.id} role="tab" aria-selected={f.id === active} className={clsx('fv-ptab', f.id === active && 'active')} title={f.path}
              onClick={() => activatePreview(f.id)} onAuxClick={(e) => { if (e.button === 1) void close(f); }}>
              <Icon name="files" size={12} />
              <span className="nm">{basename(f.path)}</span>
              <button className="x" aria-label={tr('关闭')} title={tr('关闭')} onClick={(e) => { e.stopPropagation(); void close(f); }}><Icon name="close" size={11} /></button>
            </div>
          ))}
        </div>
        <button className={clsx('icon-btn fv-tree-toggle', !treeHidden && 'on')} aria-pressed={!treeHidden} onClick={toggleTree}
          title={treeHidden ? tr('显示文件树') : tr('隐藏文件树')} aria-label={treeHidden ? tr('显示文件树') : tr('隐藏文件树')}>
          <Icon name="sidebar" size={14} />
        </button>
      </div>
      {files.map((f) => (
        <div key={f.id} className="fv-pdoc" hidden={f.id !== active}>
          <DocTile tile={{ id: f.id, kind: 'doc', path: f.path, line: f.line }} />
        </div>
      ))}
    </div>
  );
}
