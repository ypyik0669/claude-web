/**
 * The app's only icon set. Hand-drawn on a 24×24 grid, 1.75 stroke, round caps —
 * no dependency, no emoji, one optical weight everywhere.
 *
 * Every glyph is a path list; `Icon` renders them at `size` in `currentColor`,
 * so an icon inherits whatever colour its row/button already has. A few glyphs
 * need a filled dot or a different cap — those carry their own attrs.
 *
 * Adding one: draw inside 3..21 so it optically matches the rest, keep strokes on
 * the half-pixel grid (…​.5) at 24px, and prefer two strokes over a busy outline.
 */
export type IconName = keyof typeof PATHS;

type P = string | [string, Record<string, string | number>];

const PATHS = {
  // ---- panels -------------------------------------------------------------
  mission: ['M12 3v3M12 18v3M3 12h3M18 12h3', ['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', { fill: 'currentColor', stroke: 'none' }], 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z'],
  goals: ['M5 21V4.5', 'M5 5.5h11.5l-1.8 3.4 1.8 3.4H5'],
  // one source node fanning out to two agents
  orchestra: ['M5 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M19 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M19 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M7.5 12h2.2c1.6 0 2.3-1 2.8-2.5S14.1 6 16.5 6', 'M9.7 12c1.6 0 2.3 1 2.8 2.5s1.6 3.5 4 3.5'],
  compare: ['M4 5h6.5v14H4z', 'M13.5 5H20v14h-6.5z', 'M6.5 9h1.5M16 9h1.5M6.5 12.5h1.5M16 12.5h1.5'],
  approval: ['M12 3.5l7 2.8v5.2c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6.3z', 'M8.8 12.2l2.2 2.2 4.2-4.4'],
  tasks: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 7.8V12l2.8 1.8'],
  files: ['M6 3.5h7l5 5v12H6z', 'M13 3.5v5h5', 'M9.5 14h5M12 11.5v5'],
  usage: ['M4 20h16', 'M7.5 20v-6M12 20V7M16.5 20v-9'],
  config: ['M4 7.5h4M13 7.5h7M4 16.5h7M16 16.5h4', 'M10.5 5.5v4M13.5 14.5v4'],
  terminal: ['M3.5 5.5h17v13h-17z', 'M7 10l2.5 2.2L7 14.4M12.5 15h4.5'],
  inspector: ['M3.5 5h17v14h-17z', 'M14.5 5v14'],
  android: ['M7 3.5h10v17H7z', 'M10.5 17.5h3'],
  board: ['M3.5 4.5h17v15h-17z', 'M9.5 4.5v15M15 4.5v15'],
  memory: ['M12 5.2c-2.4-1.9-6 -.3-6 2.6 -1.7.9-1.7 3.5 0 4.5 -.4 2.6 2.6 4.3 4.6 2.8', 'M12 5.2c2.4-1.9 6-.3 6 2.6 1.7.9 1.7 3.5 0 4.5 .4 2.6-2.6 4.3-4.6 2.8', 'M12 5.2V20'],
  browser: ['M3.5 4.5h17v15h-17z', 'M3.5 9h17', 'M6.5 6.75h.01M9 6.75h.01'],

  // ---- tools --------------------------------------------------------------
  read: ['M6 3.5h7l5 5v12H6z', 'M13 3.5v5h5', 'M9 12.5h6M9 15.5h4'],
  write: ['M6 3.5h7l5 5v12H6z', 'M13 3.5v5h5', 'M12 11.5v5M9.5 14h5'],
  edit: ['M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10z', 'M14 7l3 3'],
  bash: ['M3.5 5.5h17v13h-17z', 'M7 10l2.5 2.2L7 14.4M12.5 15h4.5'],
  search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M15.8 15.8L20 20'],
  glob: ['M3.5 6.5a2 2 0 0 1 2-2h3.2l1.8 2.3h8a2 2 0 0 1 2 2v9.7a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z', 'M9.5 13.5h5'],
  web: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M3.6 12h16.8', 'M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.3-3.3-8.5s1.1-6.1 3.3-8.5z'],
  agent: ['M6 8.5h12v10H6z', 'M12 4.5v4', 'M9.5 12.5h.01M14.5 12.5h.01', 'M9.5 15.8h5'],
  mcp: ['M8.5 3.5v6M15.5 3.5v6', 'M6 9.5h12v3a6 6 0 0 1-12 0z', 'M12 18.5v2'],
  skill: ['M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6L5.5 10l4.6-1.9z', 'M18 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z'],
  todo: ['M4 6.5l1.6 1.6L8.4 5.3M4 12.5l1.6 1.6 2.8-2.8M4 18.5l1.6 1.6 2.8-2.8', 'M11.5 7h8.5M11.5 13h8.5M11.5 19h8.5'],
  plan: ['M7.5 4.5h9v16h-9z', 'M9.5 3h5v3h-5z', 'M10 11h4M10 15h4'],
  question: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.6', ['M12 16.6h.01', { 'stroke-width': 2.2 }]],
  artifact: ['M12 3.5l7.5 4.2v8.6L12 20.5 4.5 16.3V7.7z', 'M4.7 7.8L12 12l7.3-4.2M12 12v8.5'],
  workflow: ['M7 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17.5 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M7 9.5v5', 'M17.5 9.5v1.5a3 3 0 0 1-3 3H10'],
  image: ['M3.5 5h17v14h-17z', 'M8.2 10.2a1.3 1.3 0 1 0 0-.02z', 'M3.5 16.5l4.8-4 4 3.3 3.2-2.6 3 2.6'],

  // ---- chrome -------------------------------------------------------------
  sidebar: ['M3.5 5h17v14h-17z', 'M9.5 5v14'],
  splitRight: ['M3.5 5h17v14h-17z', 'M12 5v14', 'M15 12h3M16.5 10.5L18 12l-1.5 1.5'],
  splitDown: ['M3.5 5h17v14h-17z', 'M3.5 12h17', 'M12 15v3M10.5 16.5L12 18l1.5-1.5'],
  zoom: ['M4 9V4.5h4.5M20 15v4.5h-4.5M15.5 4.5H20V9M8.5 19.5H4V15'],
  close: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
  minimize: ['M4 5v14', 'M9 12h11M15.5 7.5L20 12l-4.5 4.5'],
  restore: ['M20 5v14', 'M15 12H4M8.5 7.5L4 12l4.5 4.5'],
  more: [['M6 12h.01M12 12h.01M18 12h.01', { 'stroke-width': 2.4 }]],
  refresh: ['M20 6.5v5h-5', 'M19.4 11.5a7.5 7.5 0 1 0-1.6 5.4'],
  chevronRight: ['M9.5 5.5l6.5 6.5-6.5 6.5'],
  chevronDown: ['M5.5 9.5l6.5 6.5 6.5-6.5'],
  plus: ['M12 5v14M5 12h14'],
  check: ['M5 12.5l4.6 4.5L19 7.5'],
  checkCircle: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M8.2 12.2l2.7 2.6 4.9-5.2'],
  circle: ['M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z'],
  dot: [['M12 12a3 3 0 1 0 0-.01z', { fill: 'currentColor', stroke: 'none' }]],
  alert: ['M12 4.2L21 19.5H3z', 'M12 10v4', ['M12 17h.01', { 'stroke-width': 2.2 }]],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 11.2v5', ['M12 8h.01', { 'stroke-width': 2.2 }]],
  command: ['M8.5 4.5a2.5 2.5 0 1 1 2.5 2.5h-2.5zM15.5 4.5a2.5 2.5 0 1 0-2.5 2.5h2.5zM8.5 19.5a2.5 2.5 0 1 0 2.5-2.5h-2.5zM15.5 19.5a2.5 2.5 0 1 1-2.5-2.5h2.5z', 'M8.5 8.5h7v7h-7z'],
  keyboard: ['M3 6.5h18v11H3z', 'M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 14h11'],
  settings: ['M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z', 'M19.1 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1v.3a1.8 1.8 0 1 1-3.6 0v-.2a1.5 1.5 0 0 0-2.6-1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.5h-.3a1.8 1.8 0 1 1 0-3.6h.2a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.3a1.8 1.8 0 1 1 3.6 0v.2a1.5 1.5 0 0 0 2.5 1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.3a1.8 1.8 0 1 1 0 3.6h-.2a1.5 1.5 0 0 0-1.4.9z'],
  pin: ['M9 3.5h6l-.8 6 3.3 3.2H6.5L9.8 9.5z', 'M12 12.7v7.8'],
  archive: ['M3.5 4.5h17v4h-17z', 'M5.5 8.5v11h13v-11', 'M10 12.5h4'],
  trash: ['M4.5 6.5h15', 'M9 6.5V4.2h6v2.3', 'M6.5 6.5l1 13h9l1-13', 'M10.5 10v6M13.5 10v6'],
  copy: ['M9 9h11v11H9z', 'M15 9V4H4v11h5'],
  quote: ['M10 7H5.5v5H10v-5', 'M10 12c0 2.8-1.2 4.4-3.8 5.3', 'M18.5 7H14v5h4.5v-5', 'M18.5 12c0 2.8-1.2 4.4-3.8 5.3'],
  external: ['M14 4.5h5.5V10', 'M19.5 4.5L11 13', 'M17 13.5v5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V9A1.5 1.5 0 0 1 6 7.5h5'],
  folder: ['M3.5 6.5a2 2 0 0 1 2-2h3.2l1.8 2.3h8a2 2 0 0 1 2 2v9.7a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z'],
  branch: ['M7 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M7 9.5v5', 'M17 9.5v1a4 4 0 0 1-4 4H7'],
  commit: ['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M3.5 12h5M15.5 12h5'],
  play: ['M8.5 5.2l10 6.8-10 6.8z'],
  pause: ['M9 5.5v13M15 5.5v13'],
  stop: ['M6.5 6.5h11v11h-11z'],
  send: ['M12 19.5V5', 'M6 11l6-6 6 6'],
  mic: ['M12 3.5a2.7 2.7 0 0 1 2.7 2.7v5a2.7 2.7 0 0 1-5.4 0v-5A2.7 2.7 0 0 1 12 3.5z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5v3'],
  attach: ['M19 11.2l-7.6 7.6a4.2 4.2 0 0 1-6-6l8-8a2.8 2.8 0 0 1 4 4l-8 8a1.4 1.4 0 0 1-2-2l7.3-7.3'],
  eye: ['M2.8 12S6.5 5.8 12 5.8 21.2 12 21.2 12 17.5 18.2 12 18.2 2.8 12 2.8 12z', 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z'],
  filter: ['M3.5 5.5h17l-6.6 7.6v5.6l-3.8 2v-7.6z'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2.8v2M12 19.2v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.8 12h2M19.2 12h2M4.6 19.4L6 18M18 6l1.4-1.4'],
  moon: ['M20 14.2A8.5 8.5 0 1 1 9.8 4a6.8 6.8 0 0 0 10.2 10.2z'],
  lock: ['M6 10.5h12v9H6z', 'M8.8 10.5V7.8a3.2 3.2 0 0 1 6.4 0v2.7'],
  cloud: ['M6.8 18.5a4 4 0 0 1-.4-8A5.6 5.6 0 0 1 17.3 10a3.8 3.8 0 0 1 .3 7.6z'],
  user: ['M12 4.5a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z', 'M4.8 20.2a7.4 7.4 0 0 1 14.4 0'],
  device: ['M7 3.5h10v17H7z', 'M10.5 17.5h3'],
  chat: ['M4 5.5h16v10H9.5L5.5 19v-3.5H4z'],
  bell: ['M12 3.5a5.5 5.5 0 0 1 5.5 5.5c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5A5.5 5.5 0 0 1 12 3.5z', 'M10.2 18a2 2 0 0 0 3.6 0'],
  bolt: ['M13.5 3l-8 11h5.5l-1.5 7 8-11h-5.5z'],

  // ---- agents -------------------------------------------------------------
  claude: ['M12 3.2v17.6M4.4 7.6l15.2 8.8M19.6 7.6L4.4 16.4'],
  codex: ['M12 3.4l7.4 4.3v8.6L12 20.6 4.6 16.3V7.7z', 'M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z'],
  gemini: ['M12 3.2c.6 4.6 4 8 8.6 8.6-4.6.6-8 4-8.6 8.6-.6-4.6-4-8-8.6-8.6 4.6-.6 8-4 8.6-8.6z'],
  qwen: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 3.5a4.25 4.25 0 0 0 0 8.5 4.25 4.25 0 0 1 0 8.5'],
  kimi: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', ['M12 4.6a7.4 7.4 0 0 1 0 14.8z', { fill: 'currentColor', stroke: 'none' }]],
  opencode: ['M9.5 7.5L4.5 12l5 4.5', 'M14.5 7.5l5 4.5-5 4.5', 'M13 6.5l-2 11'],
} satisfies Record<string, P[]>;

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} focusable="false">
      {title && <title>{title}</title>}
      {(PATHS[name] as P[]).map((p, i) => (typeof p === 'string' ? <path key={i} d={p} /> : <path key={i} d={p[0]} {...p[1]} />))}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Agent kind → icon. Custom ACP agents (`acp:<id>`) fall back to the generic bot. */
export const AGENT_ICONS: Record<string, IconName> = { claude: 'claude', codex: 'codex', gemini: 'gemini', qwen: 'qwen', kimi: 'kimi', opencode: 'opencode' };
