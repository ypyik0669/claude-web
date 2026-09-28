// Putting something into the start page's composer from outside it (a starter, the 入门清单): the text, the project,
// or just the focus. A window event, like 「引用到输入框」 (REFERENCE_EVENT): only the welcome composer of that tile
// takes it — the composer keeps its own state.
export const FILL_EVENT = 'cw:composer-fill';

export interface FillDetail {
  /** the chat tile whose welcome composer should take it; none = every welcome composer (the first-run wizard) */
  tileId?: string;
  /** a starter's text (see `applyStarter`: typed text is kept) */
  text?: string;
  /** the project folder to start in */
  cwd?: string;
  /** focus the text box (with the caret at the end) */
  focus?: boolean;
}

export function fillComposer(d: FillDetail): void {
  window.dispatchEvent(new CustomEvent<FillDetail>(FILL_EVENT, { detail: d }));
}
