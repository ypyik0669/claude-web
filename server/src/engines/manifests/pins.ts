// SHA-256 values we ship for engine builds (SEC-09). A GitHub asset digest or a checksums file in the same release
// comes from the same place as the binary, so it only proves the download was not damaged; a hash pinned here
// travels with this app and is the only thing that lets a download install without the user confirming its hash.
//
// Source: bundled.json (the builds the desktop installer carries, fetched by scripts/engines/fetch.mjs). Its current
// `version` / `platforms` pin that version; an optional `pins: { "<version>": { "<platform>": { url | asset, sha256 } } }`
// pins further versions without bundling them (fetch.mjs reads only `platforms`). No values are invented here.
import bundled from './bundled.json' with { type: 'json' };
import type { EngineId } from '../types.js';

export interface Pin {
  /** the release asset's file name the hash belongs to */
  asset: string;
  sha256: string;
}

/** engine → version tag → platform key (`${process.platform}-${process.arch}`) → pin */
export type PinTable = Partial<Record<EngineId, Record<string, Record<string, Pin>>>>;

const HEX = /^[0-9a-f]{64}$/i;

const assetOf = (p: { asset?: unknown; url?: unknown }): string | null => {
  if (typeof p.asset === 'string' && p.asset) return p.asset;
  if (typeof p.url === 'string' && p.url) {
    try { return decodeURIComponent(new URL(p.url).pathname.split('/').pop() ?? '') || null; } catch { return null; }
  }
  return null;
};

function platformPins(platforms: unknown): Record<string, Pin> {
  const out: Record<string, Pin> = {};
  if (!platforms || typeof platforms !== 'object') return out;
  for (const [plat, raw] of Object.entries(platforms as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { asset?: unknown; url?: unknown; sha256?: unknown };
    const asset = assetOf(p);
    if (!asset || typeof p.sha256 !== 'string' || !HEX.test(p.sha256)) continue;
    out[plat] = { asset, sha256: p.sha256.toLowerCase() };
  }
  return out;
}

/** Read a bundled.json-shaped object into a pin table (entries without a valid sha256 are left out). */
export function pinsFrom(json: unknown): PinTable {
  const out: PinTable = {};
  if (!json || typeof json !== 'object') return out;
  for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as { version?: unknown; platforms?: unknown; pins?: unknown };
    const versions: Record<string, Record<string, Pin>> = {};
    if (e.pins && typeof e.pins === 'object') {
      for (const [v, plats] of Object.entries(e.pins as Record<string, unknown>)) {
        const p = platformPins(plats);
        if (Object.keys(p).length) versions[v] = p;
      }
    }
    if (typeof e.version === 'string' && e.version) {
      const p = platformPins(e.platforms);
      if (Object.keys(p).length) versions[e.version] = { ...(versions[e.version] ?? {}), ...p };
    }
    if (Object.keys(versions).length) out[id as EngineId] = versions;
  }
  return out;
}

export const PINS: PinTable = pinsFrom(bundled);

export function pinFor(table: PinTable, id: EngineId, version: string, platform: string): Pin | null {
  return table[id]?.[version]?.[platform] ?? null;
}
