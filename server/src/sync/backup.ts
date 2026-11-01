// Sync bundle (spec §8): provider profiles, model settings and privacy rules. Not in it: model-list caches, absolute
// paths. Keys and privacy rules only travel inside the passphrase-encrypted part (crypto.ts).
import crypto from 'node:crypto';
import type { MetaStore } from '../meta/store.js';
import type { SecretService } from '../secrets/service.js';
import type { Provider } from '../protocol.js';
import { open, seal, type SealedBox } from './crypto.js';
import { tr } from '../i18n/index.js';

export type SyncProvider = Omit<Provider, 'apiKey'> & { hasKey: boolean };
export interface SyncPublic {
  providers: SyncProvider[];
  /** model settings (`models.*`) */
  settings: Record<string, unknown>;
}

export interface SyncSecret {
  providers: Record<string, string>;
  /** privacy rules travel encrypted (they name the things the user wants hidden) */
  privacy: Record<string, unknown>;
}

export interface SyncBundle {
  format: 'claude-web-sync';
  version: 1;
  createdAt: number;
  /** a hash of the exporting server's id (which device it came from, not who) */
  from: string;
  public: SyncPublic;
  secret?: SealedBox;
}

/** Fields of a provider that are this machine's learned / cached state, not settings. */
const PROVIDER_LOCAL = ['models', 'modelNames', 'modelEfforts', 'modelContext', 'modelsAt', 'modelsError'] as const;
const PUBLIC_SETTINGS = /^models\./;
const PRIVATE_SETTINGS = /^privacy\./;
/** Matches a sync prefix but is this machine's process state, never synced. */
const LOCAL_SETTINGS = new Set<string>();

/** May this setting travel in (and be imported from) the clear part? Import re-checks this: a crafted file
 *  must not set `ui.defaultMode`, `network.proxy`, `remote.*` or the like. */
export const isPublicSetting = (k: string): boolean => PUBLIC_SETTINGS.test(k) && !LOCAL_SETTINGS.has(k);
/** May this setting travel in (and be imported from) the encrypted part? */
export const isPrivateSetting = (k: string): boolean => PRIVATE_SETTINGS.test(k) && !LOCAL_SETTINGS.has(k);

/** Keep only the keys `allow` accepts (paths stripped). */
export function filterSettings(v: unknown, allow: (k: string) => boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v)) if (allow(k)) { const y = stripPaths(x); if (y !== undefined) out[k] = y; }
  return out;
}

/** A string that is an absolute path on some OS (C:\…, \\server\…, /home/…, ~/…). */
export function looksLikePath(v: unknown): boolean {
  return typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v) || /^~[\\/]/.test(v) || /^\/(home|Users|root|var|etc|opt|tmp|mnt|usr)\//.test(v));
}

/** Drop absolute paths anywhere in a settings value. */
export function stripPaths(v: unknown): unknown {
  if (looksLikePath(v)) return undefined;
  if (Array.isArray(v)) return v.map(stripPaths).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { const y = stripPaths(x); if (y !== undefined) out[k] = y; }
    return out;
  }
  return v;
}

export function publicProvider(p: Provider): SyncProvider {
  const { apiKey, ...rest } = p;
  const out: any = { ...rest, hasKey: !!apiKey };
  for (const k of PROVIDER_LOCAL) delete out[k];
  return out as SyncProvider;
}

export async function buildBundle(meta: MetaStore, secrets: SecretService | undefined, o: { passphrase?: string }): Promise<SyncBundle> {
  const reveal = async (v: string | undefined) => (v ? (secrets ? secrets.reveal(v) : v) : '');
  const settings = meta.settings() as Record<string, unknown>;
  const pub: SyncPublic = {
    providers: meta.providers().map(publicProvider),
    settings: filterSettings(settings, isPublicSetting),
  };
  const bundle: SyncBundle = {
    format: 'claude-web-sync', version: 1, createdAt: Date.now(),
    from: crypto.createHash('sha256').update(await meta.serverId()).digest('hex').slice(0, 12),
    public: pub,
  };
  if (o.passphrase) {
    const sec: SyncSecret = { providers: {}, privacy: filterSettings(settings, isPrivateSetting) };
    for (const p of meta.providers()) if (p.apiKey) sec.providers[p.id] = await reveal(p.apiKey);
    bundle.secret = await seal(JSON.stringify(sec), o.passphrase);
  }
  return bundle;
}

export function parseBundle(text: string): SyncBundle {
  let v: any;
  try { v = JSON.parse(text); } catch { throw new Error(tr('不是同步文件')); }
  if (v?.format !== 'claude-web-sync' || v.version !== 1 || !v.public) throw new Error(tr('不是同步文件'));
  const pub = v.public;
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  return {
    format: 'claude-web-sync', version: 1, createdAt: Number(v.createdAt) || 0, from: String(v.from ?? ''),
    public: {
      providers: arr(pub.providers).filter((p: any) => p && typeof p.id === 'string'),
      settings: filterSettings(pub.settings, isPublicSetting),
    },
    ...(v.secret ? { secret: v.secret as SealedBox } : {}),
  };
}

export async function openSecret(b: SyncBundle, passphrase?: string): Promise<SyncSecret | null> {
  if (!b.secret) return null;
  if (!passphrase) throw new Error(tr('这个文件带着加密的密钥，要输入导出时的口令'));
  const v = JSON.parse(await open(b.secret, passphrase));
  return { providers: v.providers ?? {}, privacy: filterSettings(v.privacy, isPrivateSetting) };
}
