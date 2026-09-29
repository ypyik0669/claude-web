// Whether something lies over a conversation's composer (review I1). A card docked above the box that came while
// it was covered was never seen: its first moments (the 600 ms in which an empty Enter answers nothing) start when
// the cover goes — like a tab coming to the front. Pure: the component reads the stores and passes the values in.

export interface CoverState {
  /** the settings page (full window) */
  settingsOpen: boolean;
  /** the automation page (over the main area) */
  automationOpen: boolean;
  mobile: boolean;
  /** store `sheetAt`: when a phone's bottom drawer came up (0 = down) */
  sheetAt: number;
  dockOpen: boolean;
  dockTabs: number;
  /** a 详情 asked for (the drawer shows it without a tab of its own) */
  inspect: boolean;
}

/** A phone's right panel is a bottom drawer: up = raised, open, with something to show. */
export function sheetUp(s: Pick<CoverState, 'mobile' | 'sheetAt' | 'dockOpen' | 'dockTabs' | 'inspect'>): boolean {
  return s.mobile && s.sheetAt > 0 && s.dockOpen && (s.dockTabs > 0 || s.inspect);
}

export function composerCovered(s: CoverState): boolean {
  return s.settingsOpen || s.automationOpen || sheetUp(s);
}
