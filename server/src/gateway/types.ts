// Model gateway (sub-project 4): wire types shared with the web client through protocol.ts (`export *`).

/** Which API shape a request arrives in / a member speaks. `responses` = OpenAI Responses API (Codex). */
export type GatewayProtocol = 'anthropic' | 'openai' | 'responses' | 'gemini';

export interface GatewayMember {
  providerId: string;
  /** Pin this member to one upstream model (overrides the group's modelMap). */
  model?: string;
  /** Round-robin weight (default 1). */
  weight?: number;
}

export interface GatewayGroup {
  id: string;
  name: string;
  members: GatewayMember[];
  strategy: 'failover' | 'round-robin';
  /** Inbound model → outbound model. Keys may use `*` wildcards; exact keys win. */
  modelMap?: Record<string, string>;
}

export type GatewayMemberHealth = 'ok' | 'cooling' | 'disabled' | 'unknown';
export interface GatewayMemberState {
  providerId: string;
  name: string;
  type: string;
  health: GatewayMemberHealth;
  cooldownUntil?: number;
  /** Consecutive rate-limit hits (exponential backoff step). */
  strikes: number;
  lastError?: string;
  lastStatus?: number;
  lastOkAt?: number;
  lastUsedAt?: number;
}

export interface GatewayStatus {
  enabled: boolean;
  /** `http://127.0.0.1:<port>/gateway` (the group id is appended per group). */
  baseUrl: string;
  /** Masked (`cwg-…abcd`); the plaintext only comes from `gateway.revealKey`. */
  keyMasked: string;
  groups: GatewayGroup[];
  states: Record<string, GatewayMemberState[]>; // groupId → member states (same order as members)
}

export interface GatewayTestResult {
  ok: boolean;
  status: number;
  ms: number;
  member?: string;
  switches?: number;
  text?: string;
  error?: string;
  /** Caveat to show next to the result (e.g. the test request carries no Claude Code fingerprint). */
  note?: string;
}

/** Extra fields on a ledger line written by the gateway (`kind: 'gateway'`). */
export interface GatewayLedgerInfo {
  group: string;
  inbound: GatewayProtocol;
  member?: string; // provider name that answered (or last tried)
  memberId?: string;
  outbound?: GatewayProtocol;
  upstreamStatus?: number;
  switches: number;
  firstByteMs?: number;
  stream: boolean;
}

export type GatewayRequest =
  | { kind: 'gateway.status' }
  | { kind: 'gateway.set'; enabled: boolean }
  | { kind: 'gateway.revealKey' }
  | { kind: 'gateway.regenerateKey' }
  | { kind: 'gateway.groups.upsert'; group: Partial<GatewayGroup> & { id?: string } }
  | { kind: 'gateway.groups.remove'; id: string }
  | { kind: 'gateway.reset'; groupId: string; providerId?: string }
  | { kind: 'gateway.test'; groupId: string; protocol?: GatewayProtocol };

export type GatewayEvent = { kind: 'gateway.changed' };
