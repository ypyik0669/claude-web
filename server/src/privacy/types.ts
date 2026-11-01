// Privacy pipeline (spec 2026-10-26 §4): what the user sets, what the center shows. Shared with web through protocol.ts.

// `name`: Chinese names by rule (privacy/zhname.ts) and any name the local model finds; `address`: the local model only
export type PrivacyCategory = 'api_key' | 'private_key' | 'jwt' | 'password' | 'email' | 'phone' | 'id_card' | 'bank_card' | 'name' | 'address' | 'custom';
export const PRIVACY_CATEGORIES: PrivacyCategory[] = ['api_key', 'private_key', 'jwt', 'password', 'email', 'phone', 'id_card', 'bank_card', 'name', 'address', 'custom'];
/** off: not looked for; redact: placeholder out, original back; warn: sent as is, counted; block: the request is not sent */
export type PrivacyAction = 'off' | 'redact' | 'warn' | 'block';

export interface PrivacySettings {
  enabled: boolean;
  actions: Record<PrivacyCategory, PrivacyAction>;
  /** custom words (names, project code names, host names…): matched literally, case-insensitive */
  words: string[];
  /** custom regular expressions (JavaScript syntax, matched globally) */
  patterns: string[];
  /** values that always go out as they are */
  allow: string[];
  /** upstreams on this machine / the local network are not processed (a sidecar that forwards to the cloud never counts) */
  skipLocal: boolean;
  /**
   * 立即生效: once privacy has been turned on, conversations and agents keep going through the local relay even while
   * it is off (their bytes forwarded as they are), so switching it on again or changing a rule reaches conversations
   * already running — no restart. Off: no extra hop while privacy is off (a change then needs the conversation reopened).
   */
  standby: boolean;
  /** logs, diagnostics bundles and exported files get the same types masked (keys / tokens always are) */
  output: boolean;
  /** the optional local model (semantic PII: names, addresses, passwords with nothing around them); off by default */
  model: { enabled: boolean; minScore: number };
}

export interface PrivacyHit {
  category: PrivacyCategory;
  action: Exclude<PrivacyAction, 'off'>;
  placeholder?: string;
  length: number;
  /** a short, non-secret leading part (see detect.recordPrefix): records never keep the value itself */
  prefix?: string;
}

/** What a record keeps about one hit: type, length and (where meaningful) a short prefix — never the value. */
export interface PrivacyRecordEntry { category: PrivacyCategory; length: number; prefix?: string }

/** One request's record: types, counts, lengths, prefixes and placeholder hashes only — never a value. */
export interface PrivacyRecord {
  ts: number;
  source: string;
  count: number;
  categories: Partial<Record<PrivacyCategory, number>>;
  placeholders: string[];
  /** type / length / prefix, one per hit (capped) */
  entries?: PrivacyRecordEntry[];
  blocked?: boolean;
  warned?: number;
}

export interface PrivacyStats { since: number; requests: number; redacted: number; warned: number; blocked: number; hits: Partial<Record<PrivacyCategory, number>>; recent: PrivacyRecord[] }


/** The local semantic model (privacy/model.ts). */
export interface PrivacyModelStatus {
  id: string;
  name: string;
  /** bytes the download takes */
  size: number;
  /** onnxruntime-node can be loaded (not bundled: downloaded with the model, or installed by hand) */
  runtime: boolean;
  /** bytes the runtime download takes (absent: none pinned for this platform) */
  runtimeSize?: number;
  /** the runtime is the downloaded one (删除 removes it too) */
  runtimeOwn?: boolean;
  /** every file on disk, checked against its SHA-256 */
  installed: boolean;
  downloading?: { done: number; total: number };
  /** the last download / load error */
  error?: string;
  /** in memory now */
  loaded?: boolean;
}

export interface PrivacyStatus {
  settings: PrivacySettings;
  stats: PrivacyStats;
  /** custom patterns that do not compile */
  badPatterns: string[];
  /** conversations started from now on go through the local relay (on, or 立即生效 armed) */
  routed?: boolean;
  model?: PrivacyModelStatus;
}

export interface PrivacyPreview { text: string; hits: PrivacyHit[]; blocked: boolean; badPatterns: string[] }

export type PrivacyRequest =
  | { kind: 'privacy.get' }
  | { kind: 'privacy.set'; patch: Partial<Omit<PrivacySettings, 'actions'>> & { actions?: Partial<Record<PrivacyCategory, PrivacyAction>> } }
  /** what an upstream would get for this text with the current (or given) settings; nothing is stored */
  | { kind: 'privacy.preview'; text: string; settings?: PrivacySettings }
  /** the local model: fetch it and, when missing, onnxruntime (each checked against its pinned hash) / stop / delete both */
  | { kind: 'privacy.model.download' }
  | { kind: 'privacy.model.cancel' }
  | { kind: 'privacy.model.remove' }
  /** forget the records (memory and the day files) and the counters */
  | { kind: 'privacy.records.clear' };

export const DEFAULT_PRIVACY: PrivacySettings = {
  enabled: false,
  actions: { api_key: 'redact', private_key: 'redact', jwt: 'redact', password: 'redact', email: 'off', phone: 'off', id_card: 'redact', bank_card: 'redact', name: 'off', address: 'off', custom: 'redact' },
  words: [],
  patterns: [],
  allow: [],
  skipLocal: true,
  standby: true,
  output: true,
  model: { enabled: false, minScore: 0.8 },
};
