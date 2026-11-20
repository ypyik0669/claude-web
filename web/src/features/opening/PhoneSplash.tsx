import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { tr } from '@/i18n';
import portrait from '@/assets/opening/portrait.webp';
import { whenOf } from './model';

/** How long the phone's start screen stays (then it fades out in 0.35 s). */
export const PHONE_SPLASH_MS = 1100;

/** The logo (opening-logo.svg), as the desktop's opening draws it. */
function Logo() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden>
      <rect width="1024" height="1024" rx="236" fill="#0B0B0C" />
      <g transform="translate(92 452)" fill="#FFFFFF"><path d="M0 260 V0 H250 V110 H120 V260 Z" /><path d="M300 0 H420 L360 260 H240 Z" /><path d="M460 -140 H580 V260 H460 Z" /><circle cx="710" cy="130" r="130" fill="#FF5A1F" /></g>
    </svg>
  );
}

/**
 * The phone's start screen (界面改版方案 第 7 版 #opening): Claude Web 娘's portrait, the logo and the wordmark lighting
 * up under it, about a second, no video. Only when the page opens at phone width; a tap ends it; 开场 set to 不放 ends
 * it as soon as the settings are in.
 */
export function PhoneSplash() {
  const mobile = useStore((s) => s.mobile);
  const never = useStore((s) => s.metaLoaded && whenOf(s.settings) === 'never');
  // decided once: a desktop window made narrow later never gets it
  const [phase, setPhase] = useState<'on' | 'out' | 'gone'>(() => (mobile ? 'on' : 'gone'));
  useEffect(() => {
    if (phase !== 'on') return;
    const t = setTimeout(() => setPhase('out'), PHONE_SPLASH_MS);
    return () => clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    if (phase !== 'out') return;
    const t = setTimeout(() => setPhase('gone'), 380);
    return () => clearTimeout(t);
  }, [phase]);
  useEffect(() => { if (never && phase === 'on') setPhase('gone'); }, [never, phase]);
  if (phase === 'gone') return null;
  return (
    <div className={phase === 'out' ? 'phone-splash out' : 'phone-splash'} role="presentation" onClick={() => setPhase('out')}>
      <img src={portrait} alt="" draggable={false} />
      <i className="fade" />
      <div className="mark" aria-label={tr('Claude Web 正在打开')}>
        <Logo />
        <div className="w"><span className="c">Claude</span>Web</div>
        <div className="by"><span>by</span>Super NB</div>
      </div>
    </div>
  );
}
