import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { tr } from '@/i18n';
import portrait from '@/assets/opening/portrait.webp';
import { tunnelHost } from '@/ws/tunnel';
import { fullOf, whenOf } from './model';
import { firstStartToday, phoneOpening, playsFull, type PhoneOpening } from './phone-opening';
import './phone-opening.css';

/** How long it waits for the settings (完整 / 简短 / 不放) before it plays with the defaults. */
export const PHONE_SPLASH_WAIT_MS = 1200;
/** This phone's last start day (每天第一次), in the page's own storage: one per phone, not the PC's meta.json. */
const DAY_KEY = 'cw.phone.openingDay';

const reducedMotion = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) || document.documentElement.dataset.reduceMotion === '1';

/**
 * The phone's opening (phone-opening.ts: her portrait, embers, the fuse round the gold logo, the wordmark), when a
 * phone opens the app by itself (局域网). Inside the phone shell it plays nothing — the shell played it while it
 * connected — and tells the shell the opening settings for its next start. Decided once, at mount: a desktop window
 * made narrow later never gets it. 开场 set to 不放 shows nothing; 每天第一次 plays 简短 after the day's first start
 * (playsFull); a tap ends it.
 */
export function PhoneSplash() {
  const mobile = useStore((s) => s.mobile);
  const metaLoaded = useStore((s) => s.metaLoaded);
  const when = useStore((s) => whenOf(s.settings));
  const full = useStore((s) => fullOf(s.settings));
  const [inShell] = useState(() => !!tunnelHost());
  // 'wait': a dark ground until the settings are in (or PHONE_SPLASH_WAIT_MS); 'play': the opening owns the screen
  const [phase, setPhase] = useState<'wait' | 'play' | 'gone'>(() => (mobile && !inShell ? 'wait' : 'gone'));
  const host = useRef<HTMLDivElement>(null);
  const op = useRef<PhoneOpening | null>(null);

  // the shell's next start plays (or skips) the opening as this PC has it set
  useEffect(() => {
    if (!inShell || !metaLoaded) return;
    try {
      window.parent.postMessage({ type: 'cw-shell', opening: { when, full } }, window.location.origin);
    } catch {
      /* the shell is gone: nothing to tell */
    }
  }, [inShell, metaLoaded, when, full]);

  useEffect(() => {
    if (phase !== 'wait') return;
    if (metaLoaded && when === 'never') return setPhase('gone');
    if (metaLoaded) return setPhase('play');
    const t = setTimeout(() => setPhase('play'), PHONE_SPLASH_WAIT_MS);
    return () => clearTimeout(t);
  }, [phase, metaLoaded, when]);

  // 不放 arriving after it started (the settings came late): it goes at once
  useEffect(() => {
    if (phase === 'play' && metaLoaded && when === 'never') void op.current?.out();
  }, [phase, metaLoaded, when]);

  useEffect(() => {
    if (phase !== 'play' || !host.current) return;
    const long = playsFull(when === 'daily' ? 'daily' : 'always', full, firstStartToday(DAY_KEY));
    const o = phoneOpening(host.current, { portrait, full: long, reduced: reducedMotion(), label: tr('Claude Web 正在打开') });
    op.current = o;
    let live = true;
    void o.played.then(() => o.out()).then(() => live && setPhase('gone'));
    return () => {
      live = false;
      void o.out();
    };
    // the length is read once, when it starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase === 'gone') return null;
  return (
    <div
      ref={host}
      className={phase === 'wait' ? 'phone-splash-host wait' : 'phone-splash-host'}
      role="presentation"
      onClick={() => {
        // a tap: the opening jumps to its end and fades out; while still waiting, straight away
        if (op.current) op.current.skip();
        else setPhase('gone');
      }}
    />
  );
}
