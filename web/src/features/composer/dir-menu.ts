/** Keyboard of the working-directory menu: which row to focus, or close (handing focus back to the chip). */
export function menuKey(key: string, index: number, count: number): { focus: number } | { close: true; refocus: true } | null {
  if (!count) return key === 'Escape' || key === 'Tab' ? { close: true, refocus: true } : null;
  switch (key) {
    case 'ArrowDown': return { focus: index < 0 ? 0 : (index + 1) % count };
    case 'ArrowUp': return { focus: index < 0 ? count - 1 : (index - 1 + count) % count };
    case 'Home': return { focus: 0 };
    case 'End': return { focus: count - 1 };
    case 'Escape':
    case 'Tab': return { close: true, refocus: true };
    default: return null;
  }
}

const CAP = 520;
const GUTTER = 8;
/** max-width for the menu at its fixed position: the design cap, but never past the right edge of the viewport. */
export function menuMaxWidth(pos: { left?: number; right?: number }, vw: number): number {
  const room = pos.left !== undefined ? vw - pos.left - GUTTER : vw - 2 * GUTTER;
  return Math.max(0, Math.min(CAP, room));
}
