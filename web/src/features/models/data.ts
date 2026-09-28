import { useEffect, useSyncExternalStore } from 'react';
import type { GatewayGroup, GatewayStatus, ModelRefreshResult } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';

/**
 * Shared state of the model picker: the gateway groups (a gateway profile's models are its members'
 * union) and the "refresh every profile's model list" run. Module-level so the composer menu and the
 * settings page show the same progress; a tiny subscribe/snapshot pair instead of another store slice.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

let groups: GatewayGroup[] = [];
let groupsLoaded = false;
let groupsWatch: (() => void) | null = null;

function loadGroups() {
  return ws.request<GatewayStatus>({ kind: 'gateway.status' }).then((s) => { groups = s.groups; groupsLoaded = true; emit(); }).catch(() => {});
}

/** Gateway groups, loaded on first use and kept current through `gateway.changed`. */
export function useGatewayGroups(): GatewayGroup[] {
  useEffect(() => {
    if (!groupsLoaded) void loadGroups();
    if (!groupsWatch) groupsWatch = ws.on((e) => { if (e.kind === 'gateway.changed') void loadGroups(); });
  }, []);
  return useSyncExternalStore(subscribe, () => groups);
}

export interface RefreshRun { running: boolean; ids: string[]; done: number; total: number; results: ModelRefreshResult[]; at?: number }
let run: RefreshRun = { running: false, ids: [], done: 0, total: 0, results: [] };

export function useRefreshRun(): RefreshRun {
  return useSyncExternalStore(subscribe, () => run);
}

/**
 * Pull the model list of `ids` (default: every non-gateway profile). One request per profile, four in
 * flight, so the UI can count progress; the server stores `models` / `modelsAt` / `modelsError` and
 * broadcasts meta.changed, which reloads the provider list.
 */
export async function refreshAllModels(ids?: string[]): Promise<ModelRefreshResult[]> {
  if (run.running) return run.results;
  const st = useStore.getState();
  const targets = ids ?? st.providers.filter((p) => p.type !== 'gateway').map((p) => p.id);
  if (!targets.length) { st.toast('还没有可刷新的供应商档案'); return []; }
  run = { running: true, ids: targets, done: 0, total: targets.length, results: [] };
  emit();
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const id = targets[next++];
      const r = await ws.request<ModelRefreshResult[]>({ kind: 'providers.refreshModels', ids: [id] })
        .then((x) => x[0])
        .catch((e: Error) => ({ id, name: st.providers.find((p) => p.id === id)?.name ?? id, ok: false, count: 0, error: e.message, ms: 0 }));
      run = { ...run, done: run.done + 1, results: [...run.results, r] };
      emit();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  run = { ...run, running: false, at: Date.now() };
  emit();
  const bad = run.results.filter((r) => !r.ok);
  const models = run.results.reduce((n, r) => n + r.count, 0);
  st.toast(bad.length ? `${run.results.length - bad.length} 个档案已刷新（${models} 个模型），${bad.length} 个失败：${bad.map((b) => b.name).join('、')}` : `${run.results.length} 个档案已刷新，共 ${models} 个模型`, !bad.length);
  void st.loadProviders().catch(() => {});
  return run.results;
}
