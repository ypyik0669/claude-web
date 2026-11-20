// The sidebar's first screen for someone new (final review §9 #5). Pure: the component passes what it knows.
import type { SessionSummary } from '@shared';
import { firstTime } from '@/features/home/model';
import { tr } from '@/i18n';

/**
 * The 项目 section while there is no project. Conversations the CLI already had sit in 文件夹, one group per folder: then the
 * way in is to make one of those a project (their rows say 「设为项目」), so the empty state says that, with no second
 * 「打开文件夹」 button (the header's + is one). With nothing at all it offers to open a folder.
 */
export function projectsEmpty(o: { projects: number; otherFolders: number }): { text: string; openButton: boolean } | null {
  if (o.projects > 0) return null;
  if (o.otherFolders > 0) return { text: tr('把常用的文件夹设为项目：点下面「文件夹」里的「设为项目」，它就钉在最上面。'), openButton: false };
  return { text: tr('还没有项目。打开一个文件夹，Claude 就在里面工作。'), openButton: true };
}

/** 设为项目 on a folder of 文件夹 is written out (not a hover icon) while there is no project yet. */
export function makeProjectSpelled(projects: number): boolean {
  return projects === 0;
}

/**
 * The library's discovery hint waits out the very first screen: finding Codex / OpenCode conversations is not the first
 * thing to learn, and that screen has enough to say. It used to wait for the 入门清单 to be finished or closed (at most
 * 3 days); since the 2026-11 redesign the list only shows the first time — no conversation on this computer yet
 * (`firstTime`) — so the hint waits exactly that long. Nothing before the conversation list has come in (no flash).
 */
export function hintReady(o: { listed: boolean; sessions: readonly SessionSummary[] }): boolean {
  return o.listed && !firstTime(o);
}

/** 「把 Codex 等工具里的对话也列在这里？」: one tool by name, several by the first one's; every name is in the tooltip. */
export function hintText(names: readonly string[]): { text: string; title: string } {
  const list = names.join('、');
  const text = names.length <= 1 ? tr('把 {v} 里的对话也列在这里？', { v: names[0] ?? tr('其它工具') }) : tr('把 {v} 等工具里的对话也列在这里？', { v: names[0] });
  return { text, title: tr('本机有 {list} 的对话。列出来以后，它们会出现在侧栏和搜索里（不会改动它们的数据）', { list }) };
}
