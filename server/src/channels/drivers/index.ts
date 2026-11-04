// The driver registry: every kind of source, one adapter each (replaces the switches around UpstreamKind).
import type { EngineManager } from '../../engines/manager.js';
import { MANIFESTS } from '../../engines/manifests/index.js';
import type { EngineId } from '../../engines/types.js';
import type { MetaStore } from '../../meta/store.js';
import { families } from '../registry.js';
import type { CatalogDriverId, CatalogEntry } from '../types.js';
import { ClaudeBridgeDriver } from './claude-bridge.js';
import { EngineDriver } from './engine.js';
import { GrokWebDriver } from './grok-web.js';
import { ProviderDriver, type ProviderDeps } from './provider.js';
import type { ChannelDriver } from './types.js';
import { UpstreamFamilyDriver, type UpstreamDeps } from './upstream.js';

export type { ChannelDriver, DriverContext } from './types.js';

export function createDrivers(deps: { providers: ProviderDeps; upstreams: UpstreamDeps; engines?: EngineManager; meta?: MetaStore; catalog: () => CatalogEntry[]; plainKey?: (providerId: string) => string }): ChannelDriver[] {
  return [
    new ProviderDriver(deps.providers, deps.meta, deps.catalog),
    ...families.map((f) => new UpstreamFamilyDriver(deps.upstreams, f.kind, f.sourceKind, f.name)),
    ...(deps.engines ? (Object.keys(MANIFESTS) as EngineId[]).map((id) => new EngineDriver(deps.engines!, id)) : []),
    new ClaudeBridgeDriver({ providers: deps.providers, meta: deps.meta }),
    new GrokWebDriver({ providers: deps.providers, meta: deps.meta, plainKey: deps.plainKey }),
  ];
}

export const driverFor = (drivers: ChannelDriver[], id: CatalogDriverId) => drivers.find((d) => d.id === id);
