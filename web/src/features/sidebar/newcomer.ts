// The sidebar's first screen for someone new (final review §9 #5). Pure: the component passes what it knows.
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

