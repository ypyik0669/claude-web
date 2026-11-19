import type { NodeGraphData } from './schema';
import type { Picks } from './marks';
import type { FitOpts } from './viewport';

export interface NodeGraphProps {
  graph: NodeGraphData;
  ariaLabel: string;
  /** canvas height, px (default 360) — or a CSS length: the fullscreen viewer's graph fills its stage with '100%' */
  height?: number | string;
  /** default NG_CARD_W */
  cardW?: number;
  /** default 'center' */
  align?: 'center' | 'top';
  /** right panel: smaller text and controls, no title / badge */
  compact?: boolean;
  /** play the entrance on mount (still subject to reduced motion and the 150-card limit) */
  entrance?: boolean;
  selected?: string | null;
  /** click a card / Enter on a card */
  onSelect?: (id: string) => void;
  /** default: every card is selectable when onSelect is given */
  canSelect?: (id: string) => boolean;
  /** controlled dropdowns */
  picks?: Picks;
  /** none → rows only show text */
  onPick?: (key: string, value: string) => void;
  className?: string;
  /** how the graph is fitted (zoom range, room kept at the top / bottom, start at the top left when it cannot fit) */
  fit?: FitOpts;
  /** in a scrolling column (a chat reply, the orchestra panel): the wheel zooms only once the graph was clicked or
   *  focused; until then it scrolls the page (review D5) */
  embedded?: boolean;
  /** issue #17: a 全屏查看 button after 适应窗口, handing over the button (the focus goes back to it when the viewer
   *  closes). Only the chat's blocks pass it; without it the zoom bar is what it always was */
  onFullscreen?: (from: HTMLElement) => void;
}
