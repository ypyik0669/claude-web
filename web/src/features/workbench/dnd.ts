// Native HTML5 drag & drop payloads for the workbench.
export const MIME_SESSION = 'application/x-cw-session';
export const MIME_TILE = 'application/x-cw-tile';
export const MIME_PANEL = 'application/x-cw-panel';

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** Edge bands (outer 25%) split the pane; the middle drops into it. */
export function zoneAt(rect: DOMRect, x: number, y: number): DropZone {
  const rx = (x - rect.left) / Math.max(1, rect.width);
  const ry = (y - rect.top) / Math.max(1, rect.height);
  const dl = rx, dr = 1 - rx, dt = ry, db = 1 - ry;
  const m = Math.min(dl, dr, dt, db);
  if (m > 0.25) return 'center';
  if (m === dl) return 'left';
  if (m === dr) return 'right';
  if (m === dt) return 'top';
  return 'bottom';
}

export function hasType(dt: DataTransfer | null, type: string): boolean {
  return !!dt && Array.from(dt.types).includes(type);
}

export function tilePayload(dt: DataTransfer): { groupId: string; paneId: string; tileId: string } | null {
  try {
    const j = JSON.parse(dt.getData(MIME_TILE) || 'null');
    return j && j.paneId && j.tileId ? j : null;
  } catch {
    return null;
  }
}

// 文件树 → 对话 (user request 2026-11-17): a file or folder dragged from the tree. The payload is a JSON array of
// absolute paths; `text/plain` carries the first one too, so a drop outside the app still gets the path.
export const MIME_FILE = 'application/x-cw-file';

export function setFileDrag(dt: DataTransfer, paths: string[]): void {
  dt.setData(MIME_FILE, JSON.stringify(paths));
  dt.setData('text/plain', paths.join('\n'));
  dt.effectAllowed = 'copyMove';
}

export function filePayload(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  try {
    const j = JSON.parse(dt.getData(MIME_FILE) || '[]');
    return Array.isArray(j) ? j.filter((p): p is string => typeof p === 'string' && !!p) : [];
  } catch {
    return [];
  }
}
