// The full-window viewer (ui/Viewer.tsx) and Esc, the pure part: one Esc does one thing, the innermost first.

/** What lies around an Esc while a viewer is open (read from the page by Viewer.tsx). */
export interface EscScene {
  key: string;
  /** someone already took it */
  defaultPrevented: boolean;
  /** imeComposing(): the key cancels pinyin (macOS reports it as Escape) */
  composing: boolean;
  /** an anchored menu is open — a dropdown on a card in the viewer: it closes itself first */
  menuOpen: boolean;
  /** a dialog (dlg.*) lies over the viewer */
  dialogAbove: boolean;
  /** this viewer is the last one opened */
  topmost: boolean;
}

/** Does this Esc close the viewer (and nothing else)? */
export function viewerTakesEsc(s: EscScene): boolean {
  return s.key === 'Escape' && !s.defaultPrevented && !s.composing && !s.menuOpen && !s.dialogAbove && s.topmost;
}
