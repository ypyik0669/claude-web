// 添加文件夹 / 移除: changing a conversation's own working directories from the + menu, the 环境 card or a folder tag in
// the box. The rules are in extra-dirs.ts (pure); this only talks to the store and says what happened.
import { useStore } from '@/store';
import { tr } from '@/i18n';
import { basename } from '@/util';
import { withDir, withoutDir } from './extra-dirs';

const NO_DIRS: readonly string[] = [];
const busy = (sessionId: string) => { const s = useStore.getState().open[sessionId]?.state; return s === 'running' || s === 'waiting'; };

/**
 * `dir` becomes one of the conversation's working directories (`taken`: its own folder and its project's — already
 * there). A running conversation restarts with it once idle (server: pool.extraDirsChanged); mid-turn the toast says
 * it comes after the turn.
 */
export async function addOwnDir(sessionId: string, dir: string, taken: readonly string[]): Promise<void> {
  const st = useStore.getState();
  const own = st.sessionMeta[sessionId]?.extraDirs ?? NO_DIRS;
  const next = withDir(own, dir, taken);
  const name = basename(dir);
  if (next === own) { st.toast(tr('{name} 已经在工作目录里', { name }), true); return; }
  try {
    await st.setExtraDirs(sessionId, next);
    st.toast(busy(sessionId) ? tr('已把 {name} 加进这个对话的工作目录，这一轮结束后生效', { name }) : tr('已把 {name} 加进这个对话的工作目录', { name }), true);
  } catch (e: any) { st.toast(String(e?.message ?? e)); }
}

/** The conversation stops working in `dir` (its own ones only: the project's are changed in the project's settings). */
export async function removeOwnDir(sessionId: string, dir: string): Promise<void> {
  const st = useStore.getState();
  const own = st.sessionMeta[sessionId]?.extraDirs ?? NO_DIRS;
  const name = basename(dir);
  try {
    await st.setExtraDirs(sessionId, withoutDir(own, dir));
    st.toast(busy(sessionId) ? tr('已从工作目录移除 {name}，这一轮结束后生效', { name }) : tr('已从工作目录移除 {name}', { name }), true);
  } catch (e: any) { st.toast(String(e?.message ?? e)); }
}
