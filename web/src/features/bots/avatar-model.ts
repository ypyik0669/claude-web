// 值班 Bot 头像（spec 2026-10-31 聊天优先 A）: a face drawn from the name — one of 12 shapes in one of the ten agent
// colours (--agent-1..10, already ≥ 3:1 on --bg / --bg-1 in every theme, see ui/contrast.test.ts), plus a seed for small
// variations. Stored on Bot.avatar as `shape:<0-11>|color:<0-9>|seed:<n>`; `char:<id>` is batch B's pixel character
// and falls back to the name here.

export interface AvatarFace { shape: number; color: number; seed: number }

/** 12 body outlines in a 32 × 32 box; the eyes sit around y = 15 so every shape leaves room for them. */
export const SHAPES: readonly string[] = [
  // circle
  'M16 3a13 13 0 1 1 0 26a13 13 0 1 1 0-26z',
  // rounded square
  'M9 4h14a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5z',
  // squircle
  'M16 3C26 3 29 6 29 16S26 29 16 29S3 26 3 16S6 3 16 3z',
  // hexagon
  'M16 3l11.3 6.5v13L16 29L4.7 22.5v-13z',
  // octagon
  'M11 3h10l8 8v10l-8 8H11l-8-8V11z',
  // ghost
  'M4 16a12 12 0 0 1 24 0v13l-4-3l-4 3l-4-3l-4 3l-4-3l-4 3z',
  // shield
  'M16 3l12 4v8c0 7.5-5 12-12 14C9 27 4 22.5 4 15V7z',
  // cat ears
  'M5 4l6 5h10l6-5v15a11 10 0 0 1-22 0z',
  // tv with antenna
  'M11 3l5 4l5-4M5 8h22a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
  // rounded diamond
  'M16 2.5l13.5 13.5L16 29.5L2.5 16z',
  // capsule (tall)
  'M16 3a9 9 0 0 1 9 9v8a9 9 0 0 1-18 0v-8a9 9 0 0 1 9-9z',
  // flower / scalloped
  'M16 3a5 5 0 0 1 8 4a5 5 0 0 1 4 8a5 5 0 0 1-2 8a5 5 0 0 1-7 5a5 5 0 0 1-6 0a5 5 0 0 1-7-5a5 5 0 0 1-2-8a5 5 0 0 1 4-8a5 5 0 0 1 8-4z',
];

/** The ten agent colours (tokens.css), so every theme repaints them and the contrast test covers them. */
export const COLORS: readonly string[] = Array.from({ length: 10 }, (_, i) => `var(--agent-${i + 1})`);

/** FNV-1a over UTF-16 code units, then a murmur-style finaliser so short names still spread. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

const STORED = /^shape:(\d+)\|color:(\d+)\|seed:(\d+)$/;

function parse(stored: string | undefined): AvatarFace | null {
  const m = stored ? STORED.exec(stored.trim()) : null;
  if (!m) return null;
  const shape = Number(m[1]), color = Number(m[2]), seed = Number(m[3]);
  if (shape >= SHAPES.length || color >= COLORS.length || !Number.isSafeInteger(seed)) return null;
  return { shape, color, seed };
}

/** The face for a bot: the stored one when it is ours and valid, otherwise derived from the name. */
export function avatarOf(name: string, stored?: string): AvatarFace {
  const own = parse(stored);
  if (own) return own;
  const h = hash(name.trim().toLowerCase());
  return { shape: h % SHAPES.length, color: Math.floor(h / SHAPES.length) % COLORS.length, seed: (h >>> 8) % 1000 };
}

export function avatarString(a: AvatarFace): string {
  return `shape:${a.shape}|color:${a.color}|seed:${a.seed}`;
}
