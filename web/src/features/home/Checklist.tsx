import { useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { modKey } from '@/features/workbench/shortcuts';
import { openReview } from '@/features/workbench/right-panel';
import { fillComposer } from '@/features/composer/fill';
import { CHECKLIST_KEY, checklistView, readChecklist, type ChecklistId } from './model';

/** What each step says; the palette step also carries the shortcuts the old 就绪 page listed (spec §5.8). */
const STEP: Record<ChecklistId, { label: string; hint: string; action: string }> = {
  project: { label: '选一个项目', hint: '打开一个文件夹，Claude 就在里面工作', action: '打开文件夹' },
  send: { label: '发出第一个任务', hint: '在上面的输入框里说要做什么，回车发送', action: '写一个' },
  review: { label: '审阅一次改动', hint: '看看 Claude 改了哪些文件', action: '去看看' },
  palette: { label: `试试 ${modKey} K`, hint: `${modKey}+K 搜对话、命令和设置；${modKey}+, 打开设置；按 ? 看全部快捷键`, action: '试试' },
};

async function pickProject(tileId: string) {
  const st = useStore.getState();
  const p = desktop ? await desktop.pickDir() : await ws.request<string | null>({ kind: 'fs.pickDir' });
  if (!p) return;
  try { await st.addWorkspace(p); fillComposer({ tileId, cwd: p, focus: true }); } catch (e) { st.toast((e as Error).message); }
}

/** 审阅一次改动: the newest conversation on this machine, its changes in 审阅 (the right panel / the phone's drawer). */
function goReview() {
  const st = useStore.getState();
  const s = [...st.sessions].filter((x) => !x.peer && !x.parentId).sort((a, b) => b.lastModified - a.lastModified)[0];
  if (!s) { st.toast('先发出一个任务：Claude 改了文件之后，就能在这里审阅'); return; }
  if (st.open[s.sessionId]) st.openInPane(s.sessionId, 'replace');
  else void st.loadHistory(s.sessionId);
  openReview({ scope: 'session' });
}

function run(id: ChecklistId, tileId: string) {
  if (id === 'project') void pickProject(tileId);
  else if (id === 'send') fillComposer({ tileId, focus: true });
  else if (id === 'review') goReview();
  else useStore.setState({ paletteOpen: true });
}

/**
 * 入门清单 (spec §5.8, mock-home.png): one row — 入门 2/4, a progress bar, the next step and its button, × — that
 * unfolds into the four steps. Progress lives in meta.json (`settings['onboarding.checklist']`, written by
 * `installChecklist`); once all four are done, or after ×, it is gone for good.
 */
export function Checklist({ tileId }: { tileId: string }) {
  const raw = useStore((s) => s.settings[CHECKLIST_KEY]);
  const metaLoaded = useStore((s) => s.metaLoaded);
  const [open, setOpen] = useState(false);
  const stored = useMemo(() => readChecklist(raw), [raw]);
  const view = checklistView(stored);
  if (!metaLoaded || !view.visible || !view.next) return null;
  const next = STEP[view.next];
  const dismiss = () => void useStore.getState().setSetting(CHECKLIST_KEY, { ...stored, dismissed: true });
  return (
    <section className={clsx('guide', open && 'open')} aria-label="入门清单">
      <div className="guide-row">
        <button className="guide-count" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? '收起' : '展开全部 4 步'}>
          <Icon name="checkCircle" size={16} className="ok" />
          <span className="n">入门 {view.done}/{view.total}</span>
          <span className="prog" aria-hidden><i style={{ width: `${(view.done / view.total) * 100}%` }} /></span>
        </button>
        {!open && <span className="guide-next">下一步：<b>{next.label}</b><span className="h">，{next.hint}</span></span>}
        {open && <span className="grow" />}
        {!open && <button className="btn sm" data-step={view.next} onClick={() => run(view.next!, tileId)}>{next.action}</button>}
        <button className="icon-btn xs" title="不再显示入门清单" aria-label="不再显示入门清单" onClick={dismiss}><Icon name="close" size={13} /></button>
      </div>
      {open && (
        <ol className="guide-steps">
          {view.items.map((it) => (
            <li key={it.id} className={clsx(it.done && 'done')} data-step={it.id}>
              <Icon name={it.done ? 'checkCircle' : 'circle'} size={15} className="mark" />
              <span className="grow"><span className="l">{STEP[it.id].label}</span><span className="h">{STEP[it.id].hint}</span></span>
              {!it.done && <button className="btn sm" onClick={() => run(it.id, tileId)}>{STEP[it.id].action}</button>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
