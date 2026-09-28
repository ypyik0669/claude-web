import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { DISCONNECTED } from '@/ui/terms';

/**
 * How long the connection has to be down before the main area says so: a blip (a reconnect within a second) says
 * nothing; the very first connect of a page load gets longer (the server may still be starting).
 */
export const bannerDelay = (everConnected: boolean) => (everConnected ? 1200 : 5000);

/** The first row of the main area, whose bottom the strip hangs from: the automation page's head, else the top pane's. */
const HEAD = ['.auto-page:not([hidden]) .auto-head', '.pane[data-top] .tabstrip', '.pane[data-top] .sess-head', '.pane[data-top] .welcome-top', '.pane[data-top] .mobile-tilebar'];

/**
 * 「连接断开，正在重连…」 (review M10 / 7 M7): a thin strip hanging from the bottom of the main area's first row, the
 * full width of the main area — seen with the sidebar collapsed and with the phone's drawer shut; the account row
 * says the same. It takes no clicks (the client reconnects by itself). While the settings page covers the window
 * the strip sits on top of it instead. `pointer-events: none` on the whole thing.
 */
export function ConnectionBanner() {
  const connected = useStore((s) => s.connected);
  const settings = useStore((s) => !!s.settingsOpen);
  const ever = useRef(false);
  const [show, setShow] = useState(false);
  const [top, setTop] = useState<number | null>(null);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (connected) { ever.current = true; setShow(false); return; }
    const t = setTimeout(() => setShow(true), bannerDelay(ever.current));
    return () => clearTimeout(t);
  }, [connected]);
  // where the first row ends (a group bar / tab strip above the header pushes it down)
  useLayoutEffect(() => {
    if (!show || settings) return;
    const place = () => {
      const center = el.current?.parentElement;
      if (!center) return;
      const c = center.getBoundingClientRect();
      let bottom = 0;
      for (const sel of HEAD) {
        const h = center.querySelector(sel)?.getBoundingClientRect();
        if (h && h.height) { bottom = Math.max(bottom, h.bottom); if (sel.startsWith('.auto-page')) break; }
      }
      setTop(Math.round((bottom || c.top + 52) - c.top));
    };
    place();
    window.addEventListener('resize', place);
    const t = setInterval(place, 1000); // the layout under it can change while the connection is down
    return () => { window.removeEventListener('resize', place); clearInterval(t); };
  }, [show, settings]);
  if (!show) return null;
  return (
    <div ref={el} className={clsx('conn-banner', settings && 'over-settings')} style={settings || top === null ? undefined : { top }} role="status" aria-live="polite">
      <span className="spin" aria-hidden />{DISCONNECTED}
    </div>
  );
}
