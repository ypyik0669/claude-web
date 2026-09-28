import type { Tile } from '@/model/layout';
import { PanelBody } from '../Dock';

/** A dock panel living inside a pane (dragged out of the dock or opened from the ＋ menu). */
export function PanelTile({ tile, visible }: { tile: Extract<Tile, { kind: 'panel' }>; visible: boolean }) {
  // panes never unmount — a panel behind another tab of its pane (or in a hidden pane) is mounted but not on
  // screen, so it must not keep asking the server (审阅 runs git only while visible)
  return <div className="panel-tile"><PanelBody id={tile.panel} visible={visible} host="tile" /></div>;
}
