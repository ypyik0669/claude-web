// 网吧开门 (界面改版方案 第 7 版 #opening): the 3D cafe as an opening (steps.ts says who comes in when). It is not part of
// the app's bundle: web/vite.opening.config.ts builds it alone, with three.js, into dist/opening/cafe-opening.js. The
// desktop opening page loads that from the shell's scheme before the server is up (desktop/src/opening.ts
// `startCafe`); 试放一次 and the card's preview load the app's copy. The cafe's scene (office/scene.ts) is used as it
// is; the logo and the wordmark are the opening page's, over this canvas.
import { CafeScene } from '@/features/office/scene';
import { cafeSteps } from './steps';

export interface CafeOpeningOptions {
  full: boolean;
  /** the neon sign over the door and the private rooms' word, in the page's language */
  sign: string;
  room: string;
  width: number;
  height: number;
  /** its first frame is on screen (the opening counts its time from here) */
  first?: () => void;
}
export interface CafeOpening { stop(): void; resize(w: number, h: number): void }

export function startCafeOpening(canvas: HTMLCanvasElement, o: CafeOpeningOptions): CafeOpening {
  const scene = new CafeScene(canvas, { sign: o.sign, room: o.room });
  scene.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  scene.setNight(true, true);
  scene.setZones([]);
  scene.resize(Math.max(1, o.width), Math.max(1, o.height));
  scene.focus(-1, true);
  scene.start();
  const steps = cafeSteps(o.full);
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false, raf = 0;
  // the steps run from the first frame on (building the hall and compiling its shaders can take a while on a busy start)
  const waitFirst = () => {
    raf = 0;
    if (stopped) return;
    if (scene.frames < 1) { raf = requestAnimationFrame(waitFirst); return; }
    o.first?.();
    // the camera eases in a little while the rows light up
    scene.setZoom(1.12);
    for (const s of steps) timers.push(setTimeout(() => { if (!stopped) scene.setZones(s.zones); }, s.at * 1000));
  };
  raf = requestAnimationFrame(waitFirst);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
      try { scene.dispose(); } catch { /* the context is already gone */ }
    },
    resize(w: number, h: number) { if (!stopped) scene.resize(Math.max(1, w), Math.max(1, h)); },
  };
}
