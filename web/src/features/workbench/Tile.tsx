import type { Tile as TileModel } from '@/model/layout';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { ChatTile } from './tiles/ChatTile';
import { DocTile } from './tiles/DocTile';
import { DiffTile } from './tiles/DiffTile';
import { TermTile } from './tiles/TermTile';
import { PanelTile } from './tiles/PanelTile';
import { BrowserTile } from './tiles/BrowserTile';
import { tileArea } from './tile-area';

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
