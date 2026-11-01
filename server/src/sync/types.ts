// Wire types of sync.* (pure: the web client imports them through @shared).

export type SyncCollection = 'provider' | 'setting';
export interface SyncPlanItem {
  /** `<collection>:<id>`; what the preview sends back to skip an item */
  key: string;
  collection: SyncCollection;
  id: string;
  name: string;
  action: 'add' | 'update' | 'same' | 'conflict' | 'skip';
  /** fields that change (update) */
  fields?: string[];
  /** with a credential from the encrypted part */
  withSecret?: boolean;
  note?: string;
}

/** Remote sync (sync/remote.ts): one backend at a time; the other backends' fields are kept. */
export type SyncRemoteBackend = 'webdav' | 's3' | 'github';

export interface SyncRemoteWebDavSettings {
  /** folder URL, e.g. `https://dav.example.com/claude-web/` */
  url: string;
  username: string;
  /** On the wire: the mask when one is stored, `''` when none. The plain one never leaves the server. */
  password: string;
}
export interface SyncRemoteS3Settings {
  /** empty = AWS default endpoint for the region */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  /** On the wire: the mask when one is stored. */
  secretAccessKey: string;
  /** folder all sync files live under; empty = bucket root */
  prefix: string;
}
export interface SyncRemoteGitHubSettings {
  /** `owner/repo` */
  repo: string;
  /** empty = the repository's default branch */
  branch: string;
  /** folder all sync files live under; empty = repository root */
  path: string;
  /** On the wire: the mask when one is stored. */
  token: string;
}
export interface SyncRemoteConfig {
  backend: SyncRemoteBackend;
  webdav: SyncRemoteWebDavSettings;
  s3: SyncRemoteS3Settings;
  github: SyncRemoteGitHubSettings;
}
export interface SyncRemoteStatus extends SyncRemoteConfig {
  /** the selected backend has everything it needs to connect */
  configured: boolean;
  /** labels of what is still missing (server-worded) */
  missing: string[];
  lastPushAt?: number;
  lastPullAt?: number;
  lastTestAt?: number;
  lastError?: string;
}
export interface SyncRemoteTestResult { ok: boolean; message: string; remoteExists: boolean }
export interface SyncRemotePushResult { ok: true; at: number; bytes: number; etag?: string; warning?: string }
/** The ordinary preview shape, so `sync.apply` / the existing preview UI work unchanged; `pulledAt` is for the status line. */
export interface SyncRemotePullResult extends SyncPreview { pulledAt: number; etag?: string }

export type SyncRemoteRequest =
  | { kind: 'sync.remote.status' }
  | { kind: 'sync.remote.set'; config: SyncRemoteConfig }
  | { kind: 'sync.remote.test' }
  /** passphrase: seals the credentials part exactly like 导出; empty = public settings only */
  | { kind: 'sync.remote.push'; passphrase?: string }
  | { kind: 'sync.remote.pull'; passphrase?: string }
  /** token: the preview to forget; no token: stop the push / pull / test in flight */
  | { kind: 'sync.remote.cancel'; token?: string };

export type SyncRequest =
  | { kind: 'sync.export'; passphrase?: string }
  | { kind: 'sync.import'; text: string; passphrase?: string }
  | { kind: 'sync.apply'; token: string; skip?: string[] }
  | { kind: 'sync.cancel'; token: string }
  | SyncRemoteRequest;

export interface SyncExportResult { filename: string; text: string; encrypted: boolean }
export interface SyncPreview { token: string; createdAt: number; from: string; encrypted: boolean; items: SyncPlanItem[] }
export interface SyncApplyResult { applied: number; conflicts: number }

