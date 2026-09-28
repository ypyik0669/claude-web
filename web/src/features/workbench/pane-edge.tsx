import { createContext, useContext } from 'react';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { modKey } from './shortcuts';

/**
 * Where a pane sits in the window, so its first row can act as the title bar: `lead` = it is the window's top-left
 * row (sidebar reveal button, mac traffic-light gap), `strip` = the pane shows its tab strip (then the strip is the
 * first row, not the tile's own header). Desktop drag regions / caption-button gaps are CSS on `.pane[data-*]`.
 */
export interface PaneEdge { lead: boolean; strip: boolean }
export const PaneEdgeContext = createContext<PaneEdge>({ lead: false, strip: false });
export const usePaneEdge = () => useContext(PaneEdgeContext);

/** 「展开侧栏」 in the top-left row, only while the sidebar is collapsed (spec §5.2). */
export function SidebarReveal() {
  const open = useStore((s) => s.sidebarOpen);
  if (open) return null;
  return (
    <button className="icon-btn sb-reveal" title={`展开侧栏 (${modKey}+B)`} aria-label="展开侧栏" onClick={() => useStore.setState({ sidebarOpen: true })}>
      <Icon name="sidebar" size={16} />
    </button>
  );
}
