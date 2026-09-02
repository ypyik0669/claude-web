import type { Tile } from '@/model/layout';
import { PanelBody } from '../Dock';

/** A dock panel living inside a pane (dragged out of the dock or opened from the ＋ menu). */
export function PanelTile({ tile }: { tile: Extract<Tile, { kind: 'panel' }> }) {
  return <div className="panel-tile"><PanelBody id={tile.panel} /></div>;
}
