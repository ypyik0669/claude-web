export type SourceCategory = 'free' | 'subscription' | 'api' | 'local-engine';
export type SourceHealth = 'ready' | 'attention' | 'disabled' | 'unconfigured';
export type SourceKind = 'provider' | 'claude-account' | 'gemini-web' | 'workbuddy' | 'engine';
/** What adding a source takes: nothing, a key the user brings, a login flow, or a local program we run. */
export type SourceNeeds = 'none' | 'key' | 'login' | 'engine';
/** The wire protocol a catalog entry's endpoint speaks. */
export type SourceProtocol = 'anthropic' | 'openai' | 'gemini';
export type CatalogAuthStyle = 'bearer' | 'x-api-key' | 'both' | 'none';
/**
 * Language-free notes the UI turns into words: `real-name` (mainland ID verification), `one-concurrent`,
 * `parallel-tools-off` (the endpoint wants parallel_tool_calls=false), `list-any-key` (its /models accepts any key,
 * so only a real call proves the key), `logged` (prompts may be logged), `region` (not every region),
 * `paid-credit-raises-limit`, `non-commercial`.
 */
export type CatalogNote = 'real-name' | 'one-concurrent' | 'parallel-tools-off' | 'list-any-key' | 'logged' | 'region' | 'paid-credit-raises-limit' | 'non-commercial';

export interface SourceModel {
  id: string;
  name: string;
  contextWindow?: number;
  capabilities: { tools?: boolean; images?: boolean; reasoning?: boolean };
  free: boolean;
  mayTrain?: boolean;
}

/** A model the catalog knows about before any /models pull (a hint; the live list wins). */
export interface CatalogModel {
  id: string;
  contextWindow?: number;
  free?: boolean;
  capabilities?: { tools?: boolean; images?: boolean; reasoning?: boolean };
}

export type CatalogDriverId = 'provider' | 'engine:cliproxyapi' | 'engine:magpie' | 'upstream:claude' | 'upstream:gemini' | 'upstream:workbuddy' | 'upstream:provider' | 'claude-bridge' | 'grok-web';

/** One entry of the add-source catalog (data only: never code). */
export interface CatalogEntry {
  id: string;
  name: string;
  category: SourceCategory;
  needs: SourceNeeds;
  protocol: SourceProtocol;
  /** the base URL as the provider profile stores it ('' = the protocol's default, e.g. Gemini) */
  baseUrl?: string;
  authStyle?: CatalogAuthStyle;
  signupUrl?: string;
  /** every model this source serves is free (true), only some are ('some'), or none (absent) */
  free?: boolean | 'some';
  /** the vendor says it may log / train on prompts */
  mayTrain?: boolean;
  /** model ids to keep from the live list (regex source, case-insensitive); only for free-only sources */
  modelFilter?: string;
  models?: CatalogModel[];
  /** published limits as the vendor (or the aggregator list) states them; absent = not known */
  limits?: string;
  notes?: CatalogNote[];
  /** the key field's label / how to get it, when it is not an API key (Grok web: the sso cookie) */
  keyLabel?: string;
  keyHint?: string;
  /** which driver adds it: a provider profile, a local engine, or an upstream family's login */
  driver: CatalogDriverId;
  /** where the values came from (research note / vendor doc) */
  source?: string;
  /** the remote catalog marked it gone: shown as unavailable, never swapped for something else */
  retired?: boolean;
  /** it comes from an enabled plugin (plugins/declarative.ts), not from the built-in / remote catalog */
  plugin?: { id: string };
}

/** A catalog entry as the add-source wizard sees it. */
export interface CatalogSummary extends Omit<CatalogEntry, 'source'> {
  /** a source from this entry is already configured */
  added: boolean;
  /** the user changed this entry (their override wins over every catalog layer) */
  overridden?: boolean;
}

export interface SourceEngine {
  installed: boolean;
  running: boolean;
  version?: string;
  /** started by us (managed) or already running on this computer (connected) */
  mode?: 'managed' | 'connected';
  port?: number;
  /** found running on its default port but not connected yet → the UI offers 「连接」 instead of install */
  detected?: { port: number; version?: string };
  health?: 'stopped' | 'starting' | 'ok' | 'error';
  warnings?: string[];
}

export interface SourceSummary {
  id: string;
  kind: SourceKind;
  name: string;
  category: SourceCategory;
  health: SourceHealth;
  detail?: string;
  models: SourceModel[];
  accountCount?: number;
  healthyAccountCount?: number;
  providerId?: string;
  upstreamKind?: 'claude' | 'gemini' | 'workbuddy' | 'provider';
  engine?: SourceEngine;
  /** the catalog entry it was added from */
  catalogId?: string;
  needs?: SourceNeeds;
  mayTrain?: boolean;
  limits?: string;
  signupUrl?: string;
  /** unconfigured provider presets carry the descriptor's own grouping and sign-in hint */
  providerKind?: 'subscription' | 'api-key' | 'local' | 'custom' | 'remote';
  auth?: string;
  loginHint?: string;
  docsUrl?: string;
  free?: boolean | 'some';
  actions: { canAddAccount: boolean; canEditProvider: boolean; canManageEngine: boolean; canRemove?: boolean };
}

export interface ChannelStatus {
  sources: SourceSummary[];
  warnings: string[];
  /** the add-source catalog (baseline < signed remote < user overrides) */
  available?: CatalogSummary[];
  /** the signed remote catalog layer: off until the user sets an https URL + an Ed25519 key */
  remoteCatalog?: RemoteCatalogState;
}

/** What the settings page shows of the remote catalog: set up?, last verified copy, entries, last failure. */
export interface RemoteCatalogState {
  enabled: boolean;
  url?: string;
  hasKey: boolean;
  /** enabled with an https URL and a usable Ed25519 key */
  ready: boolean;
  fetchedAt?: number;
  entries: number;
  error?: string;
}

export interface ChannelCatalogOverride { hidden?: boolean; patch?: Partial<Omit<CatalogEntry, 'id' | 'driver'>> }

export type ChannelRequest =
  | { kind: 'channels.status' }
  | { kind: 'channels.refresh'; id: string }
  /** one-step add from the catalog → the new source */
  | { kind: 'channels.add'; catalogId: string; key?: string; name?: string }
  | { kind: 'channels.remove'; id: string }
  /** 远程模型目录: { enabled, url, publicKey } (validated; fetched + verified at once when complete) → ChannelStatus */
  | { kind: 'channels.catalog.remote'; setting: { enabled?: boolean; url?: string; publicKey?: string } | null }
  /** the user's change to a catalog entry (null = back to the catalog's values) */
  | { kind: 'channels.catalog.set'; id: string; override: ChannelCatalogOverride | null }
  /** fetch the signed remote catalog now (only when the setting turned it on) */
  | { kind: 'channels.catalog.update' };
