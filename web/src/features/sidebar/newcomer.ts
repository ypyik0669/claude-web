// The sidebar's first screen for someone new (final review §9 #5). Pure: the component passes what it knows.
import { checklistView, readChecklist } from '@/features/home/model';

/**
 * The 项目 section while there is no project. Conversations the CLI already had sit in 其它文件夹 by folder: then the
 * way in is to make one of those a project (their rows say 「设为项目」), so the empty state says that, with no second
 * 「打开文件夹」 button (the header's + is one). With nothing at all it offers to open a folder.
 */
export function projectsEmpty(o: { projects: number; otherFolders: number }): { text: string; openButton: boolean } | null {
  if (o.projects > 0) return null;
  if (o.otherFolders > 0) return { text: '把常用的文件夹设为项目：点下面「其它文件夹」里的「设为项目」，它的对话就归到一起。', openButton: false };
  return { text: '还没有项目。打开一个文件夹，Claude 就在里面工作。', openButton: true };
}

/** 设为项目 on a folder of 其它文件夹 is written out (not a hover icon) while there is no project yet. */
export function makeProjectSpelled(projects: number): boolean {
  return projects === 0;
}

/** How long the library's discovery hint waits for an unfinished checklist (re-review M-7). */
export const HINT_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The library's discovery hint waits until the newcomer checklist is finished or closed: finding Codex / OpenCode
 * conversations is not the first thing to learn, and the first screen has enough to say. Not forever (re-review
 * M-7): the list only shows on the home page, and someone whose desktop app always opens on a conversation never
 * finishes it — 3 days after the list first showed (`since`), the hint comes anyway. A list without `since` (not read
 * by this build yet) waits: it gets one the first time it is read.
 */
export function hintReady(checklist: unknown, now: number): boolean {
  const c = readChecklist(checklist);
  if (!checklistView(c).visible) return true;
  return c.since !== undefined && now - c.since >= HINT_WAIT_MS;
}

/** 「把 Codex 等工具里的对话也列在这里？」: one tool by name, several by the first one's; every name is in the tooltip. */
export function hintText(names: readonly string[]): { text: string; title: string } {
  const list = names.join('、');
  const text = names.length <= 1 ? `把 ${names[0] ?? '其它工具'} 里的对话也列在这里？` : `把 ${names[0]} 等工具里的对话也列在这里？`;
  return { text, title: `本机有 ${list} 的对话。列出来以后，它们会出现在侧栏和搜索里（不会改动它们的数据）` };
}
