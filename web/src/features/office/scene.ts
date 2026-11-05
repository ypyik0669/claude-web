// 后台 · 网吧: the three.js internet cafe. One isometric low-poly hall, cut away at the front and the right: a back
// wall with windows on the city, the big screen over the lounge (sofas, snacks, water) and the entrance under the
// neon sign; a row of PCs per zone (区) with a glowing sign; the front counter on the right where each zone's 网管
// stands level with its row; glass private rooms (包间) along the left wall for the background commands. Customers
// are little octopuses in their agent's colour (or a custom character's billboard): at a PC typing, raising a hand
// when they wait, a blue screen when stuck, off to the lounge and back when resting, to the counter and out of the
// door when finished. The camera orbits / pans / zooms with easing and flies between the whole hall and one zone.
//
// No React here: `Office.tsx` owns the DOM around it and hands over the model; this module draws, eases, walks the
// customers, picks and moves the HTML overlays (zone tags, people's buttons). Nothing is loaded from the network.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { BotShape, BotStatus } from './model';
import { EXIT, PCS, hallDepth, rowsFor } from './model';

// ---------------------------------------------------------------------------------------------------- layout

/** half the hall's width (x); the depth (z) follows the rows (hallDepth) */
const HW = 9.6;
const WALL_H = 3.6;
const FOV = 30;
const PITCH = 2.5;
/** PCs of a row: x of seat k */
const pcX = (k: number) => -5.45 + k * 1.55;
const ROW_X0 = -6.25, ROW_X1 = 3.1;
/** the main aisle, the counter, where the 网管 stand, where a customer pays */
const AISLE = 4.6, COUNTER_X = 6.65, LEAD_X = 7.65, PAY_X = 5.75;
/** the private rooms' glass front */
const ROOM_X = -6.95;
const SEAT_Y = 0.46;

interface Hall { rows: number; D: number; back: number; front: number; cz: number; row: (r: number) => number; rooms: number }
function hall(zones: number): Hall {
  const rows = rowsFor(zones), D = hallDepth(rows), back = -D / 2;
  return { rows, D, back, front: D / 2, cz: back + 3.7, row: (r) => back + 4.8 + r * PITCH, rooms: Math.max(1, Math.floor((D - 4.2) / 3)) };
}

/** a place someone can be, with the way out of it to the main aisle */
interface Spot { p: THREE.Vector3; yaw: number; entry: THREE.Vector3[]; sit?: boolean }
const v3 = (x: number, z: number) => new THREE.Vector3(x, 0, z);

function pcSpot(h: Hall, r: number, k: number): Spot {
  const z = h.row(r) + 0.62, lane = h.row(r) + 1.5;
  return { p: v3(pcX(k), z), yaw: Math.PI, sit: true, entry: [v3(pcX(k), lane), v3(AISLE, lane)] };
}
function paySpot(h: Hall, r: number): Spot { const z = h.row(r) + 0.6; return { p: v3(PAY_X, z), yaw: Math.PI / 2, entry: [v3(AISLE, z)] }; }
function outSpot(h: Hall): Spot { return { p: v3(AISLE, h.back - 1.1), yaw: Math.PI, entry: [v3(AISLE, h.back + 0.4)] }; }
/** the lounge: four sofa seats, two windows, the snack shelf, the water */
function restSpots(h: Hall): Spot[] {
  const b = h.back, c = h.cz, mid = -0.7;
  const sofa = (x: number, z: number, yaw: number): Spot => ({ p: v3(x, z), yaw, sit: true, entry: [v3(mid, z), v3(mid, c), v3(AISLE, c)] });
  const stand = (x: number, z: number, yaw: number): Spot => ({ p: v3(x, z), yaw, entry: [v3(x, c), v3(AISLE, c)] });
  return [
    sofa(-2.75, b + 1.45, Math.PI / 2), sofa(-2.75, b + 2.35, Math.PI / 2), sofa(1.35, b + 1.45, -Math.PI / 2), sofa(1.35, b + 2.35, -Math.PI / 2),
    stand(-7.9, b + 0.75, Math.PI), stand(-5.3, b + 0.75, Math.PI), stand(-HW + 1.25, b + 2.1, -Math.PI / 2), stand(2.9, b + 0.95, Math.PI),
  ];
}
function route(a: Spot, b: Spot): THREE.Vector3[] {
  const pts = [...a.entry, ...[...b.entry].reverse(), b.p];
  const out: THREE.Vector3[] = [];
  for (const p of pts) if (!out.length || out[out.length - 1].distanceToSquared(p) > 1e-4) out.push(p.clone());
  return out;
}

// ---------------------------------------------------------------------------------------------------- palette

export const AGENT_HEX = ['#a3e635', '#fbbf24', '#2dd4bf', '#f472b6', '#60a5fa', '#a78bfa', '#fb923c', '#22d3ee', '#e879f9', '#4ade80'];
const SHELL_HEX = '#a7b0c0';
export const agentHex = (n: number) => (n <= 0 ? SHELL_HEX : AGENT_HEX[(n - 1) % 10]);
const PINK = '#ff4fd8', CYAN = '#3ef0ff';

type Pair = [day: string, night: string];
const P: Record<string, Pair> = {
  bg: ['#e9e1d4', '#090b17'],
  ground: ['#d9cfbf', '#0e1020'],
  street: ['#bdb6aa', '#141729'],
  plinth: ['#a88563', '#1a1c33'],
  floor: ['#d9b48a', '#1d2038'],
  wall: ['#f2e9dc', '#262a4a'],
  wallOut: ['#d8cbb8', '#1b1e36'],
  trim: ['#a9774c', '#33376a'],
  frame: ['#7c5a3e', '#3a3f6e'],
  desk: ['#efe3d2', '#2d3052'],
  deskEdge: ['#a9774c', '#3e4278'],
  dark: ['#2b2f3d', '#0d0f1d'],
  metal: ['#9aa1ad', '#4a4e70'],
  chair: ['#3a3f4f', '#1b1d31'],
  counter: ['#b4824f', '#2b2e55'],
  counterTop: ['#f6f1e9', '#45497e'],
  sofa: ['#e0785f', '#6b3a8c'],
  rug: ['#ead6b6', '#2a2350'],
  plant: ['#6fb36b', '#2f7a5b'],
  pot: ['#e8e1d6', '#3a3658'],
  shelf: ['#a77b52', '#3a2f4a'],
  white: ['#ffffff', '#c9cce6'],
  snack: ['#ffffff', '#9aa0d8'],
  building: ['#cfc7bb', '#151830'],
  eye: ['#1d1f2a', '#10111a'],
  acc: ['#2d3142', '#1a1c2c'],
};
const hex = (h: string) => new THREE.Color(h);
const mix = (a: string, b: string, t: number) => '#' + hex(a).lerp(hex(b), t).getHexString();

// a material whose colour moves between a day and a night value, and dims (a zone not in focus)
interface Swatch { mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial; day: THREE.Color; night: THREE.Color; eDay?: THREE.Color; eNight?: THREE.Color; eI?: Pair }

class Mats {
  readonly all: Swatch[] = [];
  readonly by = new Map<string, Swatch>();
  dim = 0;
  get(key: string, make: () => Swatch) {
    let s = this.by.get(key);
    if (!s) { s = make(); this.by.set(key, s); this.all.push(s); }
    return s.mat;
  }
  std(key: string, pair: Pair, o: { rough?: number; metal?: number; emissive?: Pair; opacity?: number; vertexColors?: boolean; map?: THREE.Texture; side?: THREE.Side } = {}): THREE.MeshStandardMaterial {
    return this.get(key, () => {
      const mat = new THREE.MeshStandardMaterial({ color: pair[0], roughness: o.rough ?? 0.78, metalness: o.metal ?? 0, vertexColors: !!o.vertexColors, side: o.side ?? THREE.FrontSide, map: o.map ?? null });
      if ((o.opacity ?? 1) < 1) { mat.transparent = true; mat.opacity = o.opacity!; mat.depthWrite = false; }
      return { mat, day: hex(pair[0]), night: hex(pair[1]), eDay: o.emissive ? hex(o.emissive[0]) : undefined, eNight: o.emissive ? hex(o.emissive[1]) : undefined };
    }) as THREE.MeshStandardMaterial;
  }
  /** unlit (neon, screens): the colour is the light */
  basic(key: string, pair: Pair, o: { map?: THREE.Texture; transparent?: boolean } = {}): THREE.MeshBasicMaterial {
    return this.get(key, () => {
      const mat = new THREE.MeshBasicMaterial({ color: pair[0], map: o.map ?? null, transparent: !!o.transparent, depthWrite: !o.transparent, toneMapped: false });
      return { mat, day: hex(pair[0]), night: hex(pair[1]) };
    }) as THREE.MeshBasicMaterial;
  }
  tint(t: number) {
    const f = 1 - 0.55 * this.dim;
    for (const s of this.all) {
      s.mat.color.lerpColors(s.day, s.night, t).multiplyScalar(f);
      if (s.eDay && s.eNight && 'emissive' in s.mat) s.mat.emissive.lerpColors(s.eDay, s.eNight, t).multiplyScalar(f);
    }
  }
  dispose() { for (const s of this.all) s.mat.dispose(); }
}

// ---------------------------------------------------------------------------------------------------- geometry kit

/** collects boxes / shapes by material key and merges each key into one mesh */
class Kit {
  private parts = new Map<string, THREE.BufferGeometry[]>();
  add(key: string, g: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    const c = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
    for (const a of ['normal', 'uv'] as const) if (!c.getAttribute(a)) c.setAttribute(a, new THREE.Float32BufferAttribute(new Float32Array(c.getAttribute('position').count * (a === 'uv' ? 2 : 3)), a === 'uv' ? 2 : 3));
    if (!c.getAttribute('color')) c.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(c.getAttribute('position').count * 3).fill(1), 3));
    for (const n of Object.keys(c.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(n)) c.deleteAttribute(n);
    (this.parts.get(key) ?? this.parts.set(key, []).get(key)!).push(c);
    g.dispose();
  }
  box(key: string, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) { this.add(key, new THREE.BoxGeometry(w, h, d), x, y, z, ry); }
  rbox(key: string, w: number, h: number, d: number, r: number, x: number, y: number, z: number, ry = 0) { this.add(key, new RoundedBoxGeometry(w, h, d, 2, r), x, y, z, ry); }
  colored(key: string, g: THREE.BufferGeometry, color: string, x: number, y: number, z: number, ry = 0) {
    const c = g.index ? g.toNonIndexed() : g.clone();
    g.dispose();
    const col = hex(color), n = c.getAttribute('position').count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
    c.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
    this.add(key, c, x, y, z, ry);
  }
  build(): Map<string, THREE.BufferGeometry> {
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [k, list] of this.parts) {
      const g = mergeGeometries(list, false);
      if (g) { g.computeBoundingSphere(); out.set(k, g); }
      for (const x of list) x.dispose();
    }
    this.parts.clear();
    return out;
  }
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------------------------------- textures

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const el = document.createElement('canvas');
  el.width = w; el.height = h;
  const c = el.getContext('2d');
  if (c) draw(c);
  const t = new THREE.CanvasTexture(el);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const FONT = 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';

/** floor tiles: white with soft seams; the material's colour makes it wood by day, dark tiles at night */
function tileTex(): THREE.CanvasTexture {
  const t = canvasTex(256, 256, (c) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 256, 256);
    const r = rng(3);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { c.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.04})`; c.fillRect(i * 64, j * 64, 64, 64); }
    c.fillStyle = 'rgba(0,0,0,0.16)';
    for (let i = 0; i <= 4; i++) { c.fillRect(i * 64 - 1, 0, 2, 256); c.fillRect(0, i * 64 - 1, 256, 2); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** scrolling code on a working PC (each screen scrolls its own copy) */
function codeTex(): THREE.CanvasTexture {
  const t = canvasTex(128, 256, (c) => {
    c.fillStyle = '#0d1424'; c.fillRect(0, 0, 128, 256);
    const r = rng(11), cols = ['#7dd3fc', '#c4b5fd', '#86efac', '#fda4af', '#fde68a', '#e2e8f0'];
    for (let y = 6; y < 256; y += 9) {
      let x = 6 + Math.floor(r() * 4) * 8;
      const n = 1 + Math.floor(r() * 4);
      for (let i = 0; i < n && x < 118; i++) { const w = 8 + r() * 30; c.fillStyle = cols[Math.floor(r() * cols.length)]; c.fillRect(x, y, Math.min(w, 122 - x), 4); x += w + 5; }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 0.45);
  return t;
}
function waitTex(): THREE.CanvasTexture {
  return canvasTex(128, 80, (c) => {
    c.fillStyle = '#1a1730'; c.fillRect(0, 0, 128, 80);
    c.fillStyle = '#ffc23d'; c.beginPath(); c.roundRect(22, 14, 84, 52, 8); c.fill();
    c.fillStyle = '#2a1f00'; c.font = `900 40px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('?', 64, 42);
  });
}
function bsodTex(): THREE.CanvasTexture {
  return canvasTex(128, 80, (c) => {
    c.fillStyle = '#1f5fd6'; c.fillRect(0, 0, 128, 80);
    c.fillStyle = '#ffffff'; c.font = `700 26px ${FONT}`; c.textBaseline = 'middle'; c.fillText(':(', 10, 22);
    c.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 3; i++) c.fillRect(10, 42 + i * 9, 60 - i * 12, 4);
    c.fillStyle = '#ff3b3b'; c.beginPath(); c.arc(100, 52, 17, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ffffff'; c.font = `900 26px ${FONT}`; c.textAlign = 'center'; c.fillText('!', 100, 54);
  });
}
function idleTex(): THREE.CanvasTexture {
  return canvasTex(128, 80, (c) => {
    const g = c.createLinearGradient(0, 0, 128, 80);
    g.addColorStop(0, '#141a3a'); g.addColorStop(1, '#2a1240');
    c.fillStyle = g; c.fillRect(0, 0, 128, 80);
    c.fillStyle = 'rgba(255,255,255,0.22)'; c.beginPath(); c.arc(64, 40, 10, 0, Math.PI * 2); c.fill();
  });
}
function termTex(on: boolean): THREE.CanvasTexture {
  return canvasTex(128, 96, (c) => {
    c.fillStyle = '#05070d'; c.fillRect(0, 0, 128, 96);
    if (!on) return;
    const r = rng(5);
    c.fillStyle = '#4ade80';
    for (let y = 8; y < 90; y += 10) c.fillRect(8, y, 12 + r() * 90, 4);
  });
}
/** the big screen over the lounge: a match on, in neon colours */
function bigScreenTex(): THREE.CanvasTexture {
  return canvasTex(512, 256, (c) => {
    const g = c.createLinearGradient(0, 0, 512, 256);
    g.addColorStop(0, '#2b1055'); g.addColorStop(0.55, '#1a2a6c'); g.addColorStop(1, '#0b3b4f');
    c.fillStyle = g; c.fillRect(0, 0, 512, 256);
    // a low-poly arena: mountains, a sun, two fighters
    c.fillStyle = '#ff7ad9'; c.beginPath(); c.arc(256, 150, 62, Math.PI, 0); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)'; for (let i = 0; i < 5; i++) c.fillRect(190, 104 + i * 10, 132, 3);
    c.fillStyle = '#1a1446'; c.beginPath(); c.moveTo(0, 190); c.lineTo(110, 120); c.lineTo(200, 175); c.lineTo(300, 110); c.lineTo(420, 180); c.lineTo(512, 140); c.lineTo(512, 256); c.lineTo(0, 256); c.fill();
    c.strokeStyle = 'rgba(62,240,255,0.55)'; c.lineWidth = 2;
    for (let i = 0; i < 9; i++) { c.beginPath(); c.moveTo(256, 196); c.lineTo(-200 + i * 114, 256); c.stroke(); }
    for (let y = 200; y < 256; y += 12) { c.beginPath(); c.moveTo(0, y); c.lineTo(512, y); c.stroke(); }
    c.fillStyle = '#3ef0ff'; c.fillRect(150, 160, 18, 34); c.fillStyle = '#ffd34d'; c.fillRect(344, 160, 18, 34);
    // the HUD
    c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(0, 0, 512, 34);
    c.fillStyle = '#3ef0ff'; c.fillRect(14, 12, 150, 10); c.fillStyle = '#ffd34d'; c.fillRect(348, 12, 120, 10);
    c.fillStyle = '#ff3b6b'; c.beginPath(); c.roundRect(222, 6, 68, 22, 6); c.fill();
    c.fillStyle = '#fff'; c.font = `800 15px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('LIVE', 256, 18);
  });
}
/** a neon sign: text glowing on a transparent ground (the plate behind it is geometry) */
function neonTex(text: string, sub: string, color: string, w = 1024, h = 256): THREE.CanvasTexture {
  return canvasTex(w, h, (c) => {
    c.clearRect(0, 0, w, h);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const big = Math.round(h * (sub ? 0.46 : 0.6));
    c.font = `800 ${big}px ${FONT}`;
    let size = big;
    while (c.measureText(text).width > w * 0.9 && size > 20) { size -= 4; c.font = `800 ${size}px ${FONT}`; }
    const y = sub ? h * 0.42 : h * 0.52;
    c.shadowColor = color; c.shadowBlur = h * 0.12;
    c.fillStyle = color; c.fillText(text, w / 2, y);
    c.shadowBlur = h * 0.04; c.fillStyle = '#ffffff'; c.globalAlpha = 0.85; c.fillText(text, w / 2, y);
    if (sub) {
      c.globalAlpha = 1; c.shadowColor = CYAN; c.shadowBlur = h * 0.08; c.fillStyle = CYAN;
      c.font = `700 ${Math.round(h * 0.17)}px ${FONT}`; c.fillText(sub, w / 2, h * 0.8);
    }
  });
}
/** lit windows for the city outside (emissive at night) */
function cityTex(): THREE.CanvasTexture {
  const t = canvasTex(128, 256, (c) => {
    c.fillStyle = '#000000'; c.fillRect(0, 0, 128, 256);
    const r = rng(23);
    for (let y = 8; y < 250; y += 14) for (let x = 8; x < 124; x += 16) {
      if (r() < 0.45) continue;
      c.fillStyle = r() < 0.7 ? '#ffd9a0' : r() < 0.5 ? '#9fdcff' : '#ff9ae6';
      c.fillRect(x, y, 9, 7);
    }
  });
  return t;
}
// ---------------------------------------------------------------------------------------------------- the hall

/** back-wall openings: two windows and the door */
const WINDOWS: [number, number][] = [[-9.0, -6.8], [-6.4, -4.2]];
const WIN_Y: [number, number] = [1.0, 3.0];
const DOOR: [number, number] = [3.8, 5.4];
const DOOR_H = 2.6;

/** the static hall for so many rows, in world coordinates, merged by material key */
function hallTemplate(h: Hall): Map<string, THREE.BufferGeometry> {
  const k = new Kit();
  const b = h.back, f = h.front, T = 0.2;
  // the plinth the diorama stands on
  k.rbox('plinth', 2 * HW + 1.4, 0.5, h.D + 1.4, 0.08, 0, -0.25, 0);
  // back wall with openings
  const seg = (x0: number, x1: number, y0: number, y1: number) => k.box('wall', x1 - x0, y1 - y0, T, (x0 + x1) / 2, (y0 + y1) / 2, b - T / 2);
  const xs: [number, number, 'full' | 'win' | 'door'][] = [[-HW - T, -9.0, 'full'], [-9.0, -6.8, 'win'], [-6.8, -6.4, 'full'], [-6.4, -4.2, 'win'], [-4.2, DOOR[0], 'full'], [DOOR[0], DOOR[1], 'door'], [DOOR[1], HW, 'full']];
  for (const [x0, x1, kind] of xs) {
    if (kind === 'full') seg(x0, x1, 0, WALL_H);
    else if (kind === 'win') { seg(x0, x1, 0, WIN_Y[0]); seg(x0, x1, WIN_Y[1], WALL_H); }
    else seg(x0, x1, DOOR_H, WALL_H);
  }
  // left wall
  k.box('wall', T, WALL_H, h.D + T, -HW - T / 2, WALL_H / 2, -T / 2);
  // wall caps and the outside faces' trim
  k.box('trim', 2 * HW + T, 0.08, T + 0.04, -T / 2, WALL_H + 0.04, b - T / 2);
  k.box('trim', T + 0.04, 0.08, h.D + T, -HW - T / 2, WALL_H + 0.04, -T / 2);
  // baseboards and a chair rail inside
  for (const [x0, x1, kind] of xs) if (kind !== 'door') k.box('trim', x1 - x0, 0.12, 0.03, (x0 + x1) / 2, 0.06, b + 0.015);
  k.box('trim', 0.03, 0.12, h.D, -HW + 0.015, 0.06, 0);
  // window frames, a mullion, sills
  for (const [x0, x1] of WINDOWS) {
    const cx = (x0 + x1) / 2, w = x1 - x0, hh = WIN_Y[1] - WIN_Y[0], cy = (WIN_Y[0] + WIN_Y[1]) / 2;
    k.box('frame', w + 0.12, 0.08, 0.26, cx, WIN_Y[0], b - 0.1);
    k.box('frame', w + 0.12, 0.08, 0.26, cx, WIN_Y[1], b - 0.1);
    k.box('frame', 0.08, hh, 0.26, x0, cy, b - 0.1);
    k.box('frame', 0.08, hh, 0.26, x1, cy, b - 0.1);
    k.box('frame', 0.05, hh, 0.08, cx, cy, b - 0.1);
    k.box('frame', w, 0.05, 0.08, cx, WIN_Y[0] + hh * 0.62, b - 0.1);
    k.box('trim', w + 0.3, 0.06, 0.24, cx, WIN_Y[0] - 0.03, b + 0.1);
  }
  // the door: a frame, a step, the open glass leaf
  k.box('frame', 0.1, DOOR_H, 0.3, DOOR[0], DOOR_H / 2, b - 0.1);
  k.box('frame', 0.1, DOOR_H, 0.3, DOOR[1], DOOR_H / 2, b - 0.1);
  k.box('frame', DOOR[1] - DOOR[0] + 0.1, 0.1, 0.3, AISLE, DOOR_H, b - 0.1);
  k.box('trim', 2.0, 0.04, 1.2, AISLE, 0.02, b - 0.7);
  k.box('rugDoor', 1.4, 0.015, 0.8, AISLE, 0.008, b + 0.55);
  // the neon sign over the entrance
  k.rbox('dark', 4.9, 0.8, 0.08, 0.04, AISLE, 3.08, b + 0.06);
  for (const [w, hh, x, y] of [[4.96, 0.04, AISLE, 3.48], [4.96, 0.04, AISLE, 2.68], [0.04, 0.8, AISLE - 2.48, 3.08], [0.04, 0.8, AISLE + 2.48, 3.08]] as const) k.box('neonPink', w, hh, 0.04, x, y, b + 0.11);
  // neon lines along the top of the walls
  k.box('neonCyan', 2 * HW - 0.2, 0.035, 0.035, 0, WALL_H - 0.12, b + 0.03);
  k.box('neonCyan', 0.035, 0.035, h.D - 0.2, -HW + 0.03, WALL_H - 0.12, 0);
  // the big screen over the lounge
  k.rbox('dark', 4.5, 2.35, 0.1, 0.04, -0.7, 2.12, b + 0.06);
  k.box('metal', 1.2, 0.06, 0.12, -0.7, 0.93, b + 0.08);
  // the lounge: a rug, two sofas facing each other, a low table
  k.rbox('rug', 3.9, 0.02, 2.5, 0.01, -0.7, 0.012, b + 1.75);
  for (const side of [-1, 1]) {
    const sx = side < 0 ? -2.95 : 1.55, bx = side < 0 ? -3.35 : 1.95, z = b + 1.9;
    k.rbox('sofa', 0.85, 0.42, 2.1, 0.1, sx, 0.21, z);
    k.rbox('sofa', 0.26, 0.85, 2.1, 0.1, bx, 0.45, z);
    k.rbox('sofa', 0.85, 0.6, 0.24, 0.1, sx, 0.3, z - 1.05);
    k.rbox('sofa', 0.85, 0.6, 0.24, 0.1, sx, 0.3, z + 1.05);
    k.rbox('cushion', 0.6, 0.1, 0.9, 0.05, sx + side * -0.02, 0.46, z - 0.45);
    k.rbox('cushion', 0.6, 0.1, 0.9, 0.05, sx + side * -0.02, 0.46, z + 0.45);
  }
  k.add('desk', new THREE.CylinderGeometry(0.42, 0.42, 0.05, 28), -0.7, 0.36, b + 0.85);
  k.add('metal', new THREE.CylinderGeometry(0.05, 0.08, 0.34, 10), -0.7, 0.17, b + 0.85);
  k.add('white', new THREE.CylinderGeometry(0.06, 0.05, 0.11, 12), -0.82, 0.44, b + 0.8);
  k.add('neonPink', new THREE.CylinderGeometry(0.05, 0.04, 0.1, 12), -0.56, 0.44, b + 0.92);
  // the snack shelf on the left wall
  const sx = -HW + 0.3, z0 = b + 1.2, z1 = b + 3.0;
  k.box('shelf', 0.5, 1.9, 0.06, sx, 0.95, z0);
  k.box('shelf', 0.5, 1.9, 0.06, sx, 0.95, z1);
  k.box('shelf', 0.06, 1.9, z1 - z0, sx - 0.22, 0.95, (z0 + z1) / 2);
  for (let i = 0; i < 4; i++) k.box('shelf', 0.5, 0.04, z1 - z0, sx, 0.1 + i * 0.5, (z0 + z1) / 2);
  const r = rng(9);
  const snackCols = ['#ff6b6b', '#ffd34d', '#4fc3f7', '#81c784', '#ba68c8', '#ff9f43', '#f06292'];
  for (let i = 0; i < 4; i++) for (let z = z0 + 0.1; z < z1 - 0.15;) {
    const w = 0.12 + r() * 0.14, hh = 0.16 + r() * 0.2;
    k.colored('snack', new THREE.BoxGeometry(0.3, hh, w), snackCols[Math.floor(r() * snackCols.length)], sx + 0.02, 0.12 + i * 0.5 + hh / 2, z + w / 2);
    z += w + 0.03;
  }
  // the vending machine and the water dispenser
  k.rbox('vend', 0.8, 1.9, 0.7, 0.06, -3.6, 0.95, b + 0.4);
  k.box('vendGlow', 0.56, 1.2, 0.02, -3.68, 1.15, b + 0.76);
  k.box('dark', 0.16, 0.5, 0.02, -3.3, 1.2, b + 0.76);
  k.rbox('white', 0.46, 1.05, 0.42, 0.05, 2.9, 0.53, b + 0.3);
  k.add('bottle', new THREE.CylinderGeometry(0.15, 0.15, 0.42, 16), 2.9, 1.27, b + 0.3);
  k.box('dark', 0.16, 0.12, 0.03, 2.9, 0.82, b + 0.52);
  // plants
  const pot = new THREE.CylinderGeometry(0.25, 0.19, 0.42, 16);
  for (const [x, z, s] of [[-HW + 0.55, b + 0.5, 1.1], [8.9, b + 0.55, 1.2], [3.55, b + 0.45, 0.9]] as const) {
    k.add('pot', pot.clone(), x, 0.21, z);
    k.add('plant', new THREE.IcosahedronGeometry(0.36 * s, 0), x, 0.64 * s + 0.2, z);
    k.add('plant', new THREE.IcosahedronGeometry(0.26 * s, 0), x + 0.16 * s, 0.98 * s + 0.2, z - 0.08);
  }
  pot.dispose();
  // the counter: one long counter, a 网管 behind it level with each row
  const c0 = h.row(0) - 0.9, c1 = h.row(h.rows - 1) + 1.6, cm = (c0 + c1) / 2;
  k.rbox('counter', 0.7, 1.0, c1 - c0, 0.06, COUNTER_X, 0.5, cm);
  k.rbox('counterTop', 0.92, 0.07, c1 - c0 + 0.12, 0.03, COUNTER_X, 1.03, cm);
  k.box('neonCyan', 0.03, 0.03, c1 - c0 - 0.1, COUNTER_X - 0.36, 0.12, cm);
  k.rbox('counter', 0.9, 1.0, 0.7, 0.06, COUNTER_X + 0.45, 0.5, c0 - 0.3);
  k.rbox('counterTop', 1.05, 0.07, 0.8, 0.03, COUNTER_X + 0.45, 1.03, c0 - 0.3);
  // the private rooms along the left wall
  for (let i = 0; i < h.rooms; i++) {
    const z0r = b + 3.9 + i * 3, z1r = z0r + 2.9, zm = (z0r + z1r) / 2;
    for (const z of [z0r, z1r]) k.box('metal', 0.07, 2.5, 0.07, ROOM_X, 1.25, z);
    k.box('metal', 0.07, 0.07, z1r - z0r, ROOM_X, 2.5, zm);
    k.box('metal', HW + ROOM_X, 0.07, 0.07, (-HW + ROOM_X) / 2, 2.5, z1r);
    if (i === 0) k.box('metal', HW + ROOM_X, 0.07, 0.07, (-HW + ROOM_X) / 2, 2.5, z0r);
    k.box('desk', 0.75, 0.05, 1.8, -HW + 0.45, 0.74, zm);
    k.box('metal', 0.04, 0.72, 0.04, -HW + 0.75, 0.36, zm - 0.85);
    k.box('metal', 0.04, 0.72, 0.04, -HW + 0.75, 0.36, zm + 0.85);
    k.rbox('dark', 0.5, 0.95, 0.3, 0.03, -HW + 0.4, 0.48, zm + 0.62);
    k.box('dark', 0.05, 0.56, 0.86, -HW + 0.3, 1.15, zm - 0.15);
    k.rbox('chairRoom', 0.5, 0.1, 0.5, 0.04, -HW + 1.25, 0.45, zm - 0.15);
    k.rbox('chairRoom', 0.1, 0.6, 0.5, 0.04, -HW + 1.5, 0.78, zm - 0.15);
    k.box('metal', 0.05, 0.4, 0.05, -HW + 1.25, 0.2, zm - 0.15);
    k.rbox('rugRoom', HW + ROOM_X - 0.2, 0.012, 2.7, 0.005, (-HW + ROOM_X) / 2, 0.008, zm);
  }
  return k.build();
}

/** one zone's row, in row coordinates (z = 0 at the desks' middle); every row shares it */
function rowTemplate(): Map<string, THREE.BufferGeometry> {
  const k = new Kit();
  const L = ROW_X1 - ROW_X0, cx = (ROW_X0 + ROW_X1) / 2;
  k.box('desk', L, 0.05, 0.82, cx, 0.74, 0);
  k.box('deskEdge', L, 0.04, 0.03, cx, 0.74, 0.42);
  for (const x of [ROW_X0 + 0.05, ROW_X1 - 0.05]) k.box('deskEdge', 0.05, 0.72, 0.8, x, 0.36, 0);
  k.box('deskEdge', L - 0.1, 0.4, 0.03, cx, 0.4, -0.36);
  // the divider behind the monitors, a glowing strip on it
  k.box('divider', L, 0.42, 0.04, cx, 0.97, -0.42);
  k.box('glow', L, 0.03, 0.05, cx, 1.19, -0.42);
  for (let i = 0; i < PCS; i++) {
    const x = pcX(i);
    k.rbox('dark', 0.82, 0.52, 0.05, 0.02, x, 1.16, -0.2);
    k.box('dark', 0.06, 0.24, 0.05, x, 0.88, -0.24);
    k.box('dark', 0.3, 0.02, 0.18, x, 0.775, -0.24);
    k.box('dark', 0.5, 0.025, 0.16, x, 0.78, 0.12);
    k.add('dark', new THREE.SphereGeometry(0.04, 10, 6).scale(1, 0.5, 1.3), x + 0.36, 0.78, 0.14);
    k.box('pad', 0.8, 0.008, 0.36, x + 0.08, 0.768, 0.12);
    // the tower under the desk with its light
    k.rbox('dark', 0.22, 0.48, 0.5, 0.03, x + 0.5, 0.25, -0.05);
    k.box('glow', 0.02, 0.36, 0.02, x + 0.38, 0.27, 0.2);
    // the chair (a low back: the one sitting stays in view)
    k.rbox('chair', 0.52, 0.1, 0.5, 0.04, x, 0.41, 0.62);
    k.rbox('chairAcc', 0.52, 0.46, 0.1, 0.04, x, 0.7, 0.9);
    k.box('metal', 0.05, 0.36, 0.05, x, 0.2, 0.62);
    k.add('metal', new THREE.CylinderGeometry(0.24, 0.24, 0.03, 10), x, 0.03, 0.62);
  }
  // the zone's sign on a pole at the left end of the row
  k.add('metal', new THREE.CylinderGeometry(0.025, 0.025, 1.6, 8), ROW_X0 + 0.25, 1.55, -0.3);
  k.rbox('signPlate', 1.25, 0.56, 0.08, 0.04, ROW_X0 + 0.25, 2.6, -0.3);
  // the register on the counter in front of the zone's 网管
  k.rbox('dark', 0.34, 0.12, 0.3, 0.02, COUNTER_X + 0.05, 1.12, 1.15);
  k.box('dark', 0.05, 0.22, 0.26, COUNTER_X + 0.15, 1.28, 1.15);
  return k.build();
}

// ---------------------------------------------------------------------------------------------------- people

/** the shared pieces of the little octopus (the default figure) */
class FigureKit {
  head = new THREE.SphereGeometry(0.27, 28, 20);
  leg = new THREE.CapsuleGeometry(0.058, 0.13, 4, 10);
  eye = new THREE.SphereGeometry(0.048, 12, 8);
  shine = new THREE.SphereGeometry(0.016, 8, 6);
  cheek = new THREE.SphereGeometry(0.042, 10, 6);
  hand = new THREE.SphereGeometry(0.068, 12, 8);
  band = new THREE.TorusGeometry(0.275, 0.026, 6, 24, Math.PI);
  cup = new THREE.CylinderGeometry(0.075, 0.075, 0.07, 14);
  beanie = new THREE.SphereGeometry(0.29, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.4);
  ball = new THREE.SphereGeometry(0.06, 12, 8);
  stick = new THREE.CylinderGeometry(0.013, 0.013, 0.24, 6);
  bow = new THREE.ConeGeometry(0.075, 0.13, 4);
  cap = new THREE.CylinderGeometry(0.2, 0.25, 0.13, 20);
  brim = new THREE.BoxGeometry(0.3, 0.025, 0.2);
  disc = new THREE.CircleGeometry(0.3, 20);
  eyeMat = new THREE.MeshStandardMaterial({ color: '#15161f', roughness: 0.25 });
  whiteMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  cheekMat = new THREE.MeshStandardMaterial({ color: '#ff8fb1', roughness: 0.7, transparent: true, opacity: 0.75 });
  shadowMat = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.2, depthWrite: false });
  shared(g: unknown) { return Object.values(this).includes(g); }
  dispose() { for (const v of Object.values(this)) if (v instanceof THREE.BufferGeometry || v instanceof THREE.Material) v.dispose(); }
}

interface Figure {
  root: THREE.Group;
  /** bobs, sits */
  body: THREE.Group;
  legs?: THREE.Group;
  handL?: THREE.Object3D;
  handR?: THREE.Object3D;
  mats: { mat: THREE.MeshStandardMaterial | THREE.SpriteMaterial; base: THREE.Color }[];
  sprite?: boolean;
}

function octopus(kit: FigureKit, color: string, shape: BotShape, lead: boolean): Figure {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.02 });
  const accHex = lead ? '#2b2f45' : mix(color, '#141526', 0.62);
  const acc = new THREE.MeshStandardMaterial({ color: accHex, roughness: 0.5 });
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
  const head = mesh(kit.head, mat, 0, 0.44, 0);
  head.scale.set(1, 0.92, 1);
  const legs = new THREE.Group();
  body.add(legs);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const l = mesh(kit.leg, mat, Math.sin(a) * 0.15, 0.13, Math.cos(a) * 0.15, legs);
    l.rotation.set(Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55);
  }
  for (const s of [-1, 1]) {
    const e = mesh(kit.eye, kit.eyeMat, s * 0.095, 0.47, 0.228);
    e.scale.set(1, 1.3, 0.6);
    mesh(kit.shine, kit.whiteMat, s * 0.095 + 0.014, 0.49, 0.257).castShadow = false;
    const c = mesh(kit.cheek, kit.cheekMat, s * 0.16, 0.39, 0.2);
    c.scale.set(1, 0.6, 0.4);
    c.castShadow = false;
  }
  const handL = mesh(kit.hand, mat, -0.2, 0.28, 0.12), handR = mesh(kit.hand, mat, 0.2, 0.28, 0.12);
  // an accessory per shape, so the same colour still reads as different people (and the 网管 wears a cap)
  if (lead) {
    mesh(kit.cap, acc, 0, 0.69, 0);
    mesh(kit.brim, acc, 0, 0.64, 0.2);
  } else if (shape === 0) {
    const b = mesh(kit.band, acc, 0, 0.46, 0);
    b.rotation.y = Math.PI / 2;
    for (const s of [-1, 1]) { const c = mesh(kit.cup, acc, s * 0.27, 0.44, 0); c.rotation.z = Math.PI / 2; }
  } else if (shape === 1) {
    mesh(kit.beanie, acc, 0, 0.47, 0);
    mesh(kit.ball, acc, 0, 0.76, 0);
  } else if (shape === 2) {
    mesh(kit.stick, acc, 0.06, 0.78, 0);
    mesh(kit.ball, new THREE.MeshBasicMaterial({ color: mix(color, '#ffffff', 0.4) }), 0.06, 0.92, 0).castShadow = false;
  } else {
    for (const s of [-1, 1]) { const b = mesh(kit.bow, acc, s * 0.08, 0.7, 0.05); b.rotation.z = (s * Math.PI) / 2; }
  }
  const sh = new THREE.Mesh(kit.disc, kit.shadowMat);
  sh.rotation.x = -Math.PI / 2;
  sh.position.y = 0.01;
  root.add(sh);
  return { root, body, legs, handL, handR, mats: [{ mat, base: hex(color) }, { mat: acc, base: hex(accHex) }] };
}

function billboard(kit: FigureKit, sprite: HTMLCanvasElement | OffscreenCanvas): Figure {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const tex = new THREE.CanvasTexture(sprite as HTMLCanvasElement);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.5 });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(0.95, 0.95, 1);
  sp.position.y = 0.47;
  body.add(sp);
  const sh = new THREE.Mesh(kit.disc, kit.shadowMat);
  sh.rotation.x = -Math.PI / 2;
  sh.position.y = 0.01;
  root.add(sh);
  return { root, body, mats: [{ mat, base: hex('#ffffff') }], sprite: true };
}

export interface SceneBot {
  id: string;
  kind: 'lead' | 'customer' | 'shell';
  /** customers: the PC (0…PCS-1) or EXIT; shells: the room; the lead: -1 */
  seat: number;
  status: BotStatus;
  color: string;
  shape: BotShape;
  sprite?: HTMLCanvasElement | OffscreenCanvas;
  look: string;
}
export interface SceneZone { key: string; name: string; letter: string; accent: string; bots: SceneBot[] }

type At = 'pc' | 'pay' | 'out' | 'lead' | 'room' | `rest:${number}`;

interface BotView {
  id: string;
  kind: SceneBot['kind'];
  zone: number;
  seat: number;
  /** the PC it last had (where it walks from when it leaves it) */
  pc: number;
  status: BotStatus;
  look: string;
  fig?: Figure;
  /** a command's anchor (the machine) */
  anchor?: THREE.Object3D;
  pos: THREE.Vector3;
  yaw: number;
  yawGoal: number;
  at: At;
  path: THREE.Vector3[];
  dest: At;
  timer: number;
  sit: number;
  phase: number;
  appear: number;
  leaving: boolean;
  gone: boolean;
}

interface RowView {
  key: string;
  index: number;
  group: THREE.Group;
  mats: Mats;
  screens: THREE.Mesh[];
  light: THREE.PointLight;
  tex: THREE.Texture[];
  accent: string;
  name: string;
  used: boolean;
}

interface RoomView { screen: THREE.Mesh; lamp: THREE.Mesh; glass: THREE.Mesh[]; status?: BotStatus }

// ---------------------------------------------------------------------------------------------------- the scene

export interface CameraState { target: THREE.Vector3; radius: number; theta: number; phi: number }
const WALK = 1.5;

export class CafeScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 400);
  private h: Hall = hall(0);
  private hallGroup = new THREE.Group();
  private world = new Mats();
  private outside = new Mats();
  private rows: RowView[] = [];
  private rooms: RoomView[] = [];
  private bots = new Map<string, BotView>();
  private kit = new FigureKit();
  private tplRow = rowTemplate();
  private hemi = new THREE.HemisphereLight('#ffffff', '#d9dde6', 1.6);
  private sun = new THREE.DirectionalLight('#fff4e6', 2.4);
  private pinkLight = new THREE.PointLight(PINK, 0, 9, 1.6);
  private cyanLight = new THREE.PointLight(CYAN, 0, 10, 1.6);
  private deskLight = new THREE.PointLight('#ffc98a', 0, 14, 1.4);
  private tex = { tile: tileTex(), code: codeTex(), wait: waitTex(), bsod: bsodTex(), idle: idleTex(), termOn: termTex(true), termOff: termTex(false), big: bigScreenTex(), city: cityTex(), sign: null as THREE.CanvasTexture | null };
  private screenGeo = new THREE.PlaneGeometry(0.74, 0.44);
  private cur: CameraState;
  private goal: CameraState;
  private night = 1;
  private nightGoal = 1;
  private focusIndex = -1;
  private dims: number[] = [];
  private size = { w: 1, h: 1 };
  private inset = { left: 0, right: 0 };
  private raf = 0;
  private last = 0;
  private lastDraw = 0;
  private dirty = true;
  private populated = false;
  private signName: string;
  private roomWord: string;
  private overlays: { el: HTMLElement; kind: 'zone' | 'bot'; id: string; w: number; h: number }[] = [];
  private overlayRoot: HTMLElement | null = null;
  reduced = false;
  visible = true;
  /** a frame was drawn (ui-smoke counts them; the loop sleeps when nothing moves) */
  frames = 0;

  constructor(readonly canvas: HTMLCanvasElement, words: { sign: string; room: string } = { sign: 'NET CAFE', room: 'VIP' }) {
    this.signName = words.sign;
    this.roomWord = words.room;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(P.bg[1]);
    this.scene.fog = new THREE.Fog(P.bg[1], 70, 160);
    this.scene.add(this.hemi, this.pinkLight, this.cyanLight, this.deskLight, this.hallGroup);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    this.buildOutside();
    this.buildHall(0);
    this.cur = { target: new THREE.Vector3(0, 0.6, 0), radius: 40, theta: Math.PI / 4, phi: 0.98 };
    this.goal = { target: this.cur.target.clone(), radius: 40, theta: this.cur.theta, phi: this.cur.phi };
  }

  // ---- building

  private matFor(m: Mats, key: string, accent: string): THREE.Material {
    switch (key) {
      case 'neonPink': return m.basic(key, [mix(PINK, '#ffffff', 0.2), PINK]);
      case 'neonCyan': return m.basic(key, ['#9adfe6', CYAN]);
      case 'glow': return m.basic(key, [mix(accent, '#ffffff', 0.15), accent]);
      case 'vendGlow': return m.basic(key, ['#fff4d6', '#ffe6a3']);
      case 'bottle': return m.std(key, ['#8fd0ff', '#5a86d6'], { opacity: 0.75, rough: 0.1 });
      case 'vend': return m.std(key, ['#e8505b', '#a03070'], { rough: 0.45 });
      case 'snack': return m.std(key, P.snack, { vertexColors: true, rough: 0.7 });
      case 'cushion': return m.std(key, ['#f3c9a8', '#9a5ab8'], { rough: 0.9 });
      case 'rugDoor': return m.std(key, ['#7a5a46', '#3a2050']);
      case 'rugRoom': return m.std(key, ['#d9c3a5', '#241e46'], { rough: 1 });
      case 'chairRoom': return m.std(key, ['#3a3f4f', '#3b2a5c'], { rough: 0.6 });
      case 'divider': return m.std(key, [mix(accent, '#ffffff', 0.55), mix(accent, '#14152a', 0.7)], { rough: 0.7 });
      case 'chairAcc': return m.std(key, [mix(accent, '#2a2d3a', 0.25), mix(accent, '#12132a', 0.35)], { rough: 0.55 });
      case 'pad': return m.std(key, [mix(accent, '#1d2030', 0.7), mix(accent, '#0b0c18', 0.75)], { rough: 0.95 });
      case 'signPlate': return m.std(key, ['#2a2d3d', '#10111f'], { rough: 0.5 });
      case 'plinth': return m.std(key, P.plinth, { rough: 0.9 });
      default: return m.std(key, P[key] ?? P.white, { rough: key === 'dark' ? 0.35 : key === 'desk' || key === 'counterTop' ? 0.5 : 0.8 });
    }
  }

  private buildOutside() {
    const m = this.outside;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), m.std('ground', P.ground, { rough: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this.scene.add(ground);
    // the city: blocks behind the back wall and beyond the left wall, lit windows at night
    const r = rng(42);
    const spots: [number, number, number, number, number][] = [];
    for (let i = 0; i < 26; i++) spots.push([-40 + i * 3.4 + r() * 1.2, -30 - r() * 26, 2.4 + r() * 2.6, 2.4 + r() * 2.4, 3 + r() * 9]);
    for (let i = 0; i < 16; i++) spots.push([-32 - r() * 24, -26 + i * 3.4 + r(), 2.4 + r() * 2.4, 2.4 + r() * 2.6, 3 + r() * 8]);
    const mat = new THREE.MeshStandardMaterial({ color: P.building[1], emissiveMap: this.tex.city, emissive: '#ffffff', emissiveIntensity: 1, roughness: 0.9 });
    m.get('building', () => ({ mat, day: hex(P.building[0]), night: hex(P.building[1]) }));
    const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, spots.length);
    const o = new THREE.Object3D();
    spots.forEach(([x, z, w, d, hh], i) => { o.position.set(x, hh / 2 - 0.5, z); o.scale.set(w, hh, d); o.updateMatrix(); blocks.setMatrixAt(i, o.matrix); });
    blocks.receiveShadow = true;
    this.scene.add(blocks);
    // a street with trees in front of the back wall's side
    const street = new THREE.Mesh(new THREE.BoxGeometry(200, 0.05, 6), m.std('street', P.street, { rough: 1 }));
    street.position.set(0, -0.48, -16);
    this.scene.add(street);
    const trees: [number, number][] = [];
    for (let x = -30; x <= 30; x += 6) trees.push([x + r() * 2, -11.5 - r() * 1.5]);
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), m.std('tree', ['#86b86a', '#1f3d3a'], { rough: 0.9 }), trees.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.14, 1.2, 6), m.std('trunk', ['#8b6c4e', '#2a2230']), trees.length);
    trees.forEach(([x, z], i) => {
      o.scale.setScalar(1); o.position.set(x, 0.1, z); o.updateMatrix(); trunk.setMatrixAt(i, o.matrix);
      o.scale.setScalar(0.9 + r() * 0.5); o.position.set(x, 1.4, z); o.updateMatrix(); crown.setMatrixAt(i, o.matrix);
    });
    crown.castShadow = trunk.castShadow = true;
    this.scene.add(crown, trunk);
  }

  /** the hall for so many zones (rebuilt when the row count changes) */
  private buildHall(zones: number) {
    for (const rv of this.rows) this.disposeRow(rv);
    this.rows = [];
    this.disposeGroup(this.hallGroup);
    this.world.dispose();
    this.world = new Mats();
    this.rooms = [];
    const h = (this.h = hall(zones));
    const m = this.world;
    for (const [key, g] of hallTemplate(h)) {
      const mesh = new THREE.Mesh(g, this.matFor(m, key, CYAN));
      mesh.castShadow = !['rug', 'rugDoor', 'rugRoom', 'neonPink', 'neonCyan', 'vendGlow'].includes(key);
      mesh.receiveShadow = true;
      this.hallGroup.add(mesh);
    }
    // the floor: tiles by the metre
    const tile = this.tex.tile.clone();
    tile.repeat.set(HW * 2, h.D);
    tile.needsUpdate = true;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, h.D), m.std('floor', P.floor, { map: tile, rough: 0.55, metal: 0.05 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.002;
    floor.receiveShadow = true;
    this.hallGroup.add(floor);
    // glass: the windows, the door leaf, the rooms
    const glass = m.std('glass', ['#d8eefa', '#7f8ff0'], { opacity: 0.18, rough: 0.05, metal: 0.1, side: THREE.DoubleSide });
    const pane = (w: number, hh: number, x: number, y: number, z: number, ry = 0) => {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), glass);
      g.position.set(x, y, z); g.rotation.y = ry; g.renderOrder = 2;
      this.hallGroup.add(g);
      return g;
    };
    for (const [x0, x1] of WINDOWS) pane(x1 - x0, WIN_Y[1] - WIN_Y[0], (x0 + x1) / 2, (WIN_Y[0] + WIN_Y[1]) / 2, h.back - 0.1);
    pane(DOOR[1] - DOOR[0] - 0.1, DOOR_H - 0.1, DOOR[0] + 0.05, DOOR_H / 2, h.back - 0.1, 1.1).geometry.translate((DOOR[1] - DOOR[0]) / 2 - 0.05, 0, 0);
    // the big screen and the entrance sign
    const big = new THREE.Mesh(new THREE.PlaneGeometry(4.25, 2.1), m.basic('big', ['#ffffff', '#ffffff'], { map: this.tex.big }));
    big.position.set(-0.7, 2.12, h.back + 0.115);
    this.hallGroup.add(big);
    this.tex.sign?.dispose();
    this.tex.sign = neonTex(this.signName, 'OPEN 24H', PINK);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.7, 1.175), m.basic('sign', ['#ff9fe6', '#ffffff'], { map: this.tex.sign, transparent: true }));
    sign.position.set(AISLE, 3.08, h.back + 0.105);
    this.hallGroup.add(sign);
    // rooms: a screen and a lamp each, glass front and walls
    for (let i = 0; i < h.rooms; i++) {
      const z0 = h.back + 3.9 + i * 3, z1 = z0 + 2.9, zm = (z0 + z1) / 2;
      const g1 = pane(z1 - z0 - 0.07, 2.45, ROOM_X, 1.25, zm, Math.PI / 2);
      const g2 = pane(HW + ROOM_X, 2.45, (-HW + ROOM_X) / 2, 1.25, z1);
      const gl = [g1, g2];
      if (i === 0) gl.push(pane(HW + ROOM_X, 2.45, (-HW + ROOM_X) / 2, 1.25, z0));
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshBasicMaterial({ map: this.tex.termOff, toneMapped: false }));
      screen.position.set(-HW + 0.33, 1.15, zm - 0.15);
      screen.rotation.y = Math.PI / 2;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: '#555a70', toneMapped: false }));
      lamp.position.set(ROOM_X + 0.02, 2.62, zm);
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.225), new THREE.MeshBasicMaterial({ map: neonTex(`${this.roomWord} ${i + 1}`, '', CYAN, 512, 128), transparent: true, depthWrite: false, toneMapped: false }));
      tag.position.set(ROOM_X + 0.05, 2.2, zm - 0.7);
      tag.rotation.y = Math.PI / 2;
      this.hallGroup.add(screen, lamp, tag);
      this.rooms.push({ screen, lamp, glass: gl });
    }
    // lights that follow the hall's size
    const sc = this.sun.shadow.camera;
    const R = Math.max(HW, h.D / 2) + 3;
    sc.left = -R * 1.2; sc.right = R * 1.2; sc.top = R * 1.2; sc.bottom = -R * 1.2; sc.near = 1; sc.far = 120;
    sc.updateProjectionMatrix();
    this.sun.position.set(-16, 26, h.back - 14);
    this.sun.target.position.set(0, 0, 0);
    this.pinkLight.position.set(AISLE, 2.6, h.back + 1.3);
    this.cyanLight.position.set(-0.7, 2.3, h.back + 1.6);
    this.deskLight.position.set(LEAD_X - 0.3, 2.6, (h.row(0) + h.row(h.rows - 1)) / 2 + 0.6);
    this.deskLight.distance = h.D * 0.75;
    for (let i = 0; i < h.rows; i++) this.rows.push(this.makeRow(null, i));
    m.tint(this.night);
    this.applyNight();
  }

  private makeRow(z: SceneZone | null, index: number): RowView {
    const group = new THREE.Group();
    group.position.z = this.h.row(index);
    const mats = new Mats();
    const accent = z?.accent ?? '#8088a8';
    for (const [key, g] of this.tplRow) {
      const mesh = new THREE.Mesh(g, this.matFor(mats, key, accent));
      mesh.castShadow = key !== 'pad' && key !== 'glow';
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    const tex: THREE.Texture[] = [];
    if (z) {
      const t = neonTex(z.letter, z.name.length > 14 ? `${z.name.slice(0, 13)}…` : z.name, accent, 512, 230);
      tex.push(t);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.52), mats.basic('sign', [mix(accent, '#ffffff', 0.3), '#ffffff'], { map: t, transparent: true }));
      sign.position.set(ROW_X0 + 0.25, 2.6, -0.255);
      const card = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.16), mats.basic('card', ['#ffffff', '#ffffff'], { map: t, transparent: true }));
      card.position.set(COUNTER_X - 0.1, 1.2, 0.2);
      card.rotation.y = Math.PI / 4;
      group.add(sign, card);
    }
    const screens: THREE.Mesh[] = [];
    for (let k = 0; k < PCS; k++) {
      const s = new THREE.Mesh(this.screenGeo, new THREE.MeshBasicMaterial({ color: '#05060c', toneMapped: false }));
      s.position.set(pcX(k), 1.16, -0.172);
      s.userData.state = 'off';
      group.add(s);
      screens.push(s);
    }
    const light = new THREE.PointLight(mix(accent, '#ffffff', 0.3), 0, 9, 1.8);
    light.position.set(-1.6, 2.2, 0.6);
    group.add(light);
    group.userData.row = index;
    this.hallGroup.add(group);
    mats.dim = this.dims[index] ?? 0;
    mats.tint(this.night);
    return { key: z?.key ?? `empty-${index}`, index, group, mats, screens, light, tex, accent, name: z?.name ?? '', used: !!z };
  }

  private disposeGroup(g: THREE.Object3D) {
    const own = new Set<THREE.BufferGeometry>([...this.tplRow.values(), this.screenGeo]);
    g.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (!own.has(o.geometry) && !this.kit.shared(o.geometry)) o.geometry.dispose();
      const mm = o.material as THREE.Material & { map?: THREE.Texture | null };
      if (o.userData.own) { (o.userData.own as THREE.Texture).dispose(); }
      if (mm && !this.kit.shared(mm)) {
        if (mm.map && !Object.values(this.tex).includes(mm.map as THREE.CanvasTexture)) mm.map.dispose();
        mm.dispose();
      }
    });
    g.clear();
  }

  private disposeRow(rv: RowView) {
    rv.group.removeFromParent();
    this.disposeGroup(rv.group);
    rv.mats.dispose();
    for (const t of rv.tex) t.dispose();
  }

  /** Put the cafe in line with the model: zones (A first), their people, PCs and rooms. */
  setZones(list: SceneZone[]) {
    if (rowsFor(list.length) !== this.h.rows) {
      for (const v of [...this.bots.values()]) this.dropBot(v);
      this.buildHall(list.length);
    }
    for (let i = 0; i < this.h.rows; i++) {
      const z = list[i] ?? null;
      const rv = this.rows[i];
      const key = z ? `${z.key}|${z.name}|${z.accent}` : `empty-${i}`;
      if (`${rv.key}|${rv.name}|${rv.accent}` !== (z ? key : `empty-${i}||#8088a8`)) {
        this.disposeRow(rv);
        this.rows[i] = this.makeRow(z, i);
      }
    }
    const seen = new Set<string>();
    const arrive = this.populated && !this.reduced;
    list.forEach((z, zi) => {
      for (const b of z.bots) {
        seen.add(b.id);
        let v = this.bots.get(b.id);
        if (v && v.look !== b.look) { this.dropBot(v); v = undefined; }
        if (!v) v = this.addBot(b, zi, arrive);
        const moved = v.zone !== zi || v.seat !== b.seat;
        v.status = b.status;
        v.leaving = false;
        if (v.fig && !v.fig.sprite) { const m0 = v.fig.mats[0]; m0.base.set(b.color); }
        if (moved) {
          const wasZone = v.zone;
          v.zone = zi;
          v.seat = b.seat;
          if (b.seat >= 0 && b.seat < PCS) v.pc = b.seat;
          if (wasZone !== zi || this.reduced || (v.at === 'pc' && !v.path.length && b.seat < PCS)) this.place(v, this.want(v));
        }
      }
    });
    for (const [id, v] of this.bots) if (!seen.has(id)) v.leaving = true;
    if (list.some((z) => z.bots.length > 1)) this.populated = true;
    this.dirty = true;
  }

  private addBot(b: SceneBot, zone: number, arrive: boolean): BotView {
    const v: BotView = {
      id: b.id, kind: b.kind, zone, seat: b.seat, status: b.status, look: b.look, pos: new THREE.Vector3(), yaw: 0, yawGoal: 0,
      pc: Math.max(0, Math.min(PCS - 1, b.seat)), at: 'pc', path: [], dest: 'pc', timer: 2 + Math.random() * 6, sit: 0, phase: Math.random() * 10, appear: this.reduced ? 1 : 0, leaving: false, gone: false,
    };
    if (b.kind === 'shell') {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.4, 1.2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
      const zm = this.h.back + 3.9 + b.seat * 3 + 1.45;
      a.position.set(-HW + 0.6, 1.0, zm - 0.15);
      a.userData.top = 0.75;
      this.hallGroup.add(a);
      v.anchor = a;
      v.at = 'room';
      v.appear = 1;
    } else {
      v.fig = b.sprite ? billboard(this.kit, b.sprite) : octopus(this.kit, b.color, b.shape, b.kind === 'lead');
      this.hallGroup.add(v.fig.root);
      v.fig.root.scale.setScalar(0.001);
      const want = this.want(v);
      if (arrive && b.kind === 'customer' && b.status !== 'finished') {
        this.place(v, 'out');
        v.appear = 1;
      } else this.place(v, want);
      if (b.status === 'finished') v.timer = 4 + Math.random() * 5;
    }
    this.bots.set(b.id, v);
    return v;
  }

  private dropBot(v: BotView) {
    if (v.fig) {
      v.fig.root.removeFromParent();
      for (const m of v.fig.mats) { if (m.mat instanceof THREE.SpriteMaterial) m.mat.map?.dispose(); m.mat.dispose(); }
      v.fig.root.traverse((o) => { if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshBasicMaterial && !this.kit.shared(o.material)) o.material.dispose(); });
    }
    if (v.anchor) { v.anchor.removeFromParent(); (v.anchor as THREE.Mesh).geometry.dispose(); ((v.anchor as THREE.Mesh).material as THREE.Material).dispose(); }
    this.bots.delete(v.id);
  }

  // ---- walking

  private spot(v: BotView, at: At): Spot {
    const h = this.h, r = v.zone;
    if (at === 'pc') return pcSpot(h, r, v.pc);
    if (at === 'pay') { const p = paySpot(h, r); p.p.z += (Math.floor(v.phase * 10) % 3 - 1) * 0.4; return p; }
    if (at === 'out') return outSpot(h);
    if (at === 'lead') return { p: v3(LEAD_X, h.row(r) + 0.6), yaw: 0.3, entry: [] };
    if (at === 'room') return { p: v3(-HW + 0.6, 0), yaw: 0, entry: [] };
    const i = Number(at.slice(5));
    return restSpots(h)[i] ?? pcSpot(h, r, 0);
  }

  /** where this one should be now */
  private want(v: BotView): At {
    if (v.kind === 'lead') return 'lead';
    if (v.kind === 'shell') return 'room';
    if (v.status === 'finished' || v.seat === EXIT) {
      if (v.at === 'out' && !v.path.length && v.gone) return 'out';
      if (v.at === 'pay' && !v.path.length) return v.timer <= 0 && !this.reduced ? 'out' : 'pay';
      return v.dest === 'out' ? 'out' : 'pay';
    }
    if (v.status === 'resting' && !this.reduced) {
      if (v.at.startsWith('rest')) return v.timer <= 0 ? 'pc' : v.at;
      if (v.at === 'pc' && v.timer <= 0) {
        const taken = new Set([...this.bots.values()].filter((o) => o !== v).map((o) => (o.path.length ? o.dest : o.at)));
        const free = restSpots(this.h).map((_, i) => `rest:${i}` as At).filter((a) => !taken.has(a));
        if (free.length) return free[Math.floor(Math.random() * free.length)];
        v.timer = 3 + Math.random() * 4;
      }
      return 'pc';
    }
    return 'pc';
  }

  /** straight there (first load, reduced motion, a zone that moved) */
  private place(v: BotView, at: At) {
    const s = this.spot(v, at);
    v.pos.copy(s.p);
    v.yaw = v.yawGoal = s.yaw;
    v.at = v.dest = at;
    v.path = [];
    v.sit = s.sit ? 1 : 0;
    v.gone = at === 'out';
  }

  private go(v: BotView, to: At) {
    if (this.reduced) { this.place(v, to); return; }
    const from = this.spot(v, v.at);
    from.p = v.pos.clone();
    v.path = route(from, this.spot(v, to));
    v.dest = to;
    v.gone = false;
  }

  private walk(v: BotView, dt: number): boolean {
    if (!v.fig) return false;
    if (v.path.length) {
      // stand up first
      if (v.sit > 0) { v.sit = Math.max(0, v.sit - dt * 3); return true; }
      let left = WALK * dt;
      while (left > 0 && v.path.length) {
        const p = v.path[0], d = p.distanceTo(v.pos);
        if (d > 1e-4) v.yawGoal = Math.atan2(p.x - v.pos.x, p.z - v.pos.z);
        if (d <= left) { v.pos.copy(p); v.path.shift(); left -= d; } else { v.pos.lerp(p, left / d); left = 0; }
      }
      if (!v.path.length) {
        const s = this.spot(v, v.dest);
        v.at = v.dest;
        v.yawGoal = s.yaw;
        v.timer = v.at === 'pay' ? 4.5 : v.at.startsWith('rest') ? 6 + Math.random() * 7 : 5 + Math.random() * 9;
        if (v.at === 'out') v.gone = true;
      }
      return true;
    }
    const s = this.spot(v, v.at);
    const sitGoal = s.sit ? 1 : 0;
    if (v.sit !== sitGoal) { v.sit = Math.abs(v.sit - sitGoal) < 0.02 ? sitGoal : v.sit + Math.sign(sitGoal - v.sit) * dt * 3; return true; }
    return false;
  }

  // ---- views

  /** -1: the whole hall; else that zone's row (the others dim a little) */
  focus(index: number, instant = false) {
    this.focusIndex = index >= 0 && index < this.h.rows ? index : -1;
    if (this.focusIndex < 0) {
      this.goal.target.set(0, 0.4, 0.4);
      this.goal.radius = this.baseRadius();
      this.goal.theta = Math.PI / 4;
      this.goal.phi = 0.98;
    } else {
      this.goal.target.set(0.2, 0.9, this.h.row(this.focusIndex) + 0.6);
      this.goal.radius = this.baseRadius();
      this.goal.theta = Math.PI / 4.3;
      this.goal.phi = 0.92;
    }
    this.applyDims(instant || this.reduced);
    if (instant || this.reduced) this.snap();
    this.dirty = true;
  }

  private applyDims(instant: boolean) {
    for (let i = 0; i < this.h.rows; i++) {
      const goal = this.focusIndex >= 0 && i !== this.focusIndex ? 1 : 0;
      if (instant) this.dims[i] = goal;
    }
  }

  private fit(R: number) {
    const a = Math.max(0.2, (this.size.w - this.inset.left - this.inset.right) / this.size.h);
    const half = (FOV * Math.PI) / 360;
    const r = R / Math.sin(half);
    return a < 1 ? r / a : r;
  }

  private snap() {
    this.cur.target.copy(this.goal.target);
    this.cur.radius = this.goal.radius;
    this.cur.theta = this.goal.theta;
    this.cur.phi = this.goal.phi;
    this.night = this.nightGoal;
    this.applyNight();
  }

  setNight(on: boolean, instant = false) {
    this.nightGoal = on ? 1 : 0;
    if (instant || this.reduced) this.night = this.nightGoal;
    this.applyNight();
    this.dirty = true;
  }

  private applyNight() {
    const t = this.night;
    const bg = hex(P.bg[0]).lerp(hex(P.bg[1]), t);
    (this.scene.background as THREE.Color).copy(bg);
    this.scene.fog!.color.copy(bg);
    this.hemi.color.set('#fff6ea').lerp(hex('#7a6cd8'), t);
    this.hemi.groundColor.set('#cdb89c').lerp(hex('#120f24'), t);
    this.hemi.intensity = 1.55 * (1 - t) + 0.75 * t;
    this.sun.color.set('#ffe7c4').lerp(hex('#8f9cff'), t);
    this.sun.intensity = 2.8 * (1 - t) + 0.35 * t;
    this.pinkLight.intensity = 18 * t;
    this.cyanLight.intensity = 16 * t;
    this.deskLight.intensity = 22 * t;
    this.renderer.toneMappingExposure = 1.0 + 0.12 * t;
    this.world.tint(t);
    this.outside.tint(t);
    const b = this.outside.by.get('building');
    if (b && 'emissiveIntensity' in b.mat) b.mat.emissiveIntensity = 0.03 + 0.75 * t;
    for (const rv of this.rows) { rv.mats.tint(t); rv.light.intensity = rv.used ? 7 * t * (1 - 0.6 * rv.mats.dim) : 0; }
  }

  zoom(): number { return this.baseRadius() / this.goal.radius; }
  private baseRadius() {
    if (this.focusIndex >= 0) return this.fit(6.4);
    return this.fit(Math.sqrt(HW ** 2 + (this.h.D / 2) ** 2) * 0.74);
  }
  setZoom(z: number) { this.goal.radius = this.baseRadius() / z; this.dirty = true; }
  rotate(dx: number, dy: number) {
    this.goal.theta -= dx * 0.0065;
    this.goal.phi = Math.max(0.3, Math.min(1.35, this.goal.phi - dy * 0.0055));
    this.dirty = true;
  }
  pan(dx: number, dy: number) {
    const s = (this.cur.radius * Math.tan((FOV * Math.PI) / 360) * 2) / this.size.h;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.goal.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    this.goal.target.y = Math.max(-1, Math.min(6, this.goal.target.y));
    this.dirty = true;
  }
  reset() { this.focus(this.focusIndex); }

  resize(w: number, h: number, inset = this.inset) {
    const changed = w !== this.size.w || h !== this.size.h || inset.left !== this.inset.left || inset.right !== this.inset.right;
    this.size = { w: Math.max(1, w), h: Math.max(1, h) };
    this.inset = inset;
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.camera.aspect = this.size.w / this.size.h;
    const off = (inset.right - inset.left) / 2;
    this.camera.setViewOffset(this.size.w, this.size.h, off, 0, this.size.w, this.size.h);
    this.camera.updateProjectionMatrix();
    if (changed) this.focus(this.focusIndex, this.frames === 0);
    this.dirty = true;
  }

  // ---- picking

  private ray = new THREE.Raycaster();
  /** what is under a point of the canvas (client px relative to it) */
  pick(x: number, y: number): { bot?: string; zone?: number } {
    const ndc = new THREE.Vector2((x / this.size.w) * 2 - 1, -(y / this.size.h) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const live = [...this.bots.values()].filter((b) => !b.leaving && !b.gone);
    const objs = live.map((b) => (b.fig ? b.fig.body : b.anchor!));
    const hits = this.ray.intersectObjects(objs, true);
    if (hits.length) {
      let o: THREE.Object3D | null = hits[0].object;
      while (o && !objs.includes(o)) o = o.parent;
      const i = o ? objs.indexOf(o) : -1;
      if (i >= 0) return { bot: live[i].id };
    }
    let best: { i: number; d: number } | null = null;
    for (const rv of this.rows) {
      if (!rv.used) continue;
      const z = this.h.row(rv.index);
      const box = new THREE.Box3(new THREE.Vector3(ROW_X0 - 0.4, 0, z - 0.6), new THREE.Vector3(LEAD_X + 0.5, 3.0, z + 1.6));
      const p = this.ray.ray.intersectBox(box, new THREE.Vector3());
      if (p) { const d = p.distanceTo(this.ray.ray.origin); if (!best || d < best.d) best = { i: rv.index, d }; }
    }
    return best ? { zone: best.i } : {};
  }

  // ---- overlays (HTML anchored to the scene)

  bindOverlays(root: HTMLElement | null) {
    this.overlayRoot = root;
    this.overlays = [];
    if (root) for (const el of root.querySelectorAll<HTMLElement>('[data-anchor]')) {
      const [kind, ...rest] = (el.dataset.anchor ?? '').split(':');
      if (kind === 'zone' || kind === 'bot') this.overlays.push({ el, kind, id: rest.join(':'), w: el.offsetWidth, h: el.offsetHeight });
    }
    this.dirty = true;
  }

  private tmp = new THREE.Vector3();
  private placeOverlays() {
    if (!this.overlayRoot) return;
    const tags: { o: { el: HTMLElement; w: number; h: number }; x: number; y: number; raw: number; show: boolean }[] = [];
    for (const o of this.overlays) {
      let show = true, phase = '';
      if (o.kind === 'zone') {
        const i = Number(o.id);
        if (i >= this.h.rows) { o.el.style.visibility = 'hidden'; continue; }
        this.tmp.set(ROW_X0 + 0.25, 3.0, this.h.row(i) - 0.3);
      } else {
        const b = this.bots.get(o.id);
        if (!b) { o.el.style.visibility = 'hidden'; continue; }
        if (b.anchor) { b.anchor.getWorldPosition(this.tmp); this.tmp.y += b.anchor.userData.top as number; phase = 'room'; }
        else {
          this.tmp.copy(b.fig!.root.position);
          this.tmp.y += 1.05 + b.sit * 0.4;
          show = !b.gone && b.appear > 0.3 && b.pos.z > this.h.back - 0.3;
          phase = b.path.length ? 'walk' : b.at === 'pay' ? 'pay' : b.sit > 0.5 ? 'sit' : 'stand';
        }
      }
      this.tmp.project(this.camera);
      if (this.tmp.z > 1) show = false;
      const x = ((this.tmp.x + 1) / 2) * this.size.w, y = ((1 - this.tmp.y) / 2) * this.size.h;
      if (o.kind === 'zone') { tags.push({ o, x, y, raw: y, show }); continue; }
      o.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      o.el.style.visibility = show ? '' : 'hidden';
      if (phase && o.el.dataset.phase !== phase) o.el.dataset.phase = phase;
    }
    this.placeTags(tags);
  }

  /** The zone signs' tags, pushed apart in screen space (the far rows' first, each one moved down below any it would
   *  cover); a leader line (`--lead`) runs from a moved tag back up to its row's sign. The tag's bottom centre is at (x, y). */
  private placeTags(tags: { o: { el: HTMLElement; w: number; h: number }; x: number; y: number; raw: number; show: boolean }[]) {
    const GAP = 4;
    const placed: typeof tags = [];
    for (const t of [...tags].sort((a, b) => a.raw - b.raw)) {
      if (!t.show) continue;
      const w = t.o.w || 120, h = t.o.h || 24;
      // only ever down (t.y grows), so this ends; the cap is a guard
      for (let moved = true, n = 0; moved && n < 64; n++) {
        moved = false;
        for (const p of placed) {
          const pw = p.o.w || 120, ph = p.o.h || 24;
          const xOver = Math.abs(t.x - p.x) < (w + pw) / 2 + GAP;
          const yOver = t.y - h < p.y + GAP && t.y > p.y - ph - GAP;
          if (xOver && yOver && p.y + h + GAP > t.y) { t.y = p.y + h + GAP; moved = true; }
        }
      }
      placed.push(t);
    }
    for (const t of tags) {
      const el = t.o.el;
      el.style.transform = `translate3d(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px, 0)`;
      el.style.visibility = t.show ? '' : 'hidden';
      const lead = Math.max(0, t.y - (t.o.h || 24) - t.raw);
      el.style.setProperty('--lead', `${lead.toFixed(1)}px`);
      el.classList.toggle('led', lead > 2);
    }
  }

  // ---- the loop

  start() {
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, this.last ? (t - this.last) / 1000 : 0.016);
      this.last = t;
      if (!this.visible || document.hidden) return;
      const m = this.step(dt, t / 1000);
      // ambient motion only (bobbing, neon): a calmer frame rate
      if (m === 2 || this.dirty || (m === 1 && t - this.lastDraw > 1000 / 24)) {
        this.dirty = false;
        this.lastDraw = t;
        this.decorate(t / 1000);
        this.renderer.render(this.scene, this.camera);
        this.placeOverlays();
        this.frames++;
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** advance everything; 0: still, 1: only ambient motion, 2: something really moves */
  private step(dt: number, time: number): 0 | 1 | 2 {
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 5);
    let fast = false, ambient = false;
    const ease = (a: number, b: number, eps: number) => { if (Math.abs(a - b) < eps) return b; fast = true; return a + (b - a) * k; };
    const c = this.cur, g = this.goal;
    c.radius = ease(c.radius, g.radius, 0.005);
    c.theta = ease(c.theta, g.theta, 0.0002);
    c.phi = ease(c.phi, g.phi, 0.0002);
    if (c.target.distanceToSquared(g.target) > 1e-6) { c.target.lerp(g.target, k); fast = true; } else c.target.copy(g.target);
    const sp = Math.sin(c.phi);
    this.camera.position.set(c.target.x + c.radius * sp * Math.sin(c.theta), c.target.y + c.radius * Math.cos(c.phi), c.target.z + c.radius * sp * Math.cos(c.theta));
    this.camera.lookAt(c.target);
    this.camera.updateMatrixWorld();
    if (this.night !== this.nightGoal) {
      this.night = Math.abs(this.night - this.nightGoal) < 0.004 ? this.nightGoal : this.night + (this.nightGoal - this.night) * (1 - Math.exp(-dt * 4));
      this.applyNight();
      fast = true;
    }
    // the zones not in focus dim a little
    let dimmed = false;
    for (const rv of this.rows) {
      const goal = this.focusIndex >= 0 && rv.index !== this.focusIndex ? 1 : 0;
      const d = this.dims[rv.index] ?? 0;
      this.dims[rv.index] = d;
      if (d !== goal) { this.dims[rv.index] = Math.abs(d - goal) < 0.01 ? goal : d + (goal - d) * k; dimmed = true; }
      if (rv.mats.dim !== this.dims[rv.index]) { rv.mats.dim = this.dims[rv.index]; rv.mats.tint(this.night); rv.light.intensity = rv.used ? 7 * this.night * (1 - 0.6 * rv.mats.dim) : 0; }
    }
    if (dimmed) fast = true;
    // people
    for (const v of [...this.bots.values()]) {
      if (v.leaving) {
        v.appear = this.reduced ? 0 : v.appear - dt * 3;
        if (v.appear <= 0) { this.dropBot(v); fast = true; continue; }
        fast = true;
      } else if (v.appear < 1) { v.appear = Math.min(1, v.appear + dt * 2.5); fast = true; }
      if (!v.fig) continue;
      if (!v.path.length && !v.leaving) {
        v.timer -= dt;
        const w = this.want(v);
        if (w !== v.at) this.go(v, w);
      }
      if (this.walk(v, dt)) fast = true;
      // turn smoothly
      let dy = v.yawGoal - v.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      if (Math.abs(dy) > 0.002) { v.yaw += dy * (this.reduced ? 1 : Math.min(1, dt * 9)); fast = true; } else v.yaw = v.yawGoal;
      if (this.animate(v, time)) fast = true; else if (!this.reduced) ambient = true;
    }
    return fast ? 2 : ambient ? 1 : 0;
  }

  /** a person's pose this frame; true: a real motion (walking, typing, waving) */
  private animate(v: BotView, time: number): boolean {
    const f = v.fig!;
    const tt = time + v.phase;
    const walking = v.path.length > 0 && v.sit === 0;
    const dimF = 1 - 0.5 * (this.dims[v.zone] ?? 0);
    for (const m of f.mats) {
      const want = m.base.clone().multiplyScalar(dimF);
      if (!m.mat.color.equals(want)) m.mat.color.copy(want);
    }
    f.root.position.set(v.pos.x, 0, v.pos.z);
    f.root.rotation.y = f.sprite ? 0 : v.yaw;
    // through the door: out of sight
    const outside = Math.max(0, Math.min(1, (this.h.back - 0.2 - v.pos.z) / 0.8));
    const sc = easeOutBack(Math.max(0, Math.min(1, v.appear))) * (1 - outside) * 1.3;
    f.root.scale.setScalar(Math.max(0.001, sc));
    f.root.visible = sc > 0.01 && !v.gone;
    let bob = 0, real = false, lean = 0;
    let hl = { y: 0.28, z: 0.12 }, hr = { y: 0.28, z: 0.12 };
    const seated = v.sit;
    if (seated > 0.5) { hl = { y: 0.3, z: 0.22 }; hr = { y: 0.3, z: 0.22 }; }
    if (!this.reduced) {
      if (walking) {
        bob = Math.abs(Math.sin(tt * 9)) * 0.06;
        hl = { y: 0.28, z: 0.12 + Math.sin(tt * 9) * 0.08 };
        hr = { y: 0.28, z: 0.12 - Math.sin(tt * 9) * 0.08 };
        real = true;
      } else if (v.status === 'working' && (seated > 0.5 || v.kind === 'lead')) {
        bob = Math.abs(Math.sin(tt * 4)) * 0.012;
        hl = { y: 0.3 + Math.max(0, Math.sin(tt * 16)) * 0.05, z: 0.24 };
        hr = { y: 0.3 + Math.max(0, Math.sin(tt * 16 + 2)) * 0.05, z: 0.24 };
        real = true;
      } else if (v.status === 'waiting') {
        bob = Math.max(0, Math.sin(tt * 3)) * 0.04;
        hr = { y: 0.78 + Math.sin(tt * 6) * 0.05, z: 0.08 };
        real = true;
      } else if (v.status === 'stuck') {
        lean = 0.18 + (Math.sin(tt * 1.3) > 0.6 ? Math.sin(tt * 20) * 0.05 : 0);
        hl = { y: 0.24, z: 0.16 }; hr = { y: 0.24, z: 0.16 };
      } else bob = (Math.sin(tt * 1.8) + 1) * 0.012;
    } else if (v.status === 'waiting') hr = { y: 0.78, z: 0.08 };
    else if (v.status === 'stuck') lean = 0.18;
    f.body.position.y = seated * (SEAT_Y - 0.08) + bob;
    f.body.rotation.x = lean;
    if (f.legs) { f.legs.rotation.x = seated * -0.5; f.legs.rotation.y = walking && !this.reduced ? Math.sin(tt * 9) * 0.25 : 0; }
    if (f.handL && f.handR) {
      f.handL.position.set(-0.2 + seated * 0.06, hl.y, hl.z);
      f.handR.position.set(0.2 - seated * 0.06, hr.y, hr.z);
    }
    return real;
  }

  /** screens, the neon's pulse, the rooms: from who sits where now */
  private decorate(time: number) {
    const pulse = this.reduced ? 1 : 0.88 + 0.12 * Math.sin(time * 2.2);
    const sign = this.world.by.get('sign');
    if (sign) sign.mat.color.lerpColors(sign.day, sign.night, this.night).multiplyScalar(this.night > 0.5 ? pulse : 1);
    for (const key of ['neonPink', 'neonCyan']) { const s = this.world.by.get(key); if (s) s.mat.color.lerpColors(s.day, s.night, this.night).multiplyScalar(0.75 + 0.25 * pulse * this.night + 0.25 * (1 - this.night)); }
    // who is at which PC
    const occ = new Map<string, BotView>();
    for (const v of this.bots.values()) if (v.kind === 'customer' && v.seat >= 0 && v.seat < PCS && !v.leaving) occ.set(`${v.zone}:${v.seat}`, v);
    for (const rv of this.rows) {
      const f = 1 - 0.5 * (this.dims[rv.index] ?? 0);
      rv.screens.forEach((s, i) => {
        const v = occ.get(`${rv.index}:${i}`);
        const here = v && v.at === 'pc' && !v.path.length;
        const st = !v ? 'off' : !here ? 'idle' : v.status === 'working' ? 'code' : v.status === 'waiting' ? 'wait' : v.status === 'stuck' ? 'bsod' : 'idle';
        const m = s.material as THREE.MeshBasicMaterial;
        if (s.userData.state !== st) {
          s.userData.state = st;
          if (st === 'code') {
            if (!s.userData.own) { const t = this.tex.code.clone(); t.needsUpdate = true; t.offset.y = Math.random(); s.userData.own = t; }
            m.map = s.userData.own as THREE.Texture;
          } else m.map = st === 'wait' ? this.tex.wait : st === 'bsod' ? this.tex.bsod : st === 'idle' ? this.tex.idle : null;
          m.needsUpdate = true;
        }
        let bright = st === 'off' ? 0.06 : st === 'idle' ? 0.55 : 1;
        if (st === 'code' && !this.reduced) { (s.userData.own as THREE.Texture).offset.y = (time * 0.12 + i * 0.37) % 1; bright *= 0.93 + 0.07 * Math.sin(time * 31 + i * 7); }
        bright *= f * (0.82 + 0.18 * this.night);
        if (st === 'off') m.color.setRGB(0.04, 0.045, 0.08); else m.color.setScalar(bright);
      });
    }
    // the rooms
    const inRoom = new Map<number, BotView>();
    for (const v of this.bots.values()) if (v.kind === 'shell' && !v.leaving) inRoom.set(v.seat, v);
    this.rooms.forEach((r, i) => {
      const v = inRoom.get(i);
      const on = v?.status === 'working';
      const m = r.screen.material as THREE.MeshBasicMaterial;
      const want = v ? this.tex.termOn : this.tex.termOff;
      if (m.map !== want) { m.map = want; m.needsUpdate = true; }
      if (v && !this.reduced) { want.offset.y = 0; }
      const col = !v ? '#4a4e66' : on ? '#3dff8a' : v.status === 'stuck' ? '#ff4b4b' : v.status === 'finished' ? '#5aa9ff' : '#9aa0b8';
      (r.lamp.material as THREE.MeshBasicMaterial).color.set(col).multiplyScalar(on ? pulse * 1.3 : 1);
      m.color.setScalar(v ? (on ? 0.9 + 0.1 * pulse : 0.6) : 0.3);
    });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const v of [...this.bots.values()]) this.dropBot(v);
    for (const rv of this.rows) this.disposeRow(rv);
    this.disposeGroup(this.hallGroup);
    this.scene.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose(); });
    for (const g of this.tplRow.values()) g.dispose();
    this.screenGeo.dispose();
    this.kit.dispose();
    this.world.dispose();
    this.outside.dispose();
    for (const t of Object.values(this.tex)) t?.dispose();
    this.renderer.dispose();
  }
}

function easeOutBack(x: number) {
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

let webgl: boolean | undefined;
/** Whether WebGL works here at all (a plain list otherwise). Probed once; the probe's context is released (browsers cap live contexts). */
export function webglOk(): boolean {
  if (webgl !== undefined) return webgl;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    webgl = !!gl;
  } catch { webgl = false; }
  return webgl;
}
