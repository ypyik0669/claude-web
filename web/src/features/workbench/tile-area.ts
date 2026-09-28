import { PANEL_TITLES, type Tile } from '@/model/layout';

const tail = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/**
 * How an error boundary names a tile: `会话 · 0f1e2d3c`, `文档 · index.ts`, `面板 · 终端`… The name ends up in
 * server.log (`client.log`), so it never carries a tab title — a chat title is the user's first prompt — or
 * a browser URL; a session is named by its id.
 */
export function tileArea(tile: Tile): string {
  switch (tile.kind) {
    case 'chat': return `会话 · ${tile.sessionId ? tile.sessionId.slice(0, 8) : '新会话'}`;
    case 'doc': return `文档 · ${tail(tile.path)}`;
    case 'diff': return `差异 · ${tail(tile.path)}`;
    case 'term': return '终端';
    case 'browser': return '浏览器';
    case 'panel': return `面板 · ${PANEL_TITLES[tile.panel] ?? tile.panel}`;
  }
}
