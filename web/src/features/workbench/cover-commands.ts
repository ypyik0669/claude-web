// Keys while a page lies over the workbench. Two pages cover what the tabs / panes / groups show: the settings page
// (the whole window) and the automation page (the main area). A key meant for what is under them must not act on
// the unseen (review 7 I3 for the automation page, final review I2 for the settings page — Alt+W used to kill a
// terminal nobody could see). Pure: `runCommand` applies the answer, from the browser's keys and the desktop menu's
// accelerators alike.

export type Cover = 'settings' | 'automation';

/** Commands that act on the tabs, panes, groups or the conversation under a page. */
const UNDER = /^(tile\.|pane\.|group\.|tab$|new$|interrupt$|close$|window\.new$)/;

/**
 * What to do with command `id` while `open` pages are up: `close` = the pages to put away first (top one first:
 * settings lies over automation), `done` = the command was only that (关闭标签 closes the page on top, like a tab).
 * The palette, the settings key, the sidebar, the shortcut sheet, the right panel and its panels act as before —
 * they show over or beside the page.
 */
export function underCovers(id: string, open: { settings: boolean; automation: boolean }): { close: Cover[]; done: boolean } {
  const up: Cover[] = [];
  if (open.settings) up.push('settings');
  if (open.automation) up.push('automation');
  if (!up.length) return { close: [], done: false };
  if (id === 'tile.close') return { close: [up[0]], done: true };
  if (UNDER.test(id)) return { close: up, done: false };
  return { close: [], done: false };
}
