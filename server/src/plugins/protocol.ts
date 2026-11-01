// Plugins (spec 2026-10-26 §4.3): two kinds, never mixed.
//  - declarative: a JSON file of data (endpoint, protocol, auth, models, capabilities); never executed.
//  - executable: a folder with plugin.json + an entry file, run in its own Node child process with declared
//    permissions (network hosts, file read paths, secrets), a per-call timeout and output caps.
// The wire types (plugins.* requests) live here too; the child <-> host message protocol is at the bottom.

export type PluginProtocol = 'anthropic' | 'openai' | 'openai-responses' | 'gemini';
export type PluginAuth = 'bearer' | 'x-api-key' | 'both' | 'none';

export interface DeclarativeModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  capabilities?: { tools?: boolean; images?: boolean; reasoning?: boolean; stream?: boolean };
  free?: boolean;
  mayTrain?: boolean;
}

/** One source a declarative file (or an executable plugin's `sources` hook) describes. Data only. */
export interface DeclarativeSource {
  id: string;
  name: string;
  /** https URL; http only for loopback / private hosts */
  endpoint: string;
  protocol: PluginProtocol;
  auth: PluginAuth;
  /** the name of the secret the user fills in (shown as a field; never stored in the file) */
  secretName?: string;
  category?: 'free' | 'subscription' | 'api' | 'local-engine';
  models: DeclarativeModel[];
  docs?: string;
}

export type PluginHook = 'request-before' | 'response-after' | 'source-provider';

export interface PluginPermissions {
  /** host names (exact, or `*.example.com`) the plugin may reach through the host's fetch */
  network?: string[];
  /** paths (relative to the plugin folder, or absolute) it may read; its own folder is always readable */
  fileRead?: string[];
  /** paths (relative to the plugin folder, or absolute) it may write; nothing is writable by default */
  fileWrite?: string[];
  /** secret names it asks for; each one must be approved by the user */
  secrets?: string[];
  /** may start child processes (Node --allow-child-process; they run without the plugin's limits) */
  childProcess?: boolean;
  /** may start worker threads (Node --allow-worker) */
  workers?: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** entry file relative to the plugin folder (CommonJS) */
  main: string;
  hooks: PluginHook[];
  permissions: PluginPermissions;
  /** per call, ms (default 10 s, capped at 60 s) */
  timeoutMs?: number;
  /** stdout + stderr kept per call, bytes (default 64 KB, capped at 1 MB) */
  maxOutputBytes?: number;
  /** V8 heap cap of the child, MB (default 256, 32–1024) */
  maxMemoryMb?: number;
}

export interface PluginView {
  id: string;
  kind: 'declarative' | 'executable';
  name: string;
  version?: string;
  description?: string;
  /** file or folder name under the plugins directory (never an absolute path on the wire) */
  file: string;
  enabled: boolean;
  /** executable: the permissions were approved for this exact manifest and code */
  approved: boolean;
  /** executable: not approved because its code changed (the permissions are the same as approved) */
  codeChanged?: boolean;
  /** executable, 'process' isolation: the user allowed it to run without file access limits */
  unrestricted?: boolean;
  hooks: PluginHook[];
  permissions: PluginPermissions;
  /** declarative: how many sources / models it adds */
  sources: number;
  models: number;
  /** 'permission' = Node's permission model limits the child's file access; 'process' = a separate process only */
  isolation?: 'permission' | 'process';
  running?: boolean;
  error?: string;
  /** stderr / stdout of the last call, capped */
  lastOutput?: string;
}

export type PluginRequest =
  | { kind: 'plugins.list' }
  | { kind: 'plugins.enable'; id: string; approve?: boolean; /** 'process' isolation: the user accepted full file access */ allowUnrestricted?: boolean }
  | { kind: 'plugins.disable'; id: string }
  | { kind: 'plugins.remove'; id: string }
  | { kind: 'plugins.reload' }
  // ---- remote market (spec P7) ----
  | { kind: 'plugins.market.status' }
  | { kind: 'plugins.market.refresh' }
  | { kind: 'plugins.market.set'; config: PluginMarketConfig }
  /**
   * Download / read and verify a package without installing it: says whether it is verified by a trusted key and
   * the SHA-256 of the exact bytes (shown in the confirmation before an unverified install).
   */
  | { kind: 'plugins.install.check'; id?: string; url?: string; path?: string; sha256?: string }
  /**
   * `id` = a catalog entry; or `url` (https) / `path` (a local .zip, .tar.gz or .json). `sha256`, when given, must
   * match the bytes. A package not verified by a trusted key (unsigned catalog, a URL, a local file) is refused
   * unless `acknowledgeUnverified` is true — the user confirmed running unverified code.
   */
  | { kind: 'plugins.install'; id?: string; url?: string; path?: string; sha256?: string; acknowledgeUnverified?: boolean };

export interface PluginListResult { plugins: PluginView[]; dir: string; warnings: string[] }

/** Where the market catalog comes from (meta setting `plugins.market`). */
export interface PluginMarketConfig {
  /** https URL of the catalog JSON; empty = no market configured */
  url?: string;
  /** Ed25519 public key (PEM or base64 SPKI DER): when set, the catalog and any signed package must verify */
  publicKey?: string;
}

export interface PluginMarketEntry {
  id: string;
  name: string;
  author: string;
  description?: string;
  categories: ('provider' | 'middleware' | 'tool' | 'page' | 'theme')[];
  version: string;
  downloads: number;
  /** https URL of the archive / declarative JSON */
  url: string;
  /** hex SHA-256 of the exact bytes at `url` */
  sha256?: string;
  /** base64 Ed25519 signature of the exact bytes at `url` (needs `PluginMarketConfig.publicKey`) */
  signature?: string;
  minAppVersion?: string;
  homepage?: string;
  repository?: string;
  kind: 'declarative' | 'executable';
  hooks: PluginHook[];
  permissions: PluginPermissions;
  /** catalog signed with the configured key and the entry pins its bytes; otherwise installing needs an acknowledgement */
  verified: boolean;
}

export interface PluginMarketStatus {
  config: PluginMarketConfig;
  entries: PluginMarketEntry[];
  /** entries the catalog had to drop (one bad card never hides the rest) */
  errors: { index: number; message: string }[];
  fetchedAt?: number;
  /** the cached catalog was verified with the configured public key */
  signed: boolean;
  /** the last refresh failed (cached entries are still shown) */
  error?: string;
}

/** Why a package is not verified: a catalog without a public key, a direct URL, a local file. */
export type PluginUnverifiedReason = 'unsigned-catalog' | 'url' | 'file';

export interface PluginInstallCheck {
  verified: boolean;
  reason?: PluginUnverifiedReason;
  /** hex SHA-256 of the exact bytes downloaded / read */
  sha256: string;
  size: number;
  kind: 'declarative' | 'executable';
  /** the catalog entry id, when installing by id */
  id?: string;
  name?: string;
  /** where it came from, without credentials or query (a URL) or the file name */
  source: string;
}

export interface PluginInstallResult {
  installed: { id: string; name: string; version: string; kind: 'declarative' | 'executable'; file: string; verified: boolean; sha256: string };
  plugins: PluginView[];
  dir: string;
  warnings: string[];
}

// ---- child process protocol (Node IPC channel, JSON messages) ----

export type HostToChild =
  | { t: 'call'; id: number; hook: PluginHook; payload: unknown }
  | { t: 'fetchResult'; id: number; ok: boolean; status?: number; headers?: Record<string, string>; body?: string; error?: string }
  | { t: 'secretResult'; id: number; ok: boolean; value?: string; error?: string };

export type ChildToHost =
  | { t: 'ready'; hooks: string[] }
  | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'fetch'; id: number; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { t: 'secret'; id: number; name: string };
