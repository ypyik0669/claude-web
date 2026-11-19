// A page over the main area can belong to a family of pages that the user sees as one page with tabs (redesign
// 2026-11 stage 1: 自动化 = the background page, the automation page and the Bot page). The family draws its title and
// its tab row over each of its pages; OverPage asks this table by the page's `name` (auto / bg / bots…), so the pages
// themselves do not change. A page can also have a column of its own at its left on a desktop — what was its section's
// sidebar when the icon rail switched the sidebar column (the background page's list of conversations).
import type { ComponentType } from 'react';

export interface PageFrame {
  /** the family's name: the page's heading, whichever page of it is in front */
  title: string;
  /** one line beside the heading */
  desc?: string;
  /** the family's tab row (it knows which one is in front) */
  Tabs: ComponentType;
  /** the page's own column at its left on a desktop (a phone shows the page's own tabs instead) */
  Side?: ComponentType;
}

const frames = new Map<string, PageFrame>();

/** The family module registers its pages when it is first imported (before any of them renders). */
export function registerPageFrame(name: string, frame: PageFrame): void { frames.set(name, frame); }

export function pageFrame(name: string): PageFrame | undefined { return frames.get(name); }
