import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useStore } from '@/store';
import { authToken } from '@/ws/client';
import { useActivePack } from '@/themes/apply';
import { appUrl } from '@/util/app-url';
import { backdropKind, keepOn, opacityOf, packFileUrl, packOf, shellSolid } from './model';
import { useOpeningPacks } from './packs';
import { EMBER_COLORS, EMBER_HALO, emberAlpha, emberCount, rgba, spawn, stepEmbers, type Ember } from './embers';

const reducedMotion = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) || document.documentElement.dataset.reduceMotion === '1';
/** On screen: the window is visible and has the focus (minimized or another program in front: nothing moves). */
const watching = () => document.visibilityState === 'visible' && document.hasFocus();

/** Light themes: the film is dark, under a light shell it would only turn grey. */
const LIGHT = new Set(['light', 'paper']);

/** Is the background on screen (the start page then leaves out its own 字流). */
export const useOpeningBackdropOn = create<{ on: boolean }>(() => ({ on: false }));

/**
 * 放完留作背景 (设置 › 外观 › 开场和背景): her loop — or 火星 — under the app. It is drawn behind everything (fixed,
 * z-index −1, outside .app) and shows only where the shell lets it: the shell ground (sidebar, the gaps between the
 * cards) and the start page get a little see-through (`html.obd-on`, styles/opening.css); conversations, code and the
 * input box stay solid. Paused while the window is minimized or another program is in front.
 */
export function OpeningBackdrop() {
  const mobile = useStore((s) => s.mobile);
  const metaLoaded = useStore((s) => s.metaLoaded);
  const keep = useStore((s) => keepOn(s.settings));
  const opacity = useStore((s) => opacityOf(s.settings));
  const pack = useStore((s) => packOf(s.settings));
  const theme = useStore((s) => s.theme);
  const themeBackdrop = !!useActivePack()?.backdrop;
  const packs = useOpeningPacks((s) => s.list);
  const load = useOpeningPacks((s) => s.load);
  useEffect(() => { if (metaLoaded && keep && !mobile && packs === null) void load(); }, [metaLoaded, keep, mobile, packs, load]);
  const kind = metaLoaded ? backdropKind({ keep, mobile, light: LIGHT.has(theme), themeBackdrop, pack, packs, url: (id, f) => appUrl(packFileUrl(id, f, authToken())) }) : null;
  const on = !!kind;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('obd-on', on);
    const solid = shellSolid(opacity);
    root.style.setProperty('--obd-side', solid.side);
    root.style.setProperty('--obd-main', solid.main);
    useOpeningBackdropOn.setState({ on });
    return () => { root.classList.remove('obd-on'); useOpeningBackdropOn.setState({ on: false }); };
  }, [on, opacity]);
  if (!kind) return null;
  return createPortal(
    <div className="obd" aria-hidden data-kind={kind.kind}>
      {kind.kind === 'video' ? <LoopVideo key={kind.src} src={kind.src} /> : <Embers key={theme} light={LIGHT.has(theme)} />}
    </div>,
    document.body,
  );
}

/** The pack's loop: muted, looping, playing only while watched; motion reduced → its first frame, still. */
function LoopVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const still = reducedMotion();
    const sync = () => {
      if (!still && watching()) { const p = v.play(); if (p) p.catch(() => { /* not allowed yet: the next focus tries again */ }); }
      else v.pause();
    };
    const shown = () => v.classList.add('on');
    v.addEventListener('loadeddata', shown);
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      v.removeEventListener('loadeddata', shown);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      v.pause();
    };
  }, [src]);
  return <video ref={ref} src={src} muted loop playsInline preload="auto" disablePictureInPicture />;
}

/** One spark per colour, drawn once and stamped: a solid core and the glow around it (no gradient per ember per frame). */
function sparkSprite(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  if (x) {
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, color);
    g.addColorStop(1 / EMBER_HALO, color);
    g.addColorStop(1.7 / EMBER_HALO, rgba(color, 0.38));
    g.addColorStop(1, rgba(color, 0));
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
  }
  return c;
}

/** 火星 (embers.ts): ~24 fps while watched, one still frame when motion is reduced. */
function Embers({ light }: { light: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const rand = Math.random;
    const colors = light ? EMBER_COLORS.light : EMBER_COLORS.dark;
    const sprites = colors.map(sparkSprite);
    let w = 0, h = 0, list: Ember[] = [], raf = 0, last = 0, wash: CanvasGradient | null = null;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // the warmth they rise from: a faint glow below the bottom edge
      wash = ctx.createRadialGradient(w / 2, h * 1.15, 0, w / 2, h * 1.15, Math.max(w, h) * 0.8);
      wash.addColorStop(0, rgba(colors[0], light ? 0.3 : 0.2));
      wash.addColorStop(1, rgba(colors[0], 0));
      const want = emberCount(w, h);
      list = list.slice(0, want);
      while (list.length < want) list.push(spawn(w, h, rand, true));
      // a new size clears the canvas: draw again at once (motion reduced: this is the only frame)
      draw();
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      if (wash) { ctx.fillStyle = wash; ctx.fillRect(0, 0, w, h); }
      ctx.save();
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
      for (const e of list) {
        const r = e.s * EMBER_HALO;
        ctx.globalAlpha = emberAlpha(e) * (light ? 1 : 0.9);
        ctx.drawImage(sprites[Math.floor((e.life / e.max) * sprites.length) % sprites.length], e.x - r, e.y - r, r * 2, r * 2);
      }
      ctx.restore();
    };
    const tick = (now: number) => {
      raf = 0;
      if (!watching()) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      if (dt >= 1 / 24) { last = now; stepEmbers(list, dt, w, h, rand); draw(); }
      raf = requestAnimationFrame(tick);
    };
    const still = reducedMotion();
    const sync = () => { if (!still && watching() && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
    resize();
    draw();
    canvas.classList.add('on');
    sync();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, [light]);
  return <canvas ref={ref} />;
}
