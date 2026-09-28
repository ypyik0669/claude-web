import { PANEL_TITLES, type Tile as TileModel } from '@/model/layout';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { ChatTile } from './tiles/ChatTile';
import { DocTile } from './tiles/DocTile';
import { DiffTile } from './tiles/DiffTile';
import { TermTile } from './tiles/TermTile';
import { PanelTile } from './tiles/PanelTile';
import { BrowserTile } from './tiles/BrowserTile';

const tail = (p: string) => p.split(/[\\/]/).pop() || p;

/** How the error fallback names a tile: `会话`, `文档 · index.ts`, `停靠面板 · 终端`… */
export function tileArea(tile: TileModel): string {
  switch (tile.kind) {
    case 'chat': return tile.title ? `会话 · ${tile.title}` : '会话';
    case 'doc': return `文档 · ${tail(tile.path)}`;
    case 'diff': return `差异 · ${tail(tile.path)}`;
    case 'term': return '终端';
    case 'browser': return '浏览器';
    case 'panel': return `面板 · ${PANEL_TITLES[tile.panel] ?? tile.panel}`;
  }
}

export function Tile({ tile, paneId, visible }: { tile: TileModel; paneId: string; visible: boolean }) {
  // one boundary per tile: a crash in one tab leaves the rest of the pane (and every other pane) working
  return (
    <ErrorBoundary area={tileArea(tile)} resetKeys={[tile.id]}>
      <TileBody tile={tile} paneId={paneId} visible={visible} />
    </ErrorBoundary>
  );
}

function TileBody({ tile, paneId, visible }: { tile: TileModel; paneId: string; visible: boolean }) {
  switch (tile.kind) {
    case 'chat': return <ChatTile tile={tile} paneId={paneId} visible={visible} />;
    case 'doc': return <DocTile tile={tile} />;
    case 'diff': return <DiffTile tile={tile} />;
    case 'term': return <TermTile tile={tile} visible={visible} />;
    case 'browser': return <BrowserTile tile={tile} />;
    case 'panel': return <PanelTile tile={tile} />;
  }
}
