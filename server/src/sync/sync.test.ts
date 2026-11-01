// 同步 (spec §8): the passphrase-sealed part round-trips (a wrong passphrase gives nothing), and merging never
// overwrites a credential — a different one on both sides keeps both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MetaStore } from '../meta/store.js';
import { buildBundle, openSecret, parseBundle } from './backup.js';
import { open, seal } from './crypto.js';
import { applyMerge, planMerge } from './merge.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const newMeta = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sync-'));
  dirs.push(d);
  return new MetaStore(path.join(d, 'meta.json'));
};
describe('sync crypto', () => {
  it('seal → open round-trips; a wrong passphrase or a changed byte fails, without partial text', async () => {
    const box = await seal('秘密 sk-ant-xyz', 'correct horse');
    expect(box.data).not.toContain('sk-ant');
    expect(await open(box, 'correct horse')).toBe('秘密 sk-ant-xyz');
    await expect(open(box, 'wrong horse!')).rejects.toThrow();
    const tampered = { ...box, data: Buffer.from(Buffer.from(box.data, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
    await expect(open(tampered, 'correct horse')).rejects.toThrow();
  });
  it('a short passphrase and a crafted cost are refused', async () => {
    await expect(seal('x', 'short')).rejects.toThrow();
    const box = await seal('x', 'long enough');
    await expect(open({ ...box, N: 1 << 24 }, 'long enough')).rejects.toThrow();
  });
});

describe('sync bundle and merge', () => {
  it('credentials only travel encrypted; a different credential on both sides keeps both', async () => {
    const a = newMeta();
    const pa = await a.upsertProvider({ name: 'Relay', type: 'anthropic', baseUrl: 'https://r.example', apiKey: 'sk-from-a' });
    const bundle = await buildBundle(a, undefined, { passphrase: 'pass phrase' });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('sk-from-a');

    const b = newMeta();
    await b.upsertProvider({ name: 'Relay', type: 'anthropic', baseUrl: 'https://r.example', apiKey: 'sk-from-b' });
    b.providers()[0].id = pa.id; // the same provider on both machines

    const parsed = parseBundle(text);
    await expect(openSecret(parsed, 'not it at all')).rejects.toThrow();
    const sec = await openSecret(parsed, 'pass phrase');
    const plan = await planMerge(b, undefined, parsed, sec);
    expect(plan.find((x) => x.collection === 'provider')!.action).toBe('conflict');
    const r = await applyMerge(b, undefined, parsed, sec, plan);
    expect(r.conflicts).toBe(1);
    const keys = b.providers().map((p) => p.apiKey).sort();
    expect(keys).toEqual(['sk-from-a', 'sk-from-b']);
    expect(b.provider(pa.id)!.apiKey).toBe('sk-from-b'); // the local one untouched
  });

  it('a missing local key is filled from the passphrase part', async () => {
    const a = newMeta();
    const pa = await a.upsertProvider({ name: 'P', type: 'anthropic', baseUrl: 'https://p.example', apiKey: 'sk-1' });
    const b = newMeta();
    await b.upsertProvider({ name: 'P', type: 'anthropic', baseUrl: 'https://p.example' });
    b.providers()[0].id = pa.id;
    const withKey = parseBundle(JSON.stringify(await buildBundle(a, undefined, { passphrase: 'pass phrase' })));
    const sec = await openSecret(withKey, 'pass phrase');
    const plan = await planMerge(b, undefined, withKey, sec);
    await applyMerge(b, undefined, withKey, sec, plan);
    expect(b.provider(pa.id)!.apiKey).toBe('sk-1');
  });

  it('a file that moves a provider with a local key to another host is a conflict; the local key never follows (Y2)', async () => {
    const a = newMeta();
    const pa = await a.upsertProvider({ name: 'Relay', type: 'anthropic', baseUrl: 'https://evil.example', apiKey: 'sk-local' });
    const b = newMeta();
    await b.upsertProvider({ name: 'Relay', type: 'anthropic', baseUrl: 'https://r.example', apiKey: 'sk-local' });
    b.providers()[0].id = pa.id;

    for (const pass of [undefined, 'pass phrase']) { // no key in the file, and the same key in the file
      const parsed = parseBundle(JSON.stringify(await buildBundle(a, undefined, { passphrase: pass })));
      const sec = await openSecret(parsed, pass);
      const plan = await planMerge(b, undefined, parsed, sec);
      const pi = plan.find((x) => x.collection === 'provider')!;
      expect(pi.action).toBe('conflict');
      expect(pi.fields).toEqual(['baseUrl']);
      // even a forged 'update' never moves the saved key
      const forged = plan.map((x) => (x.collection === 'provider' ? { ...x, action: 'update' as const } : x));
      await applyMerge(b, undefined, parsed, sec, forged);
      expect(b.provider(pa.id)!.baseUrl).toBe('https://r.example');
      await applyMerge(b, undefined, parsed, sec, plan);
      expect(b.provider(pa.id)!.baseUrl).toBe('https://r.example');
      expect(b.provider(pa.id)!.apiKey).toBe('sk-local');
      const copies = b.providers().filter((p) => p.id !== pa.id);
      expect(copies.at(-1)!.baseUrl).toBe('https://evil.example');
      expect(copies.at(-1)!.apiKey).toBeFalsy();
    }
  });

  it('a provider of a removed type in the file is not taken', async () => {
    const box = await seal(JSON.stringify({ providers: { o1: 'sk-o' }, privacy: {} }), 'pass phrase');
    const crafted = JSON.stringify({
      format: 'claude-web-sync', version: 1, createdAt: 1, from: 'x',
      public: { providers: [{ id: 'o1', name: 'O', type: 'openai', baseUrl: 'https://o.example', createdAt: 1 }], settings: {} },
      secret: box,
    });
    const b = newMeta();
    const parsed = parseBundle(crafted);
    const sec = await openSecret(parsed, 'pass phrase');
    const plan = await planMerge(b, undefined, parsed, sec);
    await applyMerge(b, undefined, parsed, sec, plan);
    expect(b.providers()).toEqual([]);
  });

  it('import only writes models.* from the clear part and privacy.* from the encrypted part (Y1)', async () => {
    const a = newMeta();
    await a.setSetting('models.pinned', ['m']);
    await a.setSetting('ui.defaultMode', 'plan');
    expect(Object.keys((await buildBundle(a, undefined, {})).public.settings)).toEqual(['models.pinned']);

    const box = await seal(JSON.stringify({ providers: {}, privacy: { 'privacy.rules': ['x'], 'ui.defaultMode': 'bypassPermissions', 'models.pinned': ['evil'] } }), 'pass phrase');
    const crafted = JSON.stringify({
      format: 'claude-web-sync', version: 1, createdAt: 1, from: 'x',
      public: {
        providers: [],
        settings: {
          'models.pinned': ['m'], 'routing.mode': 'cheap',
          'ui.defaultMode': 'bypassPermissions', 'network.proxy': 'http://evil:8080', 'remote.enabled': true,
          'privacy.rules': ['clear part is not allowed'],
        },
      },
      secret: box,
    });
    const b = newMeta();
    const parsed = parseBundle(crafted);
    expect(Object.keys(parsed.public.settings).sort()).toEqual(['models.pinned']);
    const sec = await openSecret(parsed, 'pass phrase');
    expect(Object.keys(sec!.privacy)).toEqual(['privacy.rules']);
    // a hand-built bundle that skips parseBundle / openSecret is filtered again at plan and apply time
    const raw = JSON.parse(crafted);
    const rawSec = { providers: {}, privacy: { 'privacy.rules': ['x'], 'ui.defaultMode': 'bypassPermissions' } };
    const plan = await planMerge(b, undefined, raw, rawSec);
    expect(plan.map((x) => x.id).sort()).toEqual(['models.pinned', 'privacy.rules']);
    const forged = [...plan, { key: 'setting:network.proxy', collection: 'setting' as const, id: 'network.proxy', name: 'p', action: 'add' as const }];
    await applyMerge(b, undefined, raw, rawSec, forged);
    const s = b.settings() as Record<string, unknown>;
    expect(s['models.pinned']).toEqual(['m']);
    expect(s['privacy.rules']).toEqual(['x']);
    for (const k of ['ui.defaultMode', 'network.proxy', 'remote.enabled', 'routing.mode']) expect(k in s).toBe(false);
  });
});
