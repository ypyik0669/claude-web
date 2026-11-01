// 项目页 (stage C2 编辑项目 + stage F2): one dialog, four tabs.
// 设置 — the name, the folders (the main one first, not removable; extra ones added with the folder picker, removed
// with ×) and 从侧栏移除项目; 说明 — the project's instructions (appended to every conversation in the project), the
// sessions tools' project scope and the permission mode 派活 uses; 资料 — files dropped here live in
// `~/.claude-web/projects/<id>/` and the project's conversations can read them; 对话 — this project's conversations.
// 设置 / 说明 are saved together through `workspaces.update` (a folder that no longer exists is refused by the server:
// toast, the dialog stays); 资料 act at once. Opened from the project's ··· menu (`openProjectDialog`).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PermissionMode, ProjectFile, Workspace } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { trapTab } from '@/ui/focus-trap';
import { MODE_LABEL, PERMISSION_MODE_ORDER } from '@/ui/terms';
import { tr } from '@/i18n';
import { projectSessions, uploadTo } from '@/features/cloud/logic';
import { isWinPath, samePath } from './project-paths';

import { useProjectDialog, type ProjectTab } from './project-dialog-open';
import { Select } from '@/ui/Select';
import { SwitchLine } from '@/ui/Switch';
import { pickFolder } from '@/ui/pick-folder';
// opening it lives in project-dialog-open.ts (this module is loaded on first open — review X1)
export { openProjectDialog, type ProjectTab } from './project-dialog-open';
const close = () => useProjectDialog.setState({ id: null });

const TABS: { id: ProjectTab; label: () => string }[] = [
  { id: 'settings', label: () => tr('设置') },
  { id: 'instructions', label: () => tr('说明') },
  { id: 'files', label: () => tr('资料') },
  { id: 'conversations', label: () => tr('对话') },
];
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function ProjectDialogHost() {
  const id = useProjectDialog((s) => s.id);
  const w = useStore((s) => (id ? s.workspaces.find((x) => x.id === id) : undefined));
  if (!id || !w) return null;
  return <ProjectDialog key={w.id} w={w} />;
}

function ProjectFiles({ w }: { w: Workspace }) {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = (t: string) => useStore.getState().toast(t);
  const load = () => ws.request<{ dir: string; files: ProjectFile[] }>({ kind: 'projects.files.list', workspaceId: w.id }).then((r) => { setFiles(r.files); setDir(r.dir); }, (e) => toast(e.message));
  useEffect(() => { void load(); }, [w.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (list: FileList | File[]) => {
    setBusy(true);
    try {
      for (const f of Array.from(list)) await uploadTo(`api/project-files?workspaceId=${encodeURIComponent(w.id)}&name=${encodeURIComponent(f.name)}`, f);
    } catch (e: any) { toast(e.message); }
    setBusy(false);
    void load();
  };
  const remove = async (name: string) => {
    if (!(await dlg.confirm(tr('删除资料「{name}」？', { name }), { danger: true }))) return;
    await ws.request<{ files: ProjectFile[] }>({ kind: 'projects.files.remove', workspaceId: w.id, name }).then((r) => setFiles(r.files), (e) => toast(e.message));
  };
  return (
    <div className="pj-files" data-id="project-files">
      <div
        className={`pj-drop${over ? ' over' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) void add(e.dataTransfer.files); }}
      >
        <Icon name="attach" size={16} />
        <span>{busy ? tr('正在上传…') : tr('把文件拖到这里')}</span>
        <button className="btn sm" data-act="add-files" disabled={busy} onClick={() => input.current?.click()}>{tr('选择文件…')}</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ''; }} />
      </div>
      {files === null ? <div className="dialog-msg">{tr('加载中…')}</div> : files.length === 0 ? <div className="dialog-msg">{tr('还没有资料')}</div> : (
        <ul className="pj-folders">
          {files.map((f) => (
            <li key={f.name} className="pj-folder" title={f.name}>
              <Icon name="files" size={14} /><span className="pj-path">{f.name}</span><span className="pj-tag">{kb(f.size)}</span>
              <button className="icon-btn" data-act="remove-file" aria-label={tr('删除 {name}', { name: f.name })} title={tr('删除 {name}', { name: f.name })} onClick={() => void remove(f.name)}><Icon name="close" size={12} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-msg pj-note">
        <div>{tr('这个项目里的对话都能读这些文件（单个文件上限 20 MB）。')}</div>
        {dir && <div className="pj-path" title={dir}>{dir}</div>}
      </div>
    </div>
  );
}

function ProjectConversations({ w }: { w: Workspace }) {
  const sessions = useStore((s) => s.sessions);
  const meta = useStore((s) => s.sessionMeta);
  const list = useMemo(() => projectSessions(sessions, w, meta), [sessions, meta, w]);
  const open = (sessionId: string, cwd: string) => { close(); void useStore.getState().openSession({ sessionId, cwd }); };
  if (!list.length) return <div className="dialog-msg" data-id="project-conversations">{tr('这个项目里还没有对话')}</div>;
  return (
    <ul className="pj-convs" data-id="project-conversations">
      {list.slice(0, 200).map((s) => (
        <li key={s.sessionId}>
          <button className="pj-conv" onClick={() => open(s.sessionId, s.cwd)} title={s.title}>
            <span className="pj-path">{s.title}</span>
            <span className="pj-tag">{new Date(s.lastModified).toLocaleDateString()}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ProjectDialog({ w }: { w: Workspace }) {
  const tab = useProjectDialog((s) => s.tab);
  const [name, setName] = useState(w.name);
  const [folders, setFolders] = useState<string[]>(w.folders ?? []);
  const [instructions, setInstructions] = useState(w.instructions ?? '');
  const [scoped, setScoped] = useState(w.sessionsScope === 'project');
  const [mode, setMode] = useState<PermissionMode | ''>(w.permissionMode ?? '');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dirty = name !== w.name || JSON.stringify(folders) !== JSON.stringify(w.folders ?? [])
    || instructions !== (w.instructions ?? '') || scoped !== (w.sessionsScope === 'project') || mode !== (w.permissionMode ?? '');
  useEffect(() => { if (tab === 'settings') setTimeout(() => nameRef.current?.focus(), 0); }, [tab]);
  const toast = (t: string) => useStore.getState().toast(t);
  const setTab = (t: ProjectTab) => useProjectDialog.setState({ tab: t });

  const add = async () => {
    const failed = (e: unknown) => { toast(e instanceof Error ? e.message : String(e)); return null; };
    const p = await pickFolder({ start: w.path }).catch(failed);
    if (!p) return;
    const win = isWinPath(w.path);
    if ([w.path, ...folders].some((f) => samePath(f, p, win))) { toast(tr('这个文件夹已经在项目里了')); return; }
    setFolders((f) => [...f, p]);
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await useStore.getState().updateWorkspace(w.id, { name: name.trim() || w.name, folders, instructions, sessionsScope: scoped ? 'project' : null, permissionMode: mode || null });
      close();
    } catch {
      /* toasted by the store; the dialog stays */
    } finally {
      setBusy(false);
    }
  };
  // a click beside the box with edits not saved asks first (Esc and 取消 are deliberate: they just close)
  const backdrop = async () => { if (!dirty || (await dlg.confirm(tr('放弃没保存的改动？'), { danger: true }))) close(); };
  const remove = async () => {
    if (!(await dlg.confirm(tr('从侧栏移除「{name}」？', { name: w.name }), { message: tr('只移除侧栏里的这条记录，不动磁盘上的文件。'), danger: true }))) return;
    await ws.request({ kind: 'workspaces.remove', id: w.id }).then(close, (e) => toast(e.message));
  };
  const saves = tab === 'settings' || tab === 'instructions';

  return (
    <div className="modal-bg dialog-bg" data-id="project-dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) void backdrop(); }} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); close(); } else trapTab(e, boxRef.current); }}>
      <div ref={boxRef} className="modal dialog project-dialog" role="dialog" aria-modal="true" aria-label={tr('项目页')} data-id="project-page">
        <h3>{tr('项目「{name}」', { name: w.name })}</h3>
        <div className="pj-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`pj-tab${tab === t.id ? ' on' : ''}`} data-tab={t.id} onClick={() => setTab(t.id)}>{t.label()}</button>
          ))}
        </div>
        <div hidden={tab !== 'settings'}>
          <label className="pj-label" htmlFor="pj-name">{tr('名字')}</label>
          <input id="pj-name" ref={nameRef} className="field" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) void save(); }} />
          <div className="pj-label">{tr('源文件夹')}</div>
          <ul className="pj-folders">
            <li className="pj-folder main" title={w.path}><Icon name="folder" size={14} /><span className="pj-path">{w.path}</span><span className="pj-tag">{tr('主文件夹')}</span></li>
            {folders.map((f) => (
              <li key={f} className="pj-folder" title={f}>
                <Icon name="folder" size={14} /><span className="pj-path">{f}</span>
                <button className="icon-btn" data-act="remove-folder" aria-label={tr('移除 {path}', { path: f })} title={tr('移除 {path}', { path: f })} onClick={() => setFolders((l) => l.filter((x) => x !== f))}><Icon name="close" size={12} /></button>
              </li>
            ))}
          </ul>
          <button className="btn sm" data-act="add-folder" onClick={() => void add()}><Icon name="plus" size={12} /> {tr('添加文件夹')}</button>
          <div className="dialog-msg pj-note">
            <div>{tr('新开的对话会同时看到这些文件夹；正在运行的对话下次打开时生效。')}</div>
          </div>
        </div>
        <div hidden={tab !== 'instructions'}>
          <label className="pj-label" htmlFor="pj-instr">{tr('项目说明')}</label>
          <textarea id="pj-instr" className="field pj-instructions" rows={8} maxLength={20000} value={instructions} placeholder={tr('比如：用 pnpm；回答用中文；改完跑 npm test')} onChange={(e) => setInstructions(e.target.value)} />
          <div className="dialog-msg pj-note"><div>{tr('这个项目里的每个对话都会带上这段说明；正在运行的对话下次打开时生效。')}</div></div>
          <SwitchLine className="pj-check" data-act="scope" on={scoped} onChange={setScoped}>{tr('跨对话工具只看见本项目的对话')}</SwitchLine>
          <label className="pj-label" htmlFor="pj-mode">{tr('派活用的权限模式')}</label>
          <Select id="pj-mode" className="field" label={tr('派活用的权限模式')} value={mode} onValueChange={(v) => setMode(String(v) as PermissionMode | '')}>
            <option value="">{tr('跟新对话的默认一样')}</option>
            {PERMISSION_MODE_ORDER.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </Select>
        </div>
        <div hidden={tab !== 'files'}>{tab === 'files' && <ProjectFiles w={w} />}</div>
        <div hidden={tab !== 'conversations'}>{tab === 'conversations' && <ProjectConversations w={w} />}</div>
        <div className="actions">
          {tab === 'settings' && <button className="btn danger ghost pj-remove" data-act="remove-project" onClick={() => void remove()}>{tr('从侧栏移除项目')}</button>}
          <span className="grow" />
          <button className="btn" onClick={close}>{saves ? tr('取消') : tr('关闭')}</button>
          {saves && <button className="btn primary" data-act="save" disabled={busy} onClick={() => void save()}>{tr('保存')}</button>}
        </div>
      </div>
    </div>
  );
}
