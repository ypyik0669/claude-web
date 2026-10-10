// How a connector looks in the directory (structure round 2, spec §4): the service's own mark where there is one
// (ui/brand-icons.generated.ts, from simple-icons — `node scripts/gen-brand-icons.mjs`), else one of our icons, in a
// tile of the mark's colour. Pure.
import type { IconName } from '@/ui/icons';
import type { Tint } from '@/features/automation/templates';
import { BRAND_ICONS } from '@/ui/brand-icons.generated';

export interface ConnectorLook {
  /** the brand mark's path (24 × 24, filled) and colour; none → `icon` */
  brand?: { path: string; color: string };
  icon: IconName;
  tint: Tint;
}

/** catalog id → simple-icons slug (scripts/gen-brand-icons.mjs reads this file's SLUGS through brand-map.json) */
const GENERIC: Record<string, { icon: IconName; tint: Tint }> = {
  filesystem: { icon: 'folder', tint: 'info' },
  memory: { icon: 'memory', tint: 'accent' },
  'sequential-thinking': { icon: 'todo', tint: 'ink' },
  fetch: { icon: 'web', tint: 'info' },
  exa: { icon: 'search', tint: 'info' },
  context7: { icon: 'library', tint: 'ok' },
  time: { icon: 'tasks', tint: 'ink' },
  everything: { icon: 'sparkle', tint: 'warn' },
  'aws-docs': { icon: 'cloud', tint: 'warn' },
  sqlite: { icon: 'database', tint: 'info' },
  slack: { icon: 'chat', tint: 'accent' },
  playwright: { icon: 'browser', tint: 'ok' },
  puppeteer: { icon: 'browser', tint: 'ok' },
  postgres: { icon: 'database', tint: 'info' },
};

/**
 * A mark this dark (or this light) would vanish on one of the themes' tiles: it is drawn in the text colour instead.
 * Relative luminance of an `rrggbb` colour, 0…1.
 */
export function luminance(hex: string): number {
  const n = parseInt(hex, 16);
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
export function brandColor(hex: string): string {
  const l = luminance(hex);
  return l < 0.06 || l > 0.8 ? 'var(--ink-1)' : `#${hex}`;
}

export function connectorLook(id: string): ConnectorLook {
  const b = BRAND_ICONS[id];
  const g = GENERIC[id] ?? { icon: 'mcp' as IconName, tint: 'ink' as Tint };
  return b ? { brand: { path: b.path, color: brandColor(b.hex) }, ...g } : g;
}
