// Plugin market catalog (spec §6.10 / §7.7): data only, and deliberately no network here.
// The catalog is fetched by the caller (so it can go through the user's proxy / privacy rules) and handed to
// `parseMarketCatalog`; every entry is validated exactly like a local plugin.json, and a download URL must be
// https with no credentials. Installing is a separate step: download the bytes, verify `sha256`, then run the
// same manifest validation again before anything is loaded.
import crypto from 'node:crypto';
import type { PluginHook, PluginPermissions } from './protocol.js';
import { PLUGIN_ID_RE, PLUGIN_VERSION_RE, parseHooks, parsePermissions, MAX_PLUGIN_NAME } from './manifest.js';
import { tr } from '../i18n/index.js';

export const MARKET_CATEGORIES = ['provider', 'middleware', 'tool', 'page', 'theme'] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

export interface MarketEntry {
  id: string;
  name: string;
  author: string;
  description?: string;
  categories: MarketCategory[];
  version: string;
  /** how many times it was installed across the catalog (shown on the card) */
  downloads: number;
  /** https URL of the package / repository archive or declarative JSON; the market layer never downloads it itself */
  url: string;
  /** hex sha256 of the bytes at `url`, when the catalog provides it */
  sha256?: string;
  /** base64 Ed25519 signature of the exact bytes at `url` (verified with the market's public key) */
  signature?: string;
  /** what the package holds: a plugin folder with plugin.json, or one declarative JSON file (default executable) */
  kind: 'declarative' | 'executable';
  /** oldest app version that can load it, e.g. `0.4.0` */
  minAppVersion?: string;
  homepage?: string;
  repository?: string;
  hooks: PluginHook[];
  permissions: PluginPermissions;
  /**
   * The catalog was verified with the configured public key AND this entry pins its bytes (a signature or a
   * SHA-256 covered by the signed catalog). Anything else is unverified code: installing it needs an explicit
   * acknowledgement (`plugins.install { acknowledgeUnverified: true }`).
   */
  verified: boolean;
}

export interface MarketCatalog {
  entries: MarketEntry[];
  /** entries that were dropped, with why (the market shows a count, never a raw stack) */
  errors: { index: number; message: string }[];
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const isCategory = (v: unknown): v is MarketCategory => typeof v === 'string' && (MARKET_CATEGORIES as readonly string[]).includes(v);

function httpsUrl(v: unknown, key: string): string {
  let u: URL;
  try { u = new URL(String(v ?? '')); } catch { throw new Error(tr('插件市场条目的 {key} 必须是 https 地址', { key })); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error(tr('插件市场条目的 {key} 必须是 https 地址', { key }));
  return u.toString();
}

function version(v: unknown, key: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 40 || !PLUGIN_VERSION_RE.test(s)) throw new Error(tr('插件市场条目的 {key} 版本号不合法', { key }));
  return s;
}

/** One catalog entry. Throws a showable message; `parseMarketCatalog` keeps the rest of the catalog usable. */
export function parseMarketEntry(raw: unknown): MarketEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(tr('插件市场条目必须是一个对象'));
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id.trim() : '';
  if (!id || id.length > 64 || !PLUGIN_ID_RE.test(id)) throw new Error(tr('插件市场条目的 id 不合法'));
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name || name.length > MAX_PLUGIN_NAME) throw new Error(tr('插件市场条目缺少名字'));
  const author = typeof v.author === 'string' ? v.author.trim() : '';
  if (!author || author.length > 100) throw new Error(tr('插件市场条目缺少作者'));
  const categories = (Array.isArray(v.categories) ? v.categories : []).filter(isCategory);
  if (!categories.length) throw new Error(tr('插件市场条目至少要有一个分类'));
  const cat = [...new Set(categories)];
  const downloads = typeof v.downloads === 'number' && Number.isFinite(v.downloads) && v.downloads >= 0 ? Math.floor(v.downloads) : 0;
  const sha256 = typeof v.sha256 === 'string' ? v.sha256.trim() : undefined;
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(tr('插件市场条目的校验值不合法'));
  const signature = typeof v.signature === 'string' ? v.signature.trim() : undefined;
  if (signature !== undefined && signatureBytes(signature).length !== 64) throw new Error(tr('插件市场条目的签名不合法'));
  if (v.kind !== undefined && v.kind !== 'declarative' && v.kind !== 'executable') throw new Error(tr('插件市场条目的类型不合法'));
  const url = httpsUrl(v.url, 'url');
  // no kind = a .json package is declarative, everything else is an archive
  const kind: 'declarative' | 'executable' = v.kind === 'declarative' || (v.kind === undefined && /\.json(?:[?#]|$)/i.test(url)) ? 'declarative' : 'executable';
  return {
    id,
    name,
    author,
    ...(str(v.description, 300) ? { description: str(v.description, 300) } : {}),
    categories: cat,
    version: version(v.version, 'version'),
    downloads,
    url,
    ...(sha256 ? { sha256: sha256.toLowerCase() } : {}),
    ...(signature ? { signature } : {}),
    kind,
    ...(v.minAppVersion !== undefined ? { minAppVersion: version(v.minAppVersion, 'minAppVersion') } : {}),
    ...(v.homepage !== undefined ? { homepage: httpsUrl(v.homepage, 'homepage') } : {}),
    ...(v.repository !== undefined ? { repository: httpsUrl(v.repository, 'repository') } : {}),
    hooks: parseHooks(v.hooks),
    permissions: parsePermissions(v.permissions),
    // only parseSignedMarketCatalog may turn this on, after the catalog signature verified
    verified: false,
  };
}

/**
 * A whole catalog: either an array or `{ entries: [...] }`. Invalid entries are reported and dropped, so one
 * bad card cannot take the market down; duplicate ids keep the first (the catalog's order is meaningful).
 */
export function parseMarketCatalog(input: unknown): MarketCatalog {
  const list = Array.isArray(input) ? input : (input && typeof input === 'object' && Array.isArray((input as { entries?: unknown }).entries) ? (input as { entries: unknown[] }).entries : null);
  if (!list) return { entries: [], errors: [{ index: -1, message: tr('插件市场目录必须是一组条目') }] };
  const entries: MarketEntry[] = [];
  const errors: { index: number; message: string }[] = [];
  const seen = new Set<string>();
  list.slice(0, 2000).forEach((raw, index) => {
    try {
      const e = parseMarketEntry(raw);
      if (seen.has(e.id)) throw new Error(tr('插件市场里有重复的 id：{id}', { id: e.id }));
      seen.add(e.id);
      entries.push(e);
    } catch (err) {
      errors.push({ index, message: (err as Error).message });
    }
  });
  return { entries, errors };
}

/** Case-insensitive search over name / author / description, optionally by category. Pure; no network. */
export function searchMarket(entries: MarketEntry[], query = '', category?: MarketCategory): MarketEntry[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((e) => (!category || e.categories.includes(category)))
    .filter((e) => !q || [e.name, e.author, e.id, e.description ?? ''].some((s) => s.toLowerCase().includes(q)))
    .slice()
    .sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
}

const triple = (v: string): [number, number, number] => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
};

/** Is the running app new enough for this entry (no `minAppVersion` = yes)? */
export function isCompatible(entry: Pick<MarketEntry, 'minAppVersion'>, appVersion: string): boolean {
  if (!entry.minAppVersion) return true;
  const a = triple(appVersion);
  const b = triple(entry.minAppVersion);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export const parseCatalog = parseMarketCatalog;
export const searchCatalog = searchMarket;

// ---- signatures (spec P7) ----
// A catalog is `{ entries: [...] }`, or `{ entries: [...], signature: "<base64>" }` where the Ed25519 signature
// covers `JSON.stringify(entries)` exactly as parsed. Packages may additionally carry a `signature` over their
// bytes. Verification is data-only: no key, no signature, a wrong key or a bad signature is a refusal.

function publicKeyObject(publicKey: string): crypto.KeyObject | null {
  try {
    const key = publicKey.includes('BEGIN')
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** Signatures are base64 by default; a 128-char hex string is accepted as hex too. */
function signatureBytes(signature: string): Buffer {
  return /^[a-f0-9]{128}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.from(signature, 'base64');
}

/** Is `publicKey` a usable Ed25519 key (PEM or base64 SPKI DER)? */
export function isEd25519PublicKey(publicKey: string): boolean {
  return publicKeyObject(publicKey) !== null;
}

export function verifyCatalogSignature(entries: unknown[], signatureB64: string, publicKey: string): boolean {
  const key = publicKeyObject(publicKey);
  if (!key) return false;
  try {
    return crypto.verify(null, Buffer.from(JSON.stringify(entries), 'utf8'), key, signatureBytes(signatureB64));
  } catch {
    return false;
  }
}

export function verifyArchiveSignature(bytes: Buffer, signatureB64: string, publicKey: string): boolean {
  const key = publicKeyObject(publicKey);
  if (!key) return false;
  try {
    return crypto.verify(null, bytes, key, signatureBytes(signatureB64));
  } catch {
    return false;
  }
}

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse a catalog body. With a configured public key the body must be a signed envelope and the signature has to
 * verify (a missing or bad signature refuses the whole catalog), and every entry must pin its bytes with its own
 * `signature` or a `sha256` (covered by the catalog signature) — an entry with neither is dropped. Those entries
 * come back `verified: true`. Without a key an unsigned array / `{ entries }` is accepted, but every entry is
 * `verified: false` (installing one needs an explicit acknowledgement). Invalid entries are still dropped per entry.
 */
export function parseSignedMarketCatalog(text: string, publicKey?: string): { catalog: MarketCatalog; signed: boolean } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(tr('插件市场目录不是有效的 JSON')); }
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { entries?: unknown; signature?: unknown }) : null;
  const hasSignature = !!obj && typeof obj.signature === 'string' && obj.signature.trim().length > 0;
  if (publicKey) {
    if (!hasSignature) throw new Error(tr('插件市场目录没有签名'));
    if (!Array.isArray(obj!.entries) || !verifyCatalogSignature(obj!.entries, String(obj!.signature), publicKey)) {
      throw new Error(tr('插件市场目录签名不对，已丢弃'));
    }
  }
  const catalog = parseMarketCatalog(raw);
  if (!publicKey) return { catalog, signed: false };
  const rawList = obj!.entries as unknown[];
  const entries: MarketEntry[] = [];
  const errors = [...catalog.errors];
  for (const e of catalog.entries) {
    if (!e.signature && !e.sha256) {
      const index = rawList.findIndex((r) => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' && (r as { id: string }).id.trim() === e.id);
      errors.push({ index, message: tr('插件市场条目 {id} 没有签名或校验值', { id: e.id }) });
      continue;
    }
    entries.push({ ...e, verified: true });
  }
  return { catalog: { entries, errors }, signed: true };
}

/** `https://host/path?query` — only used to keep callers from ever printing credentials. */
export function safeMarketUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}
