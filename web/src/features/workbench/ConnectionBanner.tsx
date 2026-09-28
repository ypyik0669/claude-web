import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { DISCONNECTED } from '@/ui/terms';

/**
 * How long the connection has to be down before the main area says so: a blip (a reconnect within a second) says
 * nothing; the very first connect of a page load gets longer (the server may still be starting).
 */
export const bannerDelay = (everConnected: boolean) => (everConnected ? 1200 : 5000);

/**
 * 「连接断开，正在重连…」 at the top of the main area (spec §4.2 「已连接」 row; review M10). It sits in the center
 * column, so it is seen with the sidebar collapsed and with the phone's drawer shut; the account row says the same.
 */
export function ConnectionBanner() {
  const connected = useStore((s) => s.connected);
  const ever = useRef(false);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) { ever.current = true; setShow(false); return; }
    const t = setTimeout(() => setShow(true), bannerDelay(ever.current));
    return () => clearTimeout(t);
  }, [connected]);
  if (!show) return null;
  return (
    <div className="conn-banner" role="status" aria-live="polite">
      <span className="spin" aria-hidden />{DISCONNECTED}
    </div>
  );
}
