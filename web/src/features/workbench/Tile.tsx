import type { Tile as TileModel } from '@/model/layout';
import { ChatTile } from './tiles/ChatTile';
import { DocTile } from './tiles/DocTile';
import { DiffTile } from './tiles/DiffTile';
import { TermTile } from './tiles/TermTile';
import { PanelTile } from './tiles/PanelTile';

export function Tile({ tile, paneId, visible }: { tile: TileModel; paneId: string; visible: boolean }) {
  switch (tile.kind) {
    case 'chat': return <ChatTile tile={tile} paneId={paneId} visible={visible} />;
    case 'doc': return <DocTile tile={tile} />;
    case 'diff': return <DiffTile tile={tile} />;
    case 'term': return <TermTile tile={tile} visible={visible} />;
    case 'panel': return <PanelTile tile={tile} />;
  }
}
