// Merging a sync bundle into this machine, item by item (spec §8: never "last write wins" over all credentials).
//  - settings: per key; what is only here stays.
//  - a provider whose key differs on both sides is a conflict: both are kept (the incoming one as a copy named
//    「…（同步）」), nothing is overwritten.
// `planMerge` only reads; `applyMerge` writes what the user kept in the preview.
import crypto from 'node:crypto';
import type { MetaStore } from '../meta/store.js';
import type { SecretService } from '../secrets/service.js';
import type { Provider } from '../protocol.js';
import { filterSettings, isPrivateSetting, isPublicSetting, type SyncBundle, type SyncProvider, type SyncSecret } from './backup.js';
import { tr } from '../i18n/index.js';
import type { SyncPlanItem } from './types.js';
export type { SyncCollection, SyncPlanItem } from './types.js';

const IGNORE = new Set(['createdAt', 'updatedAt', 'hasKey', 'id']);
/** Provider fields that decide where (and how) its saved key is sent. */
const PROVIDER_ROUTE_FIELDS = new Set(['baseUrl', 'type', 'authStyle']);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffFields(local: Record<string, any>, incoming: Record<string, any>): string[] {
  return Object.keys(incoming).filter((k) => !IGNORE.has(k) && !same(local[k], incoming[k]));
}

/** The settings an import may write: clear-part keys must be public ones, encrypted-part keys private ones
 *  (re-checked here, not only in parseBundle / openSecret, so a hand-built bundle cannot widen it). */
function incomingSettings(b: SyncBundle, sec: SyncSecret | null): Record<string, unknown> {
  return { ...filterSettings(b.public.settings, isPublicSetting), ...filterSettings(sec?.privacy, isPrivateSetting) };
}

async function reveal(secrets: SecretService | undefined, v: string | undefined): Promise<string> {
  if (!v) return '';
  return secrets ? secrets.reveal(v).catch(() => '') : v;
}

export async function planMerge(meta: MetaStore, secrets: SecretService | undefined, b: SyncBundle, sec: SyncSecret | null): Promise<SyncPlanItem[]> {
  const out: SyncPlanItem[] = [];
  // a file from a machine with OpenAI / Gemini / Grok / model-gateway profiles: those formats are not here any more
  for (const p of b.public.providers.filter((x) => x.type === 'anthropic' || x.type === 'claude-account')) {
    const local = meta.provider(p.id);
    const key = sec?.providers[p.id];
    if (!local) { out.push({ key: `provider:${p.id}`, collection: 'provider', id: p.id, name: p.name, action: 'add', withSecret: !!key }); continue; }
    const localKey = await reveal(secrets, local.apiKey);
    const fields = diffFields(local as any, p as any);
    if (key && localKey && key !== localKey) {
      out.push({ key: `provider:${p.id}`, collection: 'provider', id: p.id, name: p.name, action: 'conflict', withSecret: true, note: tr('两边的密钥不同：都保留，传入的另存为「{name}（同步）」', { name: p.name }) });
      continue;
    }
    // Y2: where the saved key goes must not change under it — a new host / protocol / auth for a
    // provider that has a local key is a conflict: the incoming one is added as a copy without the local key.
    const moved = fields.filter((f) => PROVIDER_ROUTE_FIELDS.has(f));
    if (localKey && moved.length) {
      out.push({ key: `provider:${p.id}`, collection: 'provider', id: p.id, name: p.name, action: 'conflict', withSecret: !!key && key !== localKey, fields: moved, note: tr('文件把「{name}」指到了别的地址：本机的密钥不跟过去，传入的另存为「{name}（同步）」', { name: p.name }) });
      continue;
    }
    const fillsKey = !!key && !localKey;
    out.push({ key: `provider:${p.id}`, collection: 'provider', id: p.id, name: p.name, action: fields.length || fillsKey ? 'update' : 'same', ...(fields.length ? { fields } : {}), withSecret: fillsKey });
  }
  const settings = meta.settings() as Record<string, unknown>;
  for (const [k, v] of Object.entries(incomingSettings(b, sec))) {
    out.push({ key: `setting:${k}`, collection: 'setting', id: k, name: k, action: !(k in settings) ? 'add' : same(settings[k], v) ? 'same' : 'update' });
  }
  return out;
}

const copyId = () => crypto.randomBytes(4).toString('hex');

export async function applyMerge(meta: MetaStore, secrets: SecretService | undefined, b: SyncBundle, sec: SyncSecret | null, plan: SyncPlanItem[], skip: string[] = []): Promise<{ applied: number; conflicts: number }> {
  const skipped = new Set(skip);
  const protect = async (plain: string, id: string) => (secrets ? secrets.protect(plain, id) : plain);
  let applied = 0;
  let conflicts = 0;
  for (const it of plan) {
    if (skipped.has(it.key) || it.action === 'same' || it.action === 'skip') continue;
    if (it.collection === 'provider') {
      const p = b.public.providers.find((x) => x.id === it.id) as SyncProvider;
      const { hasKey: _h, createdAt: _c, ...rest } = p;
      const key = sec?.providers[it.id];
      const local = meta.provider(it.id);
      if (it.action === 'conflict') {
        // only the file's own key goes on the copy — never the local one (the copy may point at another host)
        const localKey = local ? await reveal(secrets, local.apiKey) : '';
        const carry = !!key && key !== localKey;
        await meta.upsertProvider({ ...rest, id: `${it.id}-${copyId()}`, name: tr('{name}（同步）', { name: p.name }), ...(carry ? { apiKey: key } : {}) } as Partial<Provider>);
        conflicts++;
      } else {
        const patch: Partial<Provider> = { id: it.id };
        if (!local) Object.assign(patch, rest);
        else for (const f of it.fields ?? []) {
          if (local.apiKey && PROVIDER_ROUTE_FIELDS.has(f)) continue; // never move a saved key to a new host
          (patch as any)[f] = (rest as any)[f];
        }
        if (key && (!local || !local.apiKey)) patch.apiKey = key;
        await meta.upsertProvider(patch);
      }
      applied++;
    } else if (it.collection === 'setting') {
      const all = incomingSettings(b, sec);
      if (!Object.prototype.hasOwnProperty.call(all, it.id)) continue;
      await meta.setSetting(it.id, all[it.id]);
      applied++;
    }
  }
  return { applied, conflicts };
}
