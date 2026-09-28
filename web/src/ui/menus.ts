// Anchored menus (the directory menu, the model menu, the composer's + menu, the sidebar's session menus…) close on
// one window event when something takes the whole window over — the settings page opening over the app. A menu
// portalled to <body> is outside the app that the page makes inert: left open it would float above the page and
// still change the covered composer (review of redesign phase 6). The one who covers does not list the menus; a menu
// subscribes while it is open:
//
//   useEffect(() => onCloseMenus(() => onClose(false)), [onClose]);
export const CLOSE_MENUS = 'cw:close-menus';

/** Close every open anchored menu. */
export function closeAnchoredMenus(): void {
  window.dispatchEvent(new Event(CLOSE_MENUS));
}

/** Call `fn` when menus are told to close; returns the unsubscribe (fits a useEffect cleanup). */
export function onCloseMenus(fn: () => void): () => void {
  window.addEventListener(CLOSE_MENUS, fn);
  return () => window.removeEventListener(CLOSE_MENUS, fn);
}
