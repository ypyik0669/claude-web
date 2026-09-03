import { TerminalPanel } from '@/features/panels/TerminalPanel';
import type { Tile } from '@/model/layout';

export function TermTile({ tile, visible }: { tile: Extract<Tile, { kind: 'term' }>; visible: boolean }) {
  return <TerminalPanel cwd={tile.cwd} cmd={tile.cmd} visible={visible} />;
}
