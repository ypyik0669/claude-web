// 文件右键菜单 (spec 2026-10-16 sessions-env §5; the official app's: Attach as context / Open in / Show in Explorer /
// Copy path): one menu for every file path on screen — tool cards, the change card, 审阅, the file tree. Opened at the
// pointer by `fileMenuProps(path, sessionId)` spread on the element; mounted once (App).
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { parsePeerId } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { Popover } from '@/features/composer/Popover';
import { mentionInComposer } from '@/features/composer/fill';
import { openPublish } from '@/features/cloud/cloud-open';

type Editor = 'code' | 'cursor' | 'zed';
const EDITOR_NAME: Record<Editor, string> = { code: 'VS Code', cursor: 'Cursor', zed: 'Zed' };

interface At { path: string; sessionId?: string; x: number; y: number }
const useFileMenu = create<{ at: At | null }>(() => ({ at: null }));

let editors: Promise<Editor[]> | null = null;
const loadEditors = () => (editors ??= (ws.request({ kind: 'shell.editors' }) as Promise<{ editors: Editor[] }>).then((r) => r.editors ?? []).catch(() => { editors = null; return []; }));

/** Spread on whatever shows a file path: right-click opens the menu there. */
export function fileMenuProps(path: string, sessionId?: string | null): { onContextMenu: (e: React.MouseEvent) => void } {
  return {
    onContextMenu: (e) => {
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      useFileMenu.setState({ at: { path, sessionId: sessionId ?? undefined, x: e.clientX, y: e.clientY } });
    },
  };
}

/** Opens the menu for `path` at a point (ui-smoke uses it; everything else spreads fileMenuProps). */
export const openFileMenuAt = (path: string, x: number, y: number, sessionId?: string) => useFileMenu.setState({ at: { path, sessionId, x, y } });

export function FileMenu() {
  const at = useFileMenu((s) => s.at);
  const anchor = useRef<HTMLSpanElement>(null);
  const [eds, setEds] = useState<Editor[]>([]);
  useEffect(() => { if (at) void loadEditors().then(setEds); }, [at]);
  if (!at) return null;
  // a conversation on another machine: this path is on that disk — nothing here can open it
  const remote = !!at.sessionId && !!parsePeerId(at.sessionId);
  const close = () => useFileMenu.setState({ at: null });
  const act = (fn: () => unknown) => () => { close(); Promise.resolve().then(fn).catch((e) => useStore.getState().toast(String(e?.message ?? e))); };
  const open = (app: 'reveal' | Editor) => ws.request({ kind: 'shell.open', path: at.path, app });
  return (
    <>
      <span ref={anchor} className="file-menu-at" style={{ left: at.x, top: at.y }} aria-hidden />
      <Popover anchor={anchor} onClose={close} prefer="down" align="left" className="file-menu" label={tr('文件')}>
        {!remote && at.sessionId && (
          <button data-mi data-act="mention" onClick={act(() => mentionInComposer(at.sessionId!, at.path))}><Icon name="attach" size={14} /> {tr('添加到对话')}</button>
        )}
        {!remote && eds.map((e) => (
          <button key={e} data-mi data-act={`open-${e}`} onClick={act(() => open(e))}><Icon name="external" size={14} /> {tr('用 {app} 打开', { app: EDITOR_NAME[e] })}</button>
        ))}
        {!remote && <button data-mi data-act="reveal" onClick={act(() => open('reveal'))}><Icon name="folder" size={14} /> {/Mac/i.test(navigator.platform) ? tr('在访达中显示') : tr('在资源管理器中显示')}</button>}
        {!remote && <button data-mi data-act="publish" onClick={act(() => openPublish(at.path))}><Icon name="share" size={14} /> {tr('发布…')}</button>}
        <button data-mi data-act="copy" onClick={act(async () => { await navigator.clipboard.writeText(at.path); useStore.getState().toast(tr('已复制路径'), true); })}><Icon name="copy" size={14} /> {tr('复制路径')}</button>
      </Popover>
    </>
  );
}
