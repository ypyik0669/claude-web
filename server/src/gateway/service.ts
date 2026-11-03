// Model gateway: /gateway/<groupId>/… on the main HTTP server (loopback only). Speaks Anthropic, OpenAI
// (Chat Completions + Responses) and Gemini to agents, routes each request through a failover group of
// provider profiles, passes same-protocol traffic through byte for byte, and translates across protocols.
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { MetaStore } from '../meta/store.js';
import type { SecretService } from '../secrets/service.js';
import type { LedgerEntry, Provider } from '../protocol.js';
import { memberKey, type GatewayAuditConfig, type GatewayGroup, type GatewayKeyGroup, type GatewayLanConfig, type GatewayLanStatus, type GatewayMember, type GatewayMemberState, type GatewayProtocol, type GatewayStatus, type GatewayTarget, type GatewayTestResult, type PluginHookSkip } from './types.js';
import { GatewayListener } from './listener.js';
import { CLAUDE_CODE_SYSTEM_PREFIX, OAUTH_BETA } from '../upstreams/claude.js';
import { accountProxyAgent } from '../upstreams/proxy.js';
import { clientFingerprint } from './fingerprint/index.js';
import type { UpstreamService } from '../upstreams/service.js';
import { GatewayKeyStore, routeAccess } from '../upstreams/keys.js';
import { RateLimiter } from '../upstreams/ratelimit.js';
import { ipInList, modelAllowed, pickRouteGroup } from '../upstreams/routing.js';
import { AuditLog } from './audit.js';
import { MemberStates, classify, mapModel } from './failover.js';
import { estimateTokens, type IrEvent, type IrRequest, type IrUsage } from './ir.js';
import { SseParser } from './sse.js';
import {
  DEFAULT_BASE, PROTOCOL_LABEL, buildOutbound, inboundStreamRenderer, isPassthrough, joinUrl, outboundOf, outboundStreamParser, parseInbound,
  parseOutboundResponse, renderInboundError, renderInboundResponse, sniffUsage, supported, upstreamErrorMessage, type Outbound, type OutboundOpts,
} from './convert.js';
import { CACHE_KEY_MAX, addMissing, affinityHeaders, cacheKeyOf, forcesTool, isParamRejection, mentionsCacheKey, mentionsEffort, refusesForcedTool, thinkingOff } from './cache.js';
import { CacheShim, SHIM_PREFIX } from './shim.js';
import { signatureTargetOf, type SigProvider } from './signature.js';
import { ReplayCaches, prepareReasoning } from './replay-cache.js';
import { ResponsesWsRelay, rejectUpgrade } from './ws-relay.js';
import type { Duplex } from 'node:stream';
import { buildGeminiModelList, buildOpenAIModelList, handleCompat, isCompatPreflight, readKeys } from './compat/index.js';
import { isSubAlias } from '../models/subagent.js';
import { modelCaps, nearestLevel } from '../models/catalog.js';
import type { SplitMain, SplitSub } from './split.js';
import { UpstreamError, applyExtraHeaders, decoded, decoder, errorHeaders, forwardHeaders, passthroughHeaders, readText, replaceTopLevelString, responseHeaders, sendUpstream, translatedHeaders, waitDrain, withTimeout, type UpstreamResponse } from './upstream.js';
import { tr } from '../i18n/index.js';
import { PrivacyBlocked, privacyErrorStatus, type PrivacyGuard, type PrivacyService } from '../privacy/service.js';
import { PrivacyRelay, RELAY_PREFIX } from '../privacy/relay.js';
import type { PrivacyRecord } from '../privacy/types.js';
import { Router, type RoutePlan } from '../routing/router.js';
import { observeUpstream } from '../routing/quota.js';
import { quotaRetryAfter } from '../share/limits.js';
import { unpriced, type CandidateLookup, type Eligible, type RouteAccess } from '../routing/candidates.js';
import { DEFAULT_ROUTING, ROUTING_MODELS, ROUTING_POLICIES, candidateKey, type RoutingCandidate, type RoutingConfig, type RoutingStatus } from '../routing/types.js';

/** Streaming: time from sending a request to the first body byte before the member counts as failed. */
export const FIRST_BYTE_MS = 60_000;
/**
 * A sidecar (Gemini web / WorkBuddy) is slower to first byte than an API: an oversized prompt is uploaded as an
 * attachment first, and the component retries accounts inside. 60s turned a working request into 504.
 */
export const SIDECAR_FIRST_BYTE_MS = 3 * 60_000;
/** A sidecar's inline prompt limit (Gemini web's max_prompt_bytes): above it the prompt becomes an attachment. */
export const HEAVY_PROMPT_BYTES = 128_000;
/** Non-streaming: the whole answer comes at once, so a long generation legitimately takes minutes. */
export const NONSTREAM_MS = 10 * 60_000;
/** After the response started: silence this long ends the stream with an error. */
const IDLE_MS = 5 * 60_000;
const BODY_LIMIT = 64 * 1024 * 1024;
/** the split route's wait for the conversation's own upstream to answer (a non-streamed turn answers when done) */
const SPLIT_FORWARD_MS = 15 * 60_000;

/** What a plugin's request-before / response-after hook gets (and may return changed; null = unchanged). */
export interface GatewayHookPayload {
  /** the source the request goes to (its name) and the model asked of it */
  source: string;
  model: string;
  /** upstream path (e.g. /v1/messages) */
  path: string;
  /** the JSON body — already redacted by 隐私保护 (placeholders, never the raw values) */
  body: unknown;
}

/** 插件's gateway hooks (plugins/service.ts). Not set, or no enabled plugin declares the hook → nothing is called. */
export interface GatewayPluginHooks {
  hasHook(hook: 'request-before' | 'response-after'): boolean;
  runHook<T>(hook: 'request-before' | 'response-after', payload: T, onSkip?: (pluginId: string, why: PluginHookSkip['why']) => void): Promise<T>;
}

export interface GatewayDeps {
  meta: MetaStore;
  secrets?: SecretService;
  /** Provider profile with its plaintext key (null when missing / undecryptable). */
  member(providerId: string): Provider | null;
  /** account / pool members (upstreams); falls back to member() for provider members */
  resolveMember?(m: GatewayMember, model: string, sessionKey?: string): Promise<GatewayTarget[]>;
  /** the account pool behind account / pool members (health, daily counters) */
  upstreams?: UpstreamService;
  /** key groups; made here from meta when not passed (tests) */
  keys?: GatewayKeyStore;
  /** audit file; made here (a temp dir) when not passed (tests) */
  audit?: AuditLog;
  ledger?: { record(e: LedgerEntry): void };
  /** 隐私保护: request bodies redacted before they leave, answers restored (privacy/) */
  privacy?: PrivacyService;
  firstByteMs?: number; // tests
  nonStreamMs?: number; // tests
}

type Op = 'generate' | 'count' | 'models';
interface Route { inbound: GatewayProtocol; op: Op; stream: boolean; model?: string; action?: string }

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  group: GatewayGroup;
  route: Route;
  path: string; // normalized path below the group (`/v1/messages`)
  search: string; // query string without our `key`
  raw: Buffer;
  json: any;
  ir?: IrRequest; // lazily parsed for translation
  model: string; // what the client asked for
  signal: AbortSignal;
  t0: number;
  customTools: Set<string>;
  /** the key that paid for this request */
  keyId?: string;
  ip?: string;
  surface?: 'loopback' | 'lan';
  /** what the privacy pipeline did to this request (types / counts / placeholders, for the audit line) */
  privacy?: PrivacyRecord;
  /** plugin hooks skipped on this request (too large / timed out / failed), for the audit line */
  plugins?: PluginHookSkip[];
  /** a routing group's plan for this request (智能路由) */
  plan?: RoutePlan | null;
  /** what 智能路由 may pick for the calling key (its model lists; share keys: no subscription / own paid budget) */
  access?: RouteAccess;
}

/** A group member expanded into one concrete upstream: the state-table key is the ref or the account. */
interface ResolvedMember { m: GatewayMember; key: string; target: GatewayTarget; model: string; /** the routing candidate it came from */ route?: Eligible }

type Attempt =
  | { kind: 'done'; status: number; usage: IrUsage | null; firstByteMs: number; model: string }
  | { kind: 'final'; status: number; text: string; headers: http.IncomingHttpHeaders; passthrough: boolean; model: string }
  | { kind: 'switch'; status: number; message: string; text?: string; headers?: http.IncomingHttpHeaders; passthrough: boolean; model: string }
  | { kind: 'broken'; status: number; message: string; firstByteMs: number; model: string } // failed after committing
  | { kind: 'aborted'; status: 499; message: string; firstByteMs?: number; model: string }; // the client went away

const isLoopback = (a: string | undefined) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));
/** Responses over WebSocket: `/v1/responses` or `/v1/ws`, bare, under `/<group>` or the legacy `/gateway/<group>`. */
const WS_PATH = /^(?:\/gateway\/([^/]+)|\/([A-Za-z0-9_-]{1,40}))?\/v1\/(?:responses|ws)\/?$/;
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const newKey = () => `cwg-${crypto.randomBytes(24).toString('hex')}`;
/**
 * One body through the plugins' hook: the same bytes back when it is not JSON or no plugin changed it (so an
 * untouched passthrough request keeps its exact bytes), re-serialised only when a plugin returned a different body.
 * A plugin that fails / times out is skipped by PluginService.runHook.
 */
async function pluginBody(plugins: GatewayPluginHooks, hook: 'request-before' | 'response-after', meta: Omit<GatewayHookPayload, 'body'>, buf: Buffer | null, skipped?: PluginHookSkip[]): Promise<Buffer | null> {
  if (!buf || !buf.length) return buf;
  let json: unknown;
  try { json = JSON.parse(buf.toString('utf8')); } catch { return buf; }
  const before = JSON.stringify(json);
  const out = await plugins.runHook<GatewayHookPayload>(hook, { ...meta, body: json }, (id, why) => {
    console.warn(`[plugins] ${id} ${hook} skipped: ${why}`);
    if (skipped && !skipped.some((s) => s.id === id && s.hook === hook)) skipped.push({ id, hook, why });
  });
  if (!out || out.body === undefined) return buf;
  const after = JSON.stringify(out.body);
  return after === before ? buf : Buffer.from(after);
}
/** the path segment of the subagent split route (/gateway/~s/<token>/…) */
export const SPLIT_PREFIX = '~s';
export const maskGatewayKey = (k: string) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '');

/** Recognize the inbound API from the path below the group. */
export function routeOf(method: string, path: string, headers: http.IncomingHttpHeaders): Route | null {
  const m = method.toUpperCase();
  if (m === 'POST' && path === '/v1/messages') return { inbound: 'anthropic', op: 'generate', stream: false };
  if (m === 'POST' && path === '/v1/messages/count_tokens') return { inbound: 'anthropic', op: 'count', stream: false };
  if (m === 'POST' && path === '/v1/chat/completions') return { inbound: 'openai', op: 'generate', stream: false };
  if (m === 'POST' && path === '/v1/responses') return { inbound: 'responses', op: 'generate', stream: false };
  if (m === 'GET' && path === '/v1/models') return { inbound: headers['anthropic-version'] ? 'anthropic' : 'openai', op: 'models', stream: false };
  if (m === 'GET' && path === '/v1beta/models') return { inbound: 'gemini', op: 'models', stream: false };
  const g = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/.exec(path);
  if (g && m === 'POST') {
    const model = decodeURIComponent(g[1]);
    if (g[2] === 'countTokens') return { inbound: 'gemini', op: 'count', stream: false, model, action: g[2] };
    return { inbound: 'gemini', op: 'generate', stream: g[2] === 'streamGenerateContent', model, action: g[2] };
  }
  return null;
}

export class GatewayService extends EventEmitter {
  /** Main server port; set once listening (desktop mode picks a new one every start). */
  port = 0;
  readonly states = new MemberStates();
  /** 智能路由: plans, affinity, the decision record and the paid budget (routing groups only) */
  readonly router: Router;
  /** openai / grok profiles' prompt-cache shim (/gateway/~p/…): works whether or not the gateway is enabled */
  readonly shim: CacheShim;
  /** 隐私保护's relay for providers not behind the gateway / shim (privacy/relay.ts; `/gateway/~v/…`) */
  readonly relay: PrivacyRelay | null;
  /** 插件 hooks on each upstream attempt (set by index.ts once plugins are loaded; null → none) */
  plugins: GatewayPluginHooks | null = null;
  /** key groups and keys: what a request may use, from where, how often */
  readonly keys: GatewayKeyStore;
  /** one whitelisted line per request */
  readonly audit: AuditLog;
  private limiter = new RateLimiter();
  /** conversations already told that their prompt passed a sidecar's inline limit (@see HEAVY_PROMPT_BYTES) */
  private heavyNotified = new Set<string>();
  /** member id + model ids whose upstream refused the strength parameter (see `noEffortBody`) */
  private effortRefused = new Set<string>();
  private usageTimer: NodeJS.Timeout;
  /** The stable loopback data plane, separate from the app's ephemeral main listener. */
  private local: GatewayListener;
  private localError?: string;
  private localPortWanted = 61697;
  private localSwitch: Promise<void> = Promise.resolve();
  /** the LAN data plane (its own port; no admin surface) */
  private lan: GatewayListener;
  private key = '';
  /** subagent splits (/gateway/~s/<token>/k/<key>): token → where the conversation's and the subagents' requests go */
  private splits = new Map<string, { main: SplitMain; sub: SplitSub; model: string }>();
  /** where an account's requests go (tests point it at a fake) */
  anthropicBase: string | undefined;
  private splitSecret = crypto.randomBytes(32);
  private firstByteMs: number;
  private nonStreamMs: number;

  constructor(private deps: GatewayDeps) {
    super();
    this.firstByteMs = deps.firstByteMs ?? FIRST_BYTE_MS;
    this.nonStreamMs = deps.nonStreamMs ?? NONSTREAM_MS;
    this.router = new Router({
      load: () => { const v = deps.meta.settings()['routing.spend'] as { day?: unknown; usd?: unknown } | undefined; return v && typeof v.day === 'string' && typeof v.usd === 'number' ? { day: v.day, usd: v.usd } : undefined; },
      save: (v) => { void deps.meta.setSetting('routing.spend', v).catch(() => { /* in memory until the next save */ }); },
    });
    this.localPortWanted = deps.meta.gatewayConfig().localPort ?? 61697;
    this.shim = new CacheShim({ meta: deps.meta, member: deps.member, ledger: deps.ledger, privacy: deps.privacy });
    this.relay = deps.privacy ? new PrivacyRelay(deps.privacy, () => (this.port ? this.baseUrl() : null)) : null;
    this.keys = deps.keys ?? new GatewayKeyStore(deps.meta, deps.secrets);
    this.audit = deps.audit ?? new AuditLog(path.join(os.tmpdir(), 'cw-gateway-audit'), () => deps.meta.gatewayAudit());
    this.audit.on('lines', (lines) => this.emit('audit', lines));
    this.local = this.makeLocalListener();
    this.lan = new GatewayListener((req, res, url) => this.handleLan(req, res, url), (req, socket, head, url) => this.upgradeOn('lan', req, socket, head, url));
    // key counters live in memory; write them at most every 30 s, like the account counters
    this.usageTimer = setInterval(() => { void this.keys.saveUsage(); }, 30_000);
    this.usageTimer.unref?.();
  }

  /** Decrypt the stored key (startup) and bring it into the key store as `key_default`. */
  async init() {
    const c = this.deps.meta.gatewayConfig();
    if (c.key) {
      try { this.key = this.deps.secrets ? await this.deps.secrets.reveal(c.key) : c.key; } catch (e) { console.error('[gateway] cannot decrypt key:', (e as Error).message); }
    }
    if (this.key) await this.keys.migrateLegacy(this.key);
    this.localPortWanted = this.deps.meta.gatewayConfig().localPort ?? 61697;
    await this.startLocal();
    await this.startLan();
  }

  async stop(): Promise<void> {
    clearInterval(this.usageTimer);
    this.wsRelay.close();
    await this.stopLan();
    await this.stopLocal();
    await this.keys.saveUsage().catch(() => {});
    await this.audit.flushNow().catch(() => {});
    this.audit.stop();
  }

  async setAudit(patch: Partial<GatewayAuditConfig>): Promise<void> {
    Object.assign(this.deps.meta.gatewayAudit(), patch);
    await this.deps.meta.saveGateway();
    this.emit('changed');
  }

  async setAllowQueryKey(on: boolean): Promise<void> {
    await this.deps.meta.setSetting('gateway.allowQueryKey', on);
    this.emit('changed');
  }

  enabled() { return !!this.deps.meta.gatewayConfig().enabled && !!this.key; }
  baseUrl() { return `http://127.0.0.1:${this.port}/gateway`; }
  localBaseUrl() { return `http://127.0.0.1:${this.localPortWanted}`; }
  groups() { return this.deps.meta.gatewayGroups(); }
  group(id: string) { return this.groups().find((g) => g.id === id); }

  /** Endpoint + credential a gateway provider profile resolves to, or null (disabled / unknown group). */
  /**
   * Every gateway group is also a provider profile, so the model menu lists its models with no setup: the user
   * adds an account in the gateway page and the group shows up in the menu. Deleting that profile marks the group
   * dismissed (`gateway.dismissedProfiles`) and it is not created again.
   */
  async syncProfiles(): Promise<void> {
    const cfg = this.deps.meta.gatewayConfig();
    const groups = this.groups();
    // a dismissed group that got a member since (the user added an account to it: user report 2026-11-03, a WorkBuddy
    // account in a group whose menu entry was deleted earlier never showed up) is welcome in the menu again. A dismissal
    // from before members were recorded counts as an empty group then
    const back = (cfg.dismissedProfiles ?? []).filter((id) => {
      const g = groups.find((x) => x.id === id);
      const then = new Set(cfg.dismissedMembers?.[id] ?? []);
      return !!g && g.members.some((m) => !then.has(memberKey(m)));
    });
    if (back.length) {
      cfg.dismissedProfiles = (cfg.dismissedProfiles ?? []).filter((id) => !back.includes(id));
      cfg.dismissedMembers = Object.fromEntries(Object.entries(cfg.dismissedMembers ?? {}).filter(([id]) => !back.includes(id)));
      await this.deps.meta.saveGateway();
    }
    const dismissed = new Set(cfg.dismissedProfiles ?? []);
    const profiles = this.deps.meta.providers();
    let changed = false;
    for (const g of groups) {
      if (dismissed.has(g.id)) continue;
      if (profiles.some((p) => p.type === 'gateway' && p.gatewayGroupId === g.id)) continue;
      await this.deps.meta.upsertProvider({ name: g.name, type: 'gateway', gatewayGroupId: g.id, baseUrl: '' });
      changed = true;
    }
    // a group that is gone takes its auto profile with it (a hand-made profile on a missing group stays: the menu
    // already says the group is gone, and the user may be about to recreate it)
    for (const p of profiles) {
      if (p.type !== 'gateway' || !p.gatewayGroupId) continue;
      if (groups.some((g) => g.id === p.gatewayGroupId)) continue;
      if (dismissed.has(p.gatewayGroupId)) continue;
      await this.deps.meta.removeProvider(p.id);
      changed = true;
    }
    if (changed) this.emit('changed');
  }

  endpoint(groupId: string): { baseUrl: string; key: string; runtime?: 'claude'; leanTools?: boolean } | null {
    const g = this.group(groupId);
    if (!this.enabled() || !this.port || !g) return null;
    return {
      baseUrl: `${this.baseUrl()}/${groupId}`,
      key: this.key,
      runtime: this.needsOfficialClient(g) ? 'claude' : undefined,
      leanTools: this.sidecarOnly(g),
    };
  }

  /**
   * A group whose every member is a Gemini-web / WorkBuddy account: those sidecars have no native tool calling and
   * the whole tool schemas ride inside the prompt (100+ KB), which pushes a Claude Code turn over the sidecar's
   * 128 KB attachment limit and adds ~25s before the model answers. Such a session gets a smaller core tool set.
   */
  private sidecarOnly(g: GatewayGroup): boolean {
    if (!g.members.length) return false;
    return g.members.every((m) => {
      if (m.upstreamGroupId) {
        const pool = this.deps.upstreams?.groups().find((x) => x.id === m.upstreamGroupId);
        return !!pool && (pool.kind === 'gemini' || pool.kind === 'workbuddy');
      }
      if (m.accountId) {
        const a = this.deps.upstreams?.store.get(m.accountId);
        return !!a && (a.kind === 'gemini' || a.kind === 'workbuddy');
      }
      return false;
    });
  }

  /** The cache shim's base for a profile (the session appends `/k/<key>[/s/<id>]/v1`) + its per-profile key; null before listening. */
  /** The privacy relay's base for an upstream base URL, or null (privacy off, a skipped local upstream, not listening). */
  privacyBase(target: string): string | null {
    return this.relay && this.deps.privacy?.wants(target) ? this.relay.base(target) : null;
  }
  shimEndpoint(providerId: string): { base: string; key: string } | null {
    return this.port ? { base: `${this.baseUrl()}/~p/${encodeURIComponent(providerId)}`, key: this.shim.keyFor(providerId) } : null;
  }

  /**
   * A conversation whose subagents run on another provider's model (the composer's 子代理 chip): its engine talks to
   * this route instead of its provider. A request for the subagents' alias goes to `sub` (a provider: translated when
   * it speaks another API, its key; an account: Anthropic with its login); everything else goes to `main.base` as the
   * engine sent it, credential and all — so an account login, the cache shim and every request format pass through.
   * The key is in the path (the engine's Authorization header is its own login), per split (HMAC, never stored).
   * Works whether or not the gateway is enabled; null before listening.
   */
  splitEndpoint(main: SplitMain, sub: SplitSub, model: string): string | null {
    if (!this.port) return null;
    const token = crypto.createHash('sha256').update(JSON.stringify([main.base, main.rekey ?? '', sub, model])).digest('hex').slice(0, 32);
    this.splits.set(token, { main, sub, model });
    return `${this.baseUrl()}/${SPLIT_PREFIX}/${token}/k/${this.splitKey(token)}`;
  }
  private splitKey(token: string) { return `cwx-${crypto.createHmac('sha256', this.splitSecret).update(token).digest('hex')}`; }

  /**
   * A group that passes Claude Code through to a relay which only accepts the official client (an
   * Anthropic member marked runtime:'claude') must be fed by the official binary too — ccb's request
   * shape is rejected by that relay's fingerprint check just the same through the gateway.
   */
  needsOfficialClient(g: GatewayGroup): boolean {
    return g.members.some((m) => {
      const p = m.providerId ? this.deps.meta.provider(m.providerId) : undefined;
      return p?.type === 'anthropic' && p.runtime === 'claude';
    });
  }

  status(): GatewayStatus {
    const states: Record<string, GatewayMemberState[]> = {};
    const poolModels: Record<string, string[]> = {};
    const now = Date.now();
    for (const g of this.groups()) {
      // an account or a pool member brings its family's models: the menu needs them (serveModels reads the same cache)
      for (const m of g.members) {
        const key = m.accountId ? `a:${m.accountId}` : m.upstreamGroupId ? `u:${m.upstreamGroupId}` : '';
        if (!key || poolModels[key]) continue;
        // a fake/older upstreams dependency without modelsForMember keeps the old family-only behavior
        const kind = m.accountId
          ? this.deps.upstreams?.store.get(m.accountId)?.kind
          : this.deps.upstreams?.groups().find((x) => x.id === m.upstreamGroupId)?.kind;
        const models = this.deps.upstreams?.modelsForMember?.(m)
          ?? (kind ? this.deps.upstreams?.familyModels(kind) ?? [] : undefined);
        if (models) poolModels[key] = models;
      }
      states[g.id] = g.members.map((m) => {
        const key = memberKey(m);
        const p = m.providerId ? this.deps.meta.provider(m.providerId) : undefined;
        const acct = m.accountId ? this.deps.upstreams?.store.get(m.accountId) : undefined;
        const pool = m.upstreamGroupId ? this.deps.upstreams?.groups().find((x) => x.id === m.upstreamGroupId) : undefined;
        const s = this.states.peek(g.id, key);
        const health = s?.disabled ? 'disabled' : s && s.cooldownUntil > now ? 'cooling' : s?.lastOkAt ? 'ok' : 'unknown';
        return {
          providerId: m.accountId ?? m.upstreamGroupId ?? m.providerId ?? '',
          key,
          name: p?.name ?? acct?.name ?? pool?.name ?? m.accountId ?? m.upstreamGroupId ?? tr('(已删除的供应商)'),
          type: p?.type ?? (acct ? (acct.kind === 'provider' ? 'provider' : 'claude') : pool ? 'pool' : ''),
          health,
          cooldownUntil: s && s.cooldownUntil > now ? s.cooldownUntil : undefined,
          strikes: s?.strikes ?? 0,
          lastError: m.providerId && !p ? tr('供应商不存在') : s?.lastError,
          lastStatus: s?.lastStatus,
          lastOkAt: s?.lastOkAt,
          lastUsedAt: s?.lastUsedAt,
        };
      });
    }
    const localPort = this.localPortWanted;
    return {
      enabled: this.enabled(), baseUrl: this.baseUrl(), localBaseUrl: `http://127.0.0.1:${localPort}`, localPort,
      localRunning: this.local.running, localError: this.localError,
      keyMasked: maskGatewayKey(this.key), groups: this.groups(), states, poolModels,
    };
  }

  private async storeKey(k: string) {
    this.key = k;
    this.deps.meta.gatewayConfig().key = this.deps.secrets ? await this.deps.secrets.protect(k, 'gateway') : k;
  }

  async setEnabled(on: boolean) {
    if (on && !this.key) {
      // generated on first enable; it becomes (or replaces) the revealable default key
      await this.storeKey(newKey());
      await this.keys.replaceLegacy(this.key);
    } else if (on && this.key) await this.keys.migrateLegacy(this.key);
    this.deps.meta.gatewayConfig().enabled = on;
    await this.deps.meta.saveGateway();
    this.emit('changed');
  }
  async regenerateKey() {
    const k = newKey();
    await this.storeKey(k);
    await this.keys.replaceLegacy(k);
    await this.deps.meta.saveGateway();
    this.emit('changed');
  }
  revealKey() { return this.key; }

  async upsertGroup(patch: Omit<Partial<GatewayGroup>, 'routing'> & { id?: string; routing?: Partial<RoutingConfig> | null }): Promise<GatewayGroup> {
    const list = this.groups();
    let g = patch.id ? list.find((x) => x.id === patch.id) : undefined;
    if (!g) {
      g = { id: patch.id && /^[A-Za-z0-9_-]{1,40}$/.test(patch.id) ? patch.id : crypto.randomBytes(4).toString('hex'), name: tr('新组'), members: [], strategy: 'failover' };
      list.push(g);
    }
    if (patch.name !== undefined) g.name = String(patch.name).trim() || g.name;
    if (patch.strategy) g.strategy = patch.strategy === 'round-robin' ? 'round-robin' : 'failover';
    if (patch.members) {
      const seen = new Set<string>();
      g.members = patch.members
        .filter((m) => {
          const k = memberKey(m);
          return k !== 'p:' && !seen.has(k) && !!seen.add(k);
        })
        .map((m) => ({
          ...(m.providerId ? { providerId: m.providerId } : {}),
          ...(m.accountId ? { accountId: m.accountId } : {}),
          ...(m.upstreamGroupId ? { upstreamGroupId: m.upstreamGroupId } : {}),
          ...(m.model?.trim() ? { model: m.model.trim() } : {}),
          ...(m.weight && m.weight !== 1 ? { weight: Math.max(1, Math.floor(m.weight)) } : {}),
        }));
    }
    if (patch.modelMap !== undefined) g.modelMap = Object.fromEntries(Object.entries(patch.modelMap ?? {}).map(([k, v]) => [k.trim(), String(v).trim()]).filter(([k, v]) => k && v));
    if (patch.cache1h !== undefined) { if (patch.cache1h) g.cache1h = true; else delete g.cache1h; }
    if (patch.routing !== undefined) this.applyRouting(g, patch.routing);
    this.states.reset(g.id); // edited group: disabled members get another chance
    await this.deps.meta.saveGateway();
    await this.syncProfiles();
    this.emit('changed');
    return g;
  }
  async removeGroup(id: string) {
    const m = this.deps.meta;
    m.data.gatewayGroups = this.groups().filter((g) => g.id !== id);
    this.states.reset(id);
    await m.saveGateway();
    await this.syncProfiles();
    this.emit('changed');
  }
  // ---- 智能路由 (routing groups) ----

  /** The routing group (the first group with `routing`), if any. */
  routingGroup(): GatewayGroup | undefined { return this.groups().find((g) => !!g.routing); }

  /** Clean a routing patch onto `g`: candidates checked and de-duplicated, numbers clamped, members derived. */
  private applyRouting(g: GatewayGroup, patch: Partial<RoutingConfig> | null) {
    if (patch === null) { delete g.routing; return; }
    const cur: RoutingConfig = { ...DEFAULT_ROUTING, ...(g.routing ?? {}) };
    const next: RoutingConfig = { ...cur, ...patch };
    if (!ROUTING_POLICIES.includes(next.policy)) next.policy = 'auto';
    next.maxAttempts = Math.max(1, Math.min(5, Math.floor(Number(next.maxAttempts) || 1)));
    next.failover = next.failover !== false;
    next.allowPaid = !!next.allowPaid;
    if (next.budgetUsd !== undefined) next.budgetUsd = Math.max(0, Number(next.budgetUsd) || 0);
    const seen = new Set<string>();
    next.candidates = (next.candidates ?? [])
      .filter((c) => c && (c.providerId || c.accountId || c.upstreamGroupId) && String(c.model ?? '').trim())
      .map((c): RoutingCandidate => ({
        ...(c.accountId ? { accountId: c.accountId } : c.upstreamGroupId ? { upstreamGroupId: c.upstreamGroupId } : { providerId: c.providerId }),
        model: String(c.model).trim(),
        allowAuto: !!c.allowAuto,
        ...(c.cost === 'free' || c.cost === 'subscription' || c.cost === 'paid' ? { cost: c.cost } : {}),
        ...(c.caps && typeof c.caps === 'object' ? { caps: c.caps } : {}),
        ...(c.price && Number(c.price.input) >= 0 && Number(c.price.output) >= 0 ? { price: { input: Number(c.price.input), output: Number(c.price.output) } } : {}),
        ...(c.allowUnpriced === true ? { allowUnpriced: true } : {}),
        ...(c.weight !== undefined && Number.isFinite(Number(c.weight)) ? { weight: Math.max(0, Math.min(1000, Number(c.weight))) } : {}),
      }))
      .filter((c) => { const k = candidateKey(c); return !seen.has(k) && !!seen.add(k); });
    next.rules = (next.rules ?? []).filter((r) => r && Array.isArray(r.prefer)).map((r, i) => ({ id: String(r.id || `rule-${i + 1}`), when: r.when ?? {}, prefer: r.prefer.map(String) }));
    if (typeof next.ruleText === 'string') next.ruleText = next.ruleText.slice(0, 4000);
    g.routing = next;
    // one member per source (status, the engine's runtime / lean-tools checks); the candidates are what is tried
    const refs = new Map<string, GatewayMember>();
    for (const c of next.candidates) {
      const m: GatewayMember = c.accountId ? { accountId: c.accountId } : c.upstreamGroupId ? { upstreamGroupId: c.upstreamGroupId } : { providerId: c.providerId };
      refs.set(memberKey(m), m);
    }
    g.members = [...refs.values()];
    g.strategy = 'failover';
    this.router.affinity.clear(g.id);
  }

  /** 智能路由 → make its group (and so its model-menu entry) when there is none. */
  async ensureRoutingGroup(): Promise<GatewayGroup> {
    const g = this.routingGroup();
    if (g) return g;
    return this.upsertGroup({ id: 'smart', name: tr('智能路由'), routing: { ...DEFAULT_ROUTING } });
  }

  async setRouting(patch: Partial<RoutingConfig>): Promise<RoutingStatus> {
    const g = await this.ensureRoutingGroup();
    await this.upsertGroup({ id: g.id, routing: patch });
    return this.routingStatus();
  }

  private routingLook(): CandidateLookup {
    return {
      provider: (id) => this.deps.meta.provider(id),
      accountKind: (c) => c.accountId ? this.deps.upstreams?.store.get(c.accountId)?.kind
        : c.upstreamGroupId ? this.deps.upstreams?.groups().find((x) => x.id === c.upstreamGroupId)?.kind : undefined,
    };
  }

  /** Why a candidate's source cannot be used right now; null = usable. */
  private routingUnusable(groupId: string, c: RoutingCandidate, key: string): string | null {
    if (c.providerId && !this.deps.meta.provider(c.providerId)) return tr('来源不存在');
    if (c.accountId && !this.deps.upstreams?.store.get(c.accountId)) return tr('账号不存在');
    if (c.upstreamGroupId && !this.deps.upstreams?.groups().some((x) => x.id === c.upstreamGroupId)) return tr('账号池不存在');
    const st = this.states.peek(groupId, key);
    if (st?.disabled) return tr('已停用（鉴权失败）');
    if (st && st.cooldownUntil > Date.now()) return tr('冷却中');
    return null;
  }

  routingStatus(limit = 50): RoutingStatus {
    const g = this.routingGroup();
    const config: RoutingConfig = { ...DEFAULT_ROUTING, ...(g?.routing ?? {}) };
    const look = this.routingLook();
    const plan = this.router.plan({ groupId: g?.id ?? '', config, model: '', ir: null, json: {}, look, unusable: (c, k) => (g ? this.routingUnusable(g.id, c, k) : null) });
    const now = Date.now();
    const views = new Map(plan.decision.candidates.map((v) => [v.key, v]));
    return {
      groupId: g?.id ?? null,
      config,
      candidates: config.candidates.map((c) => {
        const key = candidateKey(c);
        const v = views.get(key)!;
        const n = this.router.log.numbers(key);
        const st = g ? this.states.peek(g.id, key) : undefined;
        return { ...v, key, ...(v.cost === 'paid' && unpriced(c) ? { unpriced: true } : {}), ok: n.ok, fail: n.fail, latencyMs: n.latencyMs, health: st?.disabled ? 'disabled' : st && st.cooldownUntil > now ? 'cooling' : n.ok ? 'ok' : 'unknown', ...(st && st.cooldownUntil > now ? { cooldownUntil: st.cooldownUntil } : {}) };
      }),
      spentTodayUsd: Math.round(this.router.log.spentToday() * 10000) / 10000,
      switchesToday: this.router.log.switchesToday(),
      decisions: this.router.log.recent(g?.id, limit),
    };
  }

  reset(groupId: string, ref?: string) {
    // the request carries a provider id (old callers) or already a `p:` / `a:` / `u:` key
    this.states.reset(groupId, ref && !ref.includes(':') ? `p:${ref}` : ref);
    this.emit('changed');
  }

  // ---- LAN listener ----

  lanStatus(): GatewayLanStatus {
    const c = this.deps.meta.gatewayLan();
    const addresses = Object.values(os.networkInterfaces()).flat()
      .filter((x): x is os.NetworkInterfaceInfo => !!x && x.family === 'IPv4' && !x.internal)
      .map((x) => x.address);
    return { ...c, running: this.lan.running, port: this.lan.port, addresses, audit: this.deps.meta.gatewayAudit() };
  }

  async setLan(patch: Partial<GatewayLanConfig> & { confirmAny?: boolean }): Promise<GatewayLanStatus> {
    const c = this.deps.meta.gatewayLan();
    // allowlist / CORS / body size are read per request; only a network change restarts the listener
    // (with `port: 0` a restart picks a new port, which would break a client holding the old URL)
    const before = { enabled: c.enabled, bind: c.bind, port: c.port };
    if (patch.bind !== undefined) {
      const priv = patch.bind === '0.0.0.0' || patch.bind === '127.0.0.1'
        || /^10\./.test(patch.bind) || /^192\.168\./.test(patch.bind) || /^172\.(1[6-9]|2\d|3[01])\./.test(patch.bind);
      if (!priv) throw new Error(tr('监听地址必须是本机私网 IP 或 0.0.0.0'));
      if (patch.bind === '0.0.0.0' && !patch.confirmAny) throw new Error(tr('监听 0.0.0.0 需要二次确认'));
      c.bind = patch.bind;
    }
    if (patch.port !== undefined) c.port = Math.max(0, Math.floor(patch.port));
    if (patch.ipAllowlist !== undefined) c.ipAllowlist = patch.ipAllowlist.map((x) => x.trim()).filter(Boolean);
    if (patch.corsOrigins !== undefined) c.corsOrigins = patch.corsOrigins.map((x) => x.trim()).filter(Boolean);
    if (patch.maxBodyBytes !== undefined) c.maxBodyBytes = Math.max(1024, Math.floor(patch.maxBodyBytes));
    if (patch.enabled !== undefined) c.enabled = patch.enabled;
    await this.deps.meta.saveGateway();
    const moved = before.enabled !== c.enabled || before.bind !== c.bind || before.port !== c.port;
    if (c.enabled) { if (!this.lan.running || moved) await this.startLan(); }
    else await this.stopLan();
    this.emit('changed');
    return this.lanStatus();
  }

  async startLan(): Promise<void> {
    const c = this.deps.meta.gatewayLan();
    if (!c.enabled) return;
    if (this.lan.running) await this.lan.stop();
    try {
      await this.lan.start(c.bind, c.port);
    } catch (e: any) {
      // a port conflict / a firewall refusal is not fatal to the main gateway: report and stay off
      console.error('[gateway lan]', e?.message ?? e);
      await this.lan.stop();
    }
  }

  async stopLan(): Promise<void> { await this.lan.stop(); }

  async setLocalPort(port: number): Promise<GatewayStatus> {
    const nextPort = port;
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) throw new Error(tr('本机网关端口必须在 1024 到 65535 之间'));
    let result!: GatewayStatus;
    let failure: unknown;
    this.localSwitch = this.localSwitch.then(async () => {
      const current = this.localPortWanted;
      if (nextPort === current && this.local.running) { this.localError = undefined; result = this.status(); return; }
      const next = this.makeLocalListener();
      // 1. the new port must accept a connection before anything else changes
      try {
        await next.start('127.0.0.1', nextPort);
      } catch (e: any) {
        await next.stop().catch(() => {});
        this.localError = tr('本机地址 {port} 无法启用：{error}', { port: String(nextPort), error: e?.message ?? String(e) });
        failure = new Error(this.localError);
        return;
      }
      // 2. the old one goes before the switch: a throw here leaves the working listener untouched
      const old = this.local;
      try {
        await old.stop();
      } catch {
        await next.stop().catch(() => {});
        this.localError = tr('本机地址 {port} 无法启用：旧监听没有关掉', { port: String(nextPort) });
        failure = new Error(this.localError);
        return;
      }
      // 3. persist, then point at the new listener; a failed write comes back to the old port
      const cfg = this.deps.meta.gatewayConfig();
      const prev = this.localPortWanted;
      try {
        cfg.localPort = nextPort;
        await this.deps.meta.saveGateway();
      } catch (e: any) {
        cfg.localPort = prev;
        this.localPortWanted = prev;
        const back = this.makeLocalListener();
        await back.start('127.0.0.1', prev).catch(() => {});
        this.local = back;
        await next.stop().catch(() => {});
        this.localError = tr('本机地址 {port} 无法启用：{error}', { port: String(nextPort), error: e?.message ?? String(e) });
        failure = new Error(this.localError);
        return;
      }
      this.local = next;
      this.localPortWanted = nextPort;
      this.localError = undefined;
      this.emit('changed');
      result = this.status();
    }).catch(() => { /* a rejected link must not poison later switches (failure is reported above) */ });
    await this.localSwitch;
    if (failure) throw failure;
    return result;
  }

  private makeLocalListener(): GatewayListener {
    return new GatewayListener((req, res, url) => this.handleLocal(req, res, url), (req, socket, head, url) => this.upgradeOn('loopback', req, socket, head, url));
  }

  private async startLocal(): Promise<void> {
    const port = this.localPortWanted;
    try {
      await this.local.start('127.0.0.1', port);
      this.localError = undefined;
    } catch (e: any) {
      this.localError = tr('本机地址 {port} 无法启用：{error}', { port: String(port), error: e?.message ?? String(e) });
      console.error('[gateway local]', this.localError);
      await this.local.stop().catch(() => {});
    }
  }

  async stopLocal(): Promise<void> { await this.local.stop(); }

  private handleLocal(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const p = url.pathname;
    if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, enabled: this.enabled() })); return; }
    if (this.handleLocalRoute(req, res, url)) return;
    res.writeHead(404).end();
  }

  private handleLocalRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    const p = url.pathname;
    const root = /^\/(v1|v1beta)(\/|$)/.test(p);
    const explicit = /^\/([A-Za-z0-9_-]{1,40})\/(v1|v1beta)(\/|$)/.exec(p);
    if (!root && !explicit) return false;
    if ((req.socket as any).cwRemote || !isLoopback(req.socket.remoteAddress)) { res.writeHead(404).end(); return true; }
    void this.serveRequest(req, res, url, { surface: 'loopback', groupId: explicit?.[1], rest: root ? p : p.slice(explicit![1].length + 1) }).catch((e) => {
      console.error('[gateway local]', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
      else res.destroy();
    });
    return true;
  }

  private handleLan(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const p = url.pathname;
    const ok = p === '/healthz' || /^\/(v1|v1beta)(\/|$)/.test(p);
    if (!ok) { res.writeHead(404).end(); return; }
    const c = this.deps.meta.gatewayLan();
    // CORS: no header by default; a listed origin is echoed, never `*`
    const origin = String(req.headers.origin ?? '');
    if (origin && c.corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'content-type, x-api-key, authorization, x-goog-api-key, anthropic-version, anthropic-beta');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    }
    const ip = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    // the listener-level allowlist admits only listed addresses from outside this machine
    if (!isLoopback(ip) && c.ipAllowlist.length && !ipInList(ip, c.ipAllowlist)) { res.writeHead(403).end(); return; }
    if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true })); return; }
    void this.serveRequest(req, res, url, { surface: 'lan', rest: p }).catch((e) => {
      console.error('[gateway lan]', e);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  }

  // ---------------------------------------------------------------- HTTP

  /**
   * True when the request belongs to the gateway (it has then been answered). Three shapes reach here:
   * the old `/gateway/<group>/…`, an explicit `/<group>/v1/…`, and the bare `/v1/…` root.
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    const p = url.pathname;
    const legacy = p === '/gateway' || p.startsWith('/gateway/');
    const explicit = /^\/([A-Za-z0-9_-]{1,40})\/(v1|v1beta)(\/|$)/.exec(p);
    const root = /^\/(v1|v1beta)(\/|$)/.test(p) || p === '/healthz';
    if (!legacy && !explicit && !root) return false;
    // the admin/data plane on the main listener is this machine's — the LAN listener has its own handleLan
    if ((req.socket as any).cwRemote || !isLoopback(req.socket.remoteAddress)) { res.writeHead(404).end(); return true; }
    if (legacy && p.startsWith(`/gateway/${SPLIT_PREFIX}/`)) {
      void this.serveSplit(req, res, url).catch((e) => {
        console.error('[gateway split]', e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
        else res.destroy();
      });
      return true;
    }
    if (legacy && p.startsWith(RELAY_PREFIX) && this.relay) {
      void this.relay.serve(req, res, url).catch((e) => {
        console.error('[privacy relay]', e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
        else res.destroy();
      });
      return true;
    }
    if (legacy && p.startsWith(SHIM_PREFIX)) {
      void this.shim.serve(req, res, url).catch((e) => {
        console.error('[gateway shim]', e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
        else res.destroy();
      });
      return true;
    }
    let groupId: string | undefined;
    let rest: string;
    if (legacy) {
      const m = /^\/gateway\/([^/]+)(\/.*)?$/.exec(p);
      groupId = m ? decodeURIComponent(m[1]) : undefined;
      rest = m?.[2] ?? '/';
    } else if (explicit) {
      groupId = explicit[1];
      rest = p.slice(explicit[1].length + 1);
    } else rest = p;
    void this.serveRequest(req, res, url, { surface: 'loopback', groupId, rest }).catch((e) => {
      console.error('[gateway]', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
      else res.destroy();
    });
    return true;
  }

  // ---------------------------------------------------------------- Responses over WebSocket (ws-relay.ts)

  /** The main listener's upgrade: true when the socket is the gateway's (it has then been answered). */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
    return this.upgradeOn('loopback', req, socket, head, url);
  }

  private upgradeOn(surface: 'loopback' | 'lan', req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
    const m = WS_PATH.exec(url.pathname);
    if (!m) return false;
    const groupId = m[1] !== undefined ? safeDecode(m[1]) : m[2];
    if (surface === 'loopback' && ((req.socket as any).cwRemote || !isLoopback(req.socket.remoteAddress))) { rejectUpgrade(socket, 404, {}); return true; }
    void this.authorizeUpgrade(surface, req, url, groupId).then((r) => {
      if ('status' in r) return rejectUpgrade(socket, r.status, renderInboundError('responses', r.status, r.message));
      const key = r.key;
      const target = `http://127.0.0.1:${this.port || this.local.port}${groupId ? `/gateway/${encodeURIComponent(groupId)}` : ''}/v1/responses`;
      // each turn is an ordinary POST through this gateway: routing, failover, limits, budget, privacy, ledger
      const pass: Record<string, string> = {};
      for (const h of ['user-agent', 'session_id', 'x-session-affinity', 'originator', 'version', 'openai-beta', 'x-claude-code-session-id']) {
        const v = req.headers[h];
        if (typeof v === 'string' && v) pass[h] = v;
      }
      this.wsRelay.upgrade(req, socket, head, (body, signal) => fetch(target, {
        method: 'POST', signal, body: JSON.stringify(body),
        headers: { ...pass, 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${key}` },
      }));
    }).catch((e) => { console.error('[gateway ws]', e); rejectUpgrade(socket, 500, {}); });
    return true;
  }

  /** The same gate a POST meets before it is routed (enabled, key, LAN / IP rules, group access). */
  private async authorizeUpgrade(surface: 'loopback' | 'lan', req: http.IncomingMessage, url: URL, groupId: string | undefined): Promise<{ key: string } | { status: number; message: string }> {
    if (!this.enabled()) return { status: 503, message: tr('模型网关未启用（设置 → 模型网关）') };
    const ip = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (surface === 'lan') {
      const c = this.deps.meta.gatewayLan();
      if (!isLoopback(ip) && c.ipAllowlist.length && !ipInList(ip, c.ipAllowlist)) return { status: 403, message: tr('来源 IP 不在白名单') };
    }
    const presented = this.presentedKeys(req, url);
    let hit = presented.map((k) => ({ k, a: this.keys.verify(k) })).find((x) => x.a);
    if (!hit && presented.some((k) => this.keyOk(k))) {
      await this.keys.migrateLegacy(this.key);
      const a = this.keys.verify(this.key);
      if (a && a.key.id === 'key_default') hit = { k: this.key, a };
    }
    if (!hit?.a) return { status: 401, message: tr('网关密钥无效') };
    const auth = hit.a;
    if (surface === 'lan') {
      if (!auth.group.allowLan) return { status: 403, message: tr('这个密钥不允许从局域网使用') };
      if (!isLoopback(ip) && !ipInList(ip, auth.group.ipAllowlist)) return { status: 403, message: tr('来源 IP 不在白名单') };
    } else if (!isLoopback(ip) && auth.group.ipAllowlist.length && !ipInList(ip, auth.group.ipAllowlist)) {
      return { status: 403, message: tr('来源 IP 不在白名单') };
    }
    if (groupId && auth.group.routeGroupIds.length && !auth.group.routeGroupIds.includes(groupId)) {
      return { status: 403, message: tr('这个密钥不能使用组「{group}」', { group: groupId }) };
    }
    return { key: hit.k };
  }

  /** Every credential the client presented (a client may send an empty / stale x-api-key next to a good Bearer). */
  private presentedKeys(req: Pick<http.IncomingMessage, 'headers'>, url: URL): string[] {
    // `?key=` is off by default: a URL lands in logs and shell history
    const allowQuery = this.deps.meta.settings()['gateway.allowQueryKey'] === true;
    return readKeys(req, url, { allowQuery }).map((k) => k.key);
  }
  private keyOk(k: string): boolean {
    const a = Buffer.from(k);
    const b = Buffer.from(this.key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private sendError(res: http.ServerResponse, inbound: GatewayProtocol, status: number, message: string, extra: Record<string, string> = {}) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(renderInboundError(inbound, status, message)));
  }

  /**
   * One gateway request: authenticate the key, apply its group's IP / LAN / pace / budget rules, choose the route
   * group, and hand off to `run`. Shared by the main listener (`surface: 'loopback'`) and the LAN listener.
   */
  private async serveRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, o: { surface: 'loopback' | 'lan'; groupId?: string; rest: string }) {
    let rest = o.rest;
    if (!/^\/v1(beta)?\//.test(rest) && rest !== '/v1' && rest !== '/v1beta') rest = `/v1${rest === '/' ? '' : rest}`; // base URL given without the version
    const route = routeOf(req.method ?? 'GET', rest, req.headers);
    const inbound = route?.inbound ?? (rest.startsWith('/v1beta') ? 'gemini' : req.headers['anthropic-version'] ? 'anthropic' : 'openai');
    if (url.pathname === '/healthz') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, enabled: this.enabled() }));
    // a CORS preflight carries no credentials: answer it before auth (the LAN listener has already
    // answered a listed origin's; elsewhere only a listed origin is echoed, never `*`)
    if (isCompatPreflight(req, url)) {
      const origin = String(req.headers.origin ?? '');
      const listed = !!origin && this.deps.meta.gatewayLan().corsOrigins.includes(origin);
      handleCompat(req, res, url, { corsOrigin: listed ? origin : null });
      return;
    }
    const ip = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    // every refusal is audited too: a 401 / 403 / 429 is exactly what an operator looks for
    const deny = (status: number, message: string, extra: Record<string, string> = {}, who: { keyId?: string; routeGroupId?: string; model?: string } = {}) => {
      this.audit.write({
        ts: Date.now(), keyId: who.keyId ?? '', ip, protocol: inbound,
        model: who.model ?? route?.model ?? '', routeGroupId: who.routeGroupId ?? o.groupId ?? '',
        member: '', status, ms: 0, tokensIn: 0, tokensOut: 0, errorCode: String(status),
      });
      return this.sendError(res, inbound, status, message, extra);
    };
    if (!this.enabled()) return deny(503, tr('模型网关未启用（设置 → 模型网关）'));

    const presented = this.presentedKeys(req, url);
    let auth = presented.map((k) => this.keys.verify(k)).find(Boolean) ?? null;
    // the legacy single key (tests, or the moment before init migrated it): make `key_default` on demand
    if (!auth && presented.some((k) => this.keyOk(k))) {
      await this.keys.migrateLegacy(this.key);
      // the default key must verify the presented key — a stale key store is not an authorization
      const hit = this.keys.verify(this.key);
      if (hit && hit.key.id === 'key_default') auth = hit;
    }
    if (!auth) {
      // an agent logged in with its own account (ChatGPT / Google / claude.ai) sends that token, not ours
      const foreign = presented.length > 0 && !presented.some((k) => k.startsWith('cwg-'));
      return deny(401, foreign ? tr('网关密钥无效：agent 没有用网关密钥（发来的不是 cwg- 开头的密钥），检查它的登录方式是否被账号登录覆盖了') : tr('网关密钥无效'));
    }
    if (o.surface === 'lan') {
      if (!auth.group.allowLan) return deny(403, tr('这个密钥不允许从局域网使用'), {}, { keyId: auth.key.id });
      // an empty list admits nobody from outside this machine
      if (!isLoopback(ip) && !ipInList(ip, auth.group.ipAllowlist)) return deny(403, tr('来源 IP 不在白名单'), {}, { keyId: auth.key.id });
    } else if (!isLoopback(ip) && auth.group.ipAllowlist.length && !ipInList(ip, auth.group.ipAllowlist)) {
      return deny(403, tr('来源 IP 不在白名单'), {}, { keyId: auth.key.id });
    }
    // an explicit group the key may not use is a permission error, not "no such group"
    if (o.groupId && auth.group.routeGroupIds.length && !auth.group.routeGroupIds.includes(o.groupId)) {
      return deny(403, tr('这个密钥不能使用组「{group}」', { group: o.groupId }), {}, { keyId: auth.key.id, routeGroupId: o.groupId });
    }
    const take = this.limiter.take(auth.key.id, auth.group.rateLimit);
    if (!take.ok) {
      return deny(429, take.reason === 'concurrent' ? tr('这个密钥同时进行的请求太多') : tr('这个密钥每分钟的请求太多'), {
        'retry-after': String(Math.max(1, Math.ceil(take.retryAfterMs / 1000))),
      }, { keyId: auth.key.id });
    }
    res.on('close', take.release);
    const spend = this.keys.canSpend(auth.key, auth.group);
    if (!spend.ok) return deny(429, spend.message, { 'retry-after': String(quotaRetryAfter(auth.key, auth.group)) }, { keyId: auth.key.id });
    // a share key with nothing ticked ('~none~' is effectiveGroup's "nothing"): say so, not "name a group: (empty)"
    const reachable = auth.group.routeGroupIds;
    if (reachable.length && reachable.every((id) => !this.groups().some((g) => g.id === id))) {
      return deny(403, tr('这个密钥还没有可用的网关组：在分享设置里给它勾选'), {}, { keyId: auth.key.id });
    }

    if (route?.op === 'models') {
      const picked = pickRouteGroup({ pathGroupId: o.groupId, model: '', groups: this.groups(), allowed: auth.group.routeGroupIds });
      if ('error' in picked) {
        return deny(picked.error === 'ambiguous' ? 400 : 404,
          picked.error === 'ambiguous' ? tr('请用「组名/模型」指定组：{groups}', { groups: picked.groups.join('、') }) : tr('没有可用的组'), {}, { keyId: auth.key.id });
      }
      return this.serveModels(res, picked.group, route.inbound, auth.group);
    }
    if (!route) return deny(404, tr('网关不支持这个接口：{method} {rest}', { method: req.method, rest }), {}, { keyId: auth.key.id });

    const limit = o.surface === 'lan' ? Math.min(BODY_LIMIT, this.deps.meta.gatewayLan().maxBodyBytes) : BODY_LIMIT;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) return deny(413, tr('请求体过大'), {}, { keyId: auth.key.id });
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks);
    let json: any;
    try { json = JSON.parse(raw.toString('utf8') || '{}'); } catch { return deny(400, tr('请求体不是合法 JSON'), {}, { keyId: auth.key.id }); }
    const asked = route.model ?? String(json?.model ?? '');
    const picked = pickRouteGroup({ pathGroupId: o.groupId, model: asked, groups: this.groups(), allowed: auth.group.routeGroupIds });
    if ('error' in picked) {
      return deny(picked.error === 'ambiguous' ? 400 : 404,
        picked.error === 'ambiguous'
          ? tr('请用「组名/模型」指定组：{groups}', { groups: picked.groups.join('、') })
          : tr('没有这个网关组：{v}', { v: o.groupId ?? '' }), {}, { keyId: auth.key.id, model: asked });
    }
    if (!modelAllowed(picked.model, auth.group.modelAllowlist, auth.group.modelDeny)) {
      return deny(403, tr('这个密钥不能用模型 {model}', { model: picked.model }), {}, { keyId: auth.key.id, routeGroupId: picked.group.id, model: picked.model });
    }
    const stream = route.inbound === 'gemini' ? route.stream : !!json?.stream;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const params = new URLSearchParams(url.search);
    params.delete('key');
    const search = params.toString() ? `?${params}` : '';
    const ctx: Ctx = {
      req, res, group: picked.group, route: { ...route, stream }, path: rest, search, raw, json,
      model: picked.model, signal: ac.signal, t0: Date.now(), customTools: new Set(),
      keyId: auth.key.id, ip, surface: o.surface, access: routeAccess(auth.key, auth.group),
    };
    return this.run(ctx);
  }

  /** The body of a request, or null when an error was sent (too big / not JSON). */
  private async readJson(req: http.IncomingMessage, res: http.ServerResponse, inbound: GatewayProtocol): Promise<{ raw: Buffer; json: any } | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) { this.sendError(res, inbound, 413, tr('请求体过大')); return null; }
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks);
    try { return { raw, json: JSON.parse(raw.toString('utf8') || '{}') }; } catch { this.sendError(res, inbound, 400, tr('请求体不是合法 JSON')); return null; }
  }

  /**
   * /gateway/~s/<token>/k/<key>/…: the subagents' alias to their target, anything else on to the conversation's own
   * base URL as the engine sent it (see splitEndpoint). The path below the key is the engine's: `/v1/messages`
   * (Anthropic), `/chat/completions` (an OpenAI-format base ending in /v1), `/models/<id>:<action>` (Gemini).
   */
  private async serveSplit(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const m = /^\/gateway\/~s\/([^/]+)\/k\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const token = m?.[1] ?? '';
    const split = this.splits.get(token);
    if (!m || !split) return this.sendError(res, 'anthropic', 404, tr('没有这条子代理分流'));
    const want = Buffer.from(this.splitKey(token));
    const got = Buffer.from(m[2]);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return this.sendError(res, 'anthropic', 401, tr('子代理分流的密钥无效'));
    const rest = m[3] ?? '/';
    const raw = await this.readBody(req, res);
    if (!raw) return;
    let json: any = null;
    try { json = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* not JSON: the main conversation's, passed on */ }
    // Gemini names the model in the path, the others in the body
    const g = /^(\/v1beta)?\/models\/([^/:]+):(\w+)$/.exec(rest);
    let model = String(json?.model ?? '');
    if (g) { try { model = decodeURIComponent(g[2]); } catch { model = g[2]; } }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    // the official binary asks for Claude's thinking as text for the whole process (session-runner): another maker's
    // model behind an Anthropic-format relay gets a body without that field, which it may not know
    const toSub = isSubAlias(model, split.model);
    let body = raw;
    if (!g && json?.thinking && typeof json.thinking === 'object' && 'display' in json.thinking && !/claude/i.test(toSub ? split.model : model)) {
      delete json.thinking.display;
      body = Buffer.from(JSON.stringify(json));
    }
    if (!toSub) return this.forward(req, res, `${split.main.base.replace(/\/+$/, '')}${rest}${url.search}`, body, split.main.rekey !== undefined ? { bearer: split.main.rekey, oauthBeta: 'drop' } : {}, ac.signal);
    // from here on the subagents' request names the real model, so the answer does too (a translated answer echoes
    // the model it was asked for — the alias showed on the subagent's messages, 2026-10-17 real relay)
    if (!g && json) {
      json.model = split.model;
      body = Buffer.from(replaceTopLevelString(body.toString('utf8'), 'model', split.model) ?? JSON.stringify(json));
    }
    if (split.sub.kind === 'account') {
      const target = `${(this.anthropicBase ?? 'https://api.anthropic.com').replace(/\/+$/, '')}${rest}${url.search}`;
      return this.forward(req, res, target, body, split.sub.token ? { bearer: split.sub.token, oauthBeta: 'ensure' } : {}, ac.signal);
    }
    const path = g ? `/v1beta/models/${encodeURIComponent(split.model)}:${g[3]}` : /^\/v1(beta)?\//.test(rest) ? rest : `/v1${rest}`;
    const route = routeOf(req.method ?? 'GET', path, req.headers);
    if (!route || route.op === 'models') return this.sendError(res, 'anthropic', 404, tr('网关不支持这个接口：{method} {rest}', { method: req.method, rest }));
    // an engine on an account login: its login beta is not the provider's business (its key is swapped by passthroughHeaders)
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'anthropic-beta') req.rawHeaders[i + 1] = req.rawHeaders[i + 1].split(',').map((s) => s.trim()).filter((s) => s && s !== 'oauth-2025-04-20').join(',');
    const pool = split.sub.kind === 'gateway' ? this.group(split.sub.groupId) : undefined;
    if (split.sub.kind === 'gateway' && !pool) return this.sendError(res, 'anthropic', 404, tr('没有这个网关组：{v}', { v: split.sub.groupId }));
    const subId = split.sub.kind === 'provider' ? split.sub.providerId : '';
    const group: GatewayGroup = pool ?? { id: `${SPLIT_PREFIX}:${token}:sub`, name: tr('子代理'), strategy: 'failover', members: [{ providerId: subId, model: split.model }] };
    const params = new URLSearchParams(url.search);
    params.delete('key');
    const parsed = json ?? {};
    const ctx: Ctx = { req, res, group, route: { ...route, stream: route.stream || !!parsed.stream }, path, search: params.toString() ? `?${params}` : '', raw: body, json: parsed, model: split.model, signal: ac.signal, t0: Date.now(), customTools: new Set() };
    try {
      await this.run(ctx);
    } finally {
      // one member and no one to switch to: an upstream error goes back to the engine as it came (it retries on its
      // own); a cool-down here would refuse the next requests with an error the engine never got from its provider
      // a gateway group keeps its own cool-downs: it has members to switch between
      if (!pool) this.states.reset(group.id, subId);
    }
  }

  private async readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) { this.sendError(res, 'anthropic', 413, tr('请求体过大')); return null; }
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** The split route's plain forwarding: the engine's request to `target`, the answer back as it comes (status, headers, bytes). */
  private async forward(req: http.IncomingMessage, res: http.ServerResponse, target: string, body: Buffer, auth: { bearer?: string; oauthBeta?: 'drop' | 'ensure' }, signal: AbortSignal) {
    let up: UpstreamResponse;
    // 隐私保护 on this route too (it goes straight to the main conversation's / the account's endpoint)
    if (this.deps.privacy && body.length) {
      try {
        const guard = this.deps.privacy.forRequest({ url: target, source: tr('子代理分流') });
        if (guard) {
          body = guard.body(body);
          guard.restore(res, false);
          guard.done();
        }
      } catch (e: any) {
        return this.sendError(res, 'anthropic', privacyErrorStatus(e), e?.message ?? String(e));
      }
    }
    try {
      // a non-streamed answer only sends its headers when it is done: as long as a long turn may take
      up = await sendUpstream(target, { method: req.method ?? 'GET', headers: forwardHeaders(req.rawHeaders, auth), body: body.length ? body : undefined, signal, headerTimeoutMs: SPLIT_FORWARD_MS });
    } catch (e) {
      if (signal.aborted) return;
      return this.sendError(res, 'anthropic', 502, (e as Error).message);
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !/^(connection|keep-alive|transfer-encoding|content-length)$/i.test(k)) headers[k] = v;
    res.writeHead(up.status, headers);
    up.body.pipe(res);
  }

  private serveModels(res: http.ServerResponse, g: GatewayGroup, inbound: GatewayProtocol, keyGroup?: GatewayKeyGroup) {
    const ids = new Set<string>();
    // a routing group offers its strategies, never its candidates' models (picking one there is not routing)
    if (g.routing) for (const p of ROUTING_POLICIES) ids.add(ROUTING_MODELS[p]);
    else {
    for (const k of Object.keys(g.modelMap ?? {})) if (!k.includes('*')) ids.add(k);
    // a concrete allowlist entry is a model this key is meant to use even when no member lists one
    for (const m of keyGroup?.modelAllowlist ?? []) if (!m.includes('*')) ids.add(m);
    for (const m of g.members) {
      if (m.model) ids.add(m.model);
      const p = m.providerId ? this.deps.meta.provider(m.providerId) : undefined;
      for (const x of p?.models ?? []) ids.add(x);
      if (p?.defaultModel) ids.add(p.defaultModel);
      // a single account / pool brings its models (a sidecar reports a family list; a provider account its own)
      const memberModels = this.deps.upstreams?.modelsForMember?.(m);
      if (memberModels) for (const x of memberModels) ids.add(x);
      else {
        if (m.accountId) {
          const a = this.deps.upstreams?.store.get(m.accountId);
          if (a) for (const x of this.deps.upstreams?.familyModels(a.kind) ?? []) ids.add(x);
        }
        if (m.upstreamGroupId) {
          for (const pool of this.deps.upstreams?.groups() ?? []) {
            if (pool.id !== m.upstreamGroupId) continue;
            for (const x of this.deps.upstreams?.familyModels(pool.kind) ?? []) ids.add(x);
          }
        }
      }
      // an account pool's models are also the ones it has mapped
      if (m.upstreamGroupId) {
        for (const pool of this.deps.upstreams?.groups() ?? []) {
          if (pool.id !== m.upstreamGroupId) continue;
          for (const k of Object.keys(pool.modelMap ?? {})) if (!k.includes('*')) ids.add(k);
        }
      }
    }
    }
    // a key group's model allow/deny applies to the list too: what it may not use is not offered
    const list = [...ids]
      .filter((id) => !keyGroup || modelAllowed(id, keyGroup.modelAllowlist, keyGroup.modelDeny))
      .sort();
    res.writeHead(200, { 'content-type': 'application/json' });
    // the catalog shapes are the compatibility layer's: Gemini's `models[]`, or one body both SDKs accept
    // (OpenAI's `object/list` plus Anthropic's `type/display_name/has_more`)
    if (inbound === 'gemini') { res.end(JSON.stringify(buildGeminiModelList(list))); return; }
    res.end(JSON.stringify(buildOpenAIModelList(list, { anthropic: true })));
  }

  /** Reasoning replay caches (memory only; replay-cache.ts). */
  private replay = new ReplayCaches();
  /** Responses-over-WebSocket sockets (ws-relay.ts). */
  private wsRelay = new ResponsesWsRelay();

  /** A conversation's replay namespace: its session key, scoped to the gateway key that sent it. */
  private replaySession(ctx: Ctx): string | undefined {
    const s = cacheKeyOf(ctx.json, ctx.req.headers);
    return s ? `${ctx.keyId ?? ''}\n${s}` : undefined;
  }

  /**
   * A pass-through body on its way to one member: reasoning the client dropped is put back, signatures
   * the member would refuse are cleaned (a cross-provider history is a 400 otherwise). Unchanged → the
   * client's exact bytes.
   */
  private reasoningBody(ctx: Ctx, body: Buffer, target: SigProvider): Buffer {
    const proto = ctx.route.inbound;
    if (proto !== 'anthropic' && proto !== 'responses' && proto !== 'gemini') return body;
    const s = body.toString('utf8');
    // cheap byte checks first: most requests carry nothing to restore or clean
    const relevant = proto === 'anthropic' ? s.includes('"thinking"') || s.includes('"redacted_thinking"') || s.includes('"signature"')
      : proto === 'responses' ? s.includes('"reasoning"') || (this.replay.reasoning.size > 0 && s.includes('"call_id"'))
        : /"thought_?[sS]ignature"|"functionCall"/.test(s);
    if (!relevant) return body;
    let j: any;
    try { j = JSON.parse(s); } catch { return body; }
    try {
      const out = prepareReasoning(proto, j, { target, session: this.replaySession(ctx), caches: this.replay });
      return out.changed ? Buffer.from(JSON.stringify(j)) : body;
    } catch (e) {
      console.error('[gateway reasoning]', e);
      return body;
    }
  }

  private irOf(ctx: Ctx): IrRequest {
    if (!ctx.ir) {
      ctx.ir = parseInbound(ctx.route.inbound, ctx.json, { stream: ctx.route.stream, model: ctx.model });
      ctx.ir.cacheKey = cacheKeyOf(ctx.json, ctx.req.headers);
      for (const t of ctx.ir.tools ?? []) if (t.custom) ctx.customTools.add(t.name);
    }
    return ctx.ir;
  }

  /**
   * A routing group's request (智能路由): plan who to try, run, then log the decision and tell the conversation which
   * model it really got. Any other group goes straight to `runMembers`.
   */
  private async run(ctx: Ctx) {
    if (!ctx.group.routing) return this.runMembers(ctx);
    let ir: IrRequest | null = null;
    try { ir = this.irOf(ctx); } catch { /* malformed: needs unknown, the member reports the error */ }
    const sessionId = String(ctx.req.headers['x-claude-code-session-id'] ?? '') || undefined;
    const g = ctx.group;
    ctx.plan = await this.router.planAsync({
      groupId: g.id, config: g.routing, model: ctx.model, ir, json: ctx.json, sessionId,
      sessionKey: cacheKeyOf(ctx.json, ctx.req.headers), look: this.routingLook(),
      unusable: (c, k) => this.routingUnusable(g.id, c, k), access: ctx.access,
    });
    try {
      await this.runMembers(ctx);
    } finally {
      // a token count is a side request: it decides nothing worth logging
      if (ctx.route.op !== 'count') {
        const info = this.router.finish(ctx.plan);
        if (info) this.emit('routed', info);
      }
    }
  }

  /** Try the group's members in order until one answers (or the failure is the request's own fault). */
  private async runMembers(ctx: Ctx) {
    const { group, route, res } = ctx;
    const inbound = route.inbound;
    const counting = route.op === 'count';
    const unsupported: string[] = [];
    // one member may expand into several targets (an account pool); the state table keys the ref, the model
    // is what the pool mapped it to
    const sessionKey = cacheKeyOf(ctx.json, ctx.req.headers);
    const order: ResolvedMember[] = [];
    // a routing group: its plan's candidates, each pinned to its model (the state key carries the model too)
    if (ctx.plan) for (const e of ctx.plan.order) {
      const c = e.c;
      const m: GatewayMember = c.accountId ? { accountId: c.accountId, model: c.model } : c.upstreamGroupId ? { upstreamGroupId: c.upstreamGroupId, model: c.model } : { providerId: c.providerId, model: c.model };
      const targets: GatewayTarget[] = this.deps.resolveMember
        ? await this.deps.resolveMember(m, c.model, sessionKey)
        : m.providerId && this.deps.member(m.providerId) ? [this.deps.member(m.providerId)!] : [];
      for (const t0 of targets) {
        const t: GatewayTarget = t0.type === 'claude-account' && !t0.auth ? { ...t0, auth: 'oauth', forceTranslate: true } : t0;
        order.push({ m, key: t.account ? `a:${t.id}` : e.key, target: t, model: t.model || c.model, route: e });
      }
    }
    else for (const m of this.states.order(group)) {
      const mapped = mapModel(group, m, ctx.model);
      const targets: GatewayTarget[] = this.deps.resolveMember
        ? await this.deps.resolveMember(m, mapped, sessionKey)
        : m.providerId && this.deps.member(m.providerId) ? [this.deps.member(m.providerId)!] : [];
      for (const t0 of targets) {
        // a Claude account profile (not a pool account) is a subscription login too: translate, never pass bytes
        const t: GatewayTarget = t0.type === 'claude-account' && !t0.auth ? { ...t0, auth: 'oauth', forceTranslate: true } : t0;
        order.push({ m, key: t.account ? `a:${t.id}` : memberKey(m), target: t, model: t.model || mapped });
      }
    }
    let tried = 0;
    let last: Attempt | null = null;
    let lastMember: { p: GatewayTarget; outbound: Outbound } | null = null;
    // a refusal before any attempt still gets an audit line
    const fail = (status: number, message: string, extra: Record<string, string> = {}) => {
      this.audit.write({
        ts: Date.now(), keyId: ctx.keyId ?? '', ip: ctx.ip ?? '', protocol: inbound,
        model: ctx.model, routeGroupId: group.id, member: '', status, ms: Date.now() - ctx.t0,
        tokensIn: 0, tokensOut: 0, errorCode: String(status), privacy: ctx.privacy, ...(ctx.plugins?.length ? { plugins: ctx.plugins } : {}),
      });
      return this.sendError(res, inbound, status, message, extra);
    };
    const estimate = () => {
      let n = 0;
      try { n = estimateTokens(this.irOf(ctx)); } catch { /* malformed: 0 */ }
      this.audit.write({
        ts: Date.now(), keyId: ctx.keyId ?? '', ip: ctx.ip ?? '', protocol: inbound,
        model: ctx.model, routeGroupId: group.id, member: '', status: 200, ms: Date.now() - ctx.t0,
        tokensIn: 0, tokensOut: 0, errorCode: '',
      });
      res.writeHead(200, { 'content-type': 'application/json', 'x-cw-estimated': '1' }).end(JSON.stringify(inbound === 'gemini' ? { totalTokens: n } : { input_tokens: n }));
    };
    for (const r of order) {
      const p = r.target;
      // a provider-login account may speak Responses while its Provider.type stays 'openai' for menus
      const outbound = p.protocol ?? outboundOf(p.type);
      if (!outbound) continue;
      // count_tokens is only forwarded where the wire can carry it as it is; a translated target (an account login
      // included) gets the local estimate instead of a real generation request
      if (counting ? (!isPassthrough(inbound, outbound) || !!p.forceTranslate) : !supported(inbound, outbound)) {
        unsupported.push(`${p.name}（${PROTOCOL_LABEL[outbound === 'openai' ? 'openai' : outbound]}）`);
        continue;
      }
      // an account's own concurrency cap: at it, this request goes to the next target
      const accountId = p.auth || p.account ? p.id : null;
      if (accountId && this.deps.upstreams && !this.deps.upstreams.acquire(accountId)) continue;
      tried++;
      lastMember = { p, outbound };
      let a: Attempt;
      try {
        a = await this.attempt(ctx, r, outbound, tried - 1);
      } finally {
        if (accountId) this.deps.upstreams?.release(accountId);
      }
      last = a;
      if (ctx.plan && r.route && !counting) {
        this.router.attempt(ctx.plan, r.route, { status: a.status, kind: a.kind, firstByteMs: a.kind === 'done' || a.kind === 'broken' ? a.firstByteMs : undefined, usage: a.kind === 'done' ? a.usage : null });
      }
      if (a.kind === 'switch') continue;
      if (counting) {
        this.audit.write({
          ts: Date.now(), keyId: ctx.keyId ?? '', ip: ctx.ip ?? '', protocol: inbound,
          model: a.model, routeGroupId: group.id, member: p.name, status: a.status, ms: Date.now() - ctx.t0,
          tokensIn: 0, tokensOut: 0, errorCode: a.kind === 'done' ? '' : String(a.status),
        });
      } else this.record(ctx, p, outbound, a, tried - 1);
      if (a.kind === 'final') {
        if (a.passthrough) res.writeHead(a.status, { ...errorHeaders(a.headers), 'content-type': String(a.headers['content-type'] ?? 'application/json') }).end(a.text);
        else this.sendError(res, inbound, a.status, upstreamErrorMessage(a.text), errorHeaders(a.headers));
      }
      return;
    }
    // nobody in the group speaks the client's protocol, or every member failed: a pre-flight count
    // gets an estimate rather than an error (and never changes any member's state)
    if (counting) return estimate();
    if (!tried) {
      if (ctx.plan && !ctx.plan.order.length) return fail(503, tr('智能路由没有可用的候选：{reason}', { reason: ctx.plan.decision.reason }));
      if (unsupported.length) return fail(400, tr('组「{name}」里没有能接 {v} 入口的成员：{unsupported} 需要的转换方向暂不支持', { name: group.name, v: PROTOCOL_LABEL[inbound], unsupported: unsupported.join('、') }));
      const next = this.states.nextAvailable(group);
      const wait = next ? Math.max(1, Math.ceil((next.at - Date.now()) / 1000)) : 0;
      if (next && next.at > Date.now()) return fail(next.rate ? 429 : 503, tr('组「{name}」的成员都在冷却中，约 {wait}s 后恢复', { name: group.name, wait }), { 'retry-after': String(wait) });
      const why = [...new Set(group.members.flatMap((m) => this.deps.upstreams?.whyMember?.(m) ?? []))];
      if (why.length) return fail(503, tr('组「{name}」现在用不了：{why}', { name: group.name, why: why.join('；') }));
      return fail(503, tr('组「{name}」没有可用成员（都已停用或档案缺失）', { name: group.name }));
    }
    // every member failed with a switchable error: report the last one as is
    if (last?.kind === 'switch') {
      if (lastMember) this.record(ctx, lastMember.p, lastMember.outbound, last, tried - 1);
      if (last.text !== undefined && last.passthrough) res.writeHead(last.status, { ...errorHeaders(last.headers), 'content-type': String(last.headers?.['content-type'] ?? 'application/json') }).end(last.text);
      else this.sendError(res, inbound, last.status, `${tried > 1 ? tr('组内 {tried} 个成员都失败了，最后一个：', { tried }) : ''}${last.message}`, errorHeaders(last.headers));
    }
  }

  private record(ctx: Ctx, p: GatewayTarget, outbound: Outbound, a: Attempt, switches: number) {
    const usage = a.kind === 'done' ? a.usage : null;
    const fb = a.kind === 'done' || a.kind === 'broken' || a.kind === 'aborted' ? a.firstByteMs : undefined;
    this.deps.ledger?.record({
      ts: Date.now(),
      sessionId: String(ctx.req.headers['x-claude-code-session-id'] ?? ''),
      model: a.model,
      durationMs: Date.now() - ctx.t0,
      apiMs: fb,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      costUsd: 0,
      costUnknown: true, // the gateway never knows a price
      ok: a.kind === 'done',
      error: a.kind === 'done' ? undefined : a.kind === 'final' ? `HTTP ${a.status} ${upstreamErrorMessage(a.text)}`.slice(0, 200) : a.message.slice(0, 200),
      providerId: p.id,
      kind: 'gateway',
      gateway: {
        group: ctx.group.name, inbound: ctx.route.inbound, member: p.name, memberId: p.id, outbound, upstreamStatus: a.status, switches, firstByteMs: fb, stream: ctx.route.stream,
        ...(ctx.plan ? { route: { policy: ctx.plan.decision.policy, reason: ctx.plan.decision.reason, chosen: ctx.plan.decision.chosen?.label, attempts: ctx.plan.decision.attempts.map((x) => `${x.label} ${x.outcome} ${x.status}`) } } : {}),
      },
    });
    const tokensIn = (usage?.input ?? 0) + (usage?.cacheRead ?? 0);
    const tokensOut = usage?.output ?? 0;
    // a routed paid answer is charged to the calling key (its own paid budget, routeAccess)
    if (ctx.keyId) this.keys.recordUsage(ctx.keyId, tokensIn, tokensOut, a.kind === 'done' ? ctx.plan?.spentUsd ?? 0 : 0);
    this.audit.write({
      ts: Date.now(),
      keyId: ctx.keyId ?? '',
      ip: ctx.ip ?? '',
      protocol: ctx.route.inbound,
      model: a.model,
      routeGroupId: ctx.group.id,
      member: p.name,
      status: a.status,
      ms: Date.now() - ctx.t0,
      tokensIn,
      tokensOut,
      errorCode: a.kind === 'done' ? '' : String(a.status),
      privacy: ctx.privacy,
      ...(ctx.plugins?.length ? { plugins: ctx.plugins } : {}),
    });
    if (p.auth || p.account) this.deps.upstreams?.noteUse(p.id, { input: tokensIn, output: tokensOut });
  }

  /** @see HEAVY_PROMPT_BYTES — one notice per conversation, re-armed after a compact brings it back down */
  private noteHeavyPrompt(ctx: Ctx, bytes: number, memberId: string): void {
    const sessionId = String(ctx.req.headers['x-claude-code-session-id'] ?? '');
    if (!sessionId || this.heavyNotified.has(sessionId)) return;
    this.heavyNotified.add(sessionId);
    this.emit('promptHeavy', { sessionId, bytes, via: memberId.replace(/^sidecar:/, '') });
  }

  private async attempt(ctx: Ctx, r: ResolvedMember, outbound: Outbound, switches: number): Promise<Attempt> {
    const { group, route } = ctx;
    const p = r.target;
    const key = r.key;
    // count_tokens is a side request: its failures say nothing about the member's ability to answer
    const track = route.op !== 'count';
    // an account login needs Claude Code's request shape, so it never passes bytes through
    const pass = !p.forceTranslate && isPassthrough(route.inbound, outbound);
    const model = r.model;
    const base = p.baseUrl?.trim() || DEFAULT_BASE[p.type];
    let path: string;
    let body: Buffer;
    let headers: Record<string, string>;
    // translated requests carry prompt caching the client could not have put there (cache.ts)
    let retryBody: Buffer | null = null; // the same request without prompt_cache_key, for an upstream that rejects it
    let noThinkingBody: Buffer | null = null; // the same request with thinking off, for a model that refuses a forced tool call
    let noEffortBody: Buffer | null = null; // the same request without the strength parameter, for a model that refuses it
    let bareBody: Buffer | null = null; // without the strength parameter and without prompt_cache_key
    let errText: string | undefined; // an error body already read
    try {
      if (pass) {
        if (route.inbound === 'gemini') {
          path = `/v1beta/models/${encodeURIComponent(model)}:${route.action}${ctx.search}`;
          body = ctx.raw;
        } else {
          path = ctx.path + ctx.search;
          // only the top-level "model" bytes change; the rest is exactly what the client sent
          body = model === ctx.model ? ctx.raw : Buffer.from(replaceTopLevelString(ctx.raw.toString('utf8'), 'model', model) ?? JSON.stringify({ ...ctx.json, model }));
        }
        // reasoning the client dropped comes back, signatures this member would refuse go (signature.ts)
        body = this.reasoningBody(ctx, body, signatureTargetOf(p, model));
        // Codex's ChatGPT backend serves /responses, Copilot serves /chat/completions: the vendor's path wins
        if (p.chatPath) path = (ctx.path.endsWith('/compact') ? `${p.chatPath}/compact` : p.chatPath) + ctx.search;
        headers = passthroughHeaders(ctx.req.rawHeaders, outbound, p.apiKey);
      } else {
        const ir = { ...this.irOf(ctx), model, stream: route.stream };
        // thinking strength: only for a member model that takes it natively, at the nearest level it has
        const caps = modelCaps(p, model);
        const effortKey = `${p.id} ${model}`;
        ir.effort = ir.effort && caps.native && !this.effortRefused.has(effortKey) ? nearestLevel(ir.effort, caps.levels) : undefined;
        const opts: OutboundOpts = outbound === 'anthropic'
          ? { cacheTtl: group.cache1h || p.cache1h ? '1h' : undefined, systemPrefix: p.auth === 'oauth' ? CLAUDE_CODE_SYSTEM_PREFIX : undefined }
          : outbound === 'openai' ? { promptCacheKey: !p.noPromptCacheKey, cacheControl: p.cacheControlFormat === 'anthropic' }
            : outbound === 'responses' ? { cacheKey: ir.cacheKey } : {};
        const out = buildOutbound(outbound, ir, opts);
        path = p.chatPath ?? out.path;
        body = Buffer.from(JSON.stringify(out.body));
        headers = translatedHeaders(outbound, p.apiKey, route.stream, String(ctx.req.headers['user-agent'] ?? ''), p.authStyle);
        if (p.auth === 'oauth' && outbound === 'anthropic') {
          // a subscription login: Bearer + oauth beta, never x-api-key
          delete headers['x-api-key'];
          headers.authorization = `Bearer ${p.apiKey}`;
          headers['anthropic-beta'] = OAUTH_BETA;
        }
        if (outbound === 'openai' && ir.cacheKey) {
          addMissing(headers, affinityHeaders(ir.cacheKey.slice(0, CACHE_KEY_MAX), p.type === 'grok'));
          if (out.body.prompt_cache_key) retryBody = Buffer.from(JSON.stringify(buildOutbound(outbound, ir, { ...opts, promptCacheKey: false }).body));
        }
        if (ir.effort) {
          const plain = buildOutbound(outbound, { ...ir, effort: undefined }, opts).body;
          if (JSON.stringify(plain) !== JSON.stringify(out.body)) noEffortBody = Buffer.from(JSON.stringify(plain));
          // a strict upstream naming both extra fields in one 400: the single retry drops both
          if (noEffortBody && retryBody) bareBody = Buffer.from(JSON.stringify(buildOutbound(outbound, { ...ir, effort: undefined }, { ...opts, promptCacheKey: false }).body));
        }
        // a forced tool call (自动判断's safety check): a thinking model that refuses it gets it with thinking off
        if (outbound === 'openai' && forcesTool(out.body) && out.body.thinking?.type !== 'disabled') {
          const s = thinkingOff(body.toString('utf8'));
          if (s) noThinkingBody = Buffer.from(s);
        }
        // A sidecar re-sends the whole prompt every turn and has no prompt cache: once it passes the inline
        // limit (Gemini web: 128 KB) it uploads an attachment, and past ~160 KB the upstream truncates the tail.
        // Tell the conversation once, so it can compact instead of quietly degrading.
        if (p.id.startsWith('sidecar:') && body.length > HEAVY_PROMPT_BYTES) this.noteHeavyPrompt(ctx, body.length, p.id);
        else if (p.id.startsWith('sidecar:')) this.heavyNotified.delete(String(ctx.req.headers['x-claude-code-session-id'] ?? ''));
      }
    } catch (e: any) {
      return { kind: 'final', status: 400, text: JSON.stringify(renderInboundError(route.inbound, 400, tr('请求转换失败：{message}', { message: e?.message ?? e }))), headers: {}, passthrough: true, model };
    }
    // a provider account's vendor headers (Copilot's editor identity, Codex's originator); never the credential
    applyExtraHeaders(headers, p.headers);
    // 隐私保护 (privacy/): every body this attempt may send leaves redacted (the same placeholders in each variant), the
    // answer comes back restored. A block rule, or the pipeline failing while it is on, refuses the request — never sent raw.
    let guard: PrivacyGuard | null = null;
    try {
      guard = this.deps.privacy?.forRequest({ url: base, source: p.name, cloud: p.id.startsWith('sidecar:') }) ?? null;
      if (guard) {
        await guard.prepare(body); // the optional local model (privacy/model): async, before the sync redaction
        body = guard.body(body);
        retryBody = guard.variant(retryBody);
        noThinkingBody = guard.variant(noThinkingBody);
        noEffortBody = guard.variant(noEffortBody);
        bareBody = guard.variant(bareBody);
        if (guard.redacted) {
          // a compressed answer could not be restored on the fly: ask for it plain (decoded anyway if it still comes compressed)
          if (pass) { for (const k of Object.keys(headers)) if (k.toLowerCase() === 'accept-encoding') delete headers[k]; headers['accept-encoding'] = 'identity'; }
          guard.restore(ctx.res, route.stream);
        }
        const rec = guard.done();
        if (rec) ctx.privacy = rec;
      }
    } catch (e: any) {
      const blocked = e instanceof PrivacyBlocked;
      const rec = guard?.done(blocked);
      if (rec) ctx.privacy = rec;
      const status = blocked ? 403 : 503;
      return { kind: 'final', status, text: JSON.stringify(renderInboundError(route.inbound, status, e?.message ?? String(e))), headers: {}, passthrough: true, model };
    }
    // 插件 (plugins/): request-before runs after the redaction above, so a plugin only ever sees placeholders. Nothing
    // is called (and no byte changes) when no enabled plugin declares the hook.
    const hookMeta = { source: p.name, model, path };
    const plugins = route.op === 'generate' ? this.plugins : null;
    if (plugins?.hasHook('request-before')) {
      const skipped = (ctx.plugins ??= []);
      body = (await pluginBody(plugins, 'request-before', hookMeta, body, skipped)) ?? body;
      retryBody = await pluginBody(plugins, 'request-before', hookMeta, retryBody, skipped);
      noThinkingBody = await pluginBody(plugins, 'request-before', hookMeta, noThinkingBody, skipped);
      noEffortBody = await pluginBody(plugins, 'request-before', hookMeta, noEffortBody, skipped);
      bareBody = await pluginBody(plugins, 'request-before', hookMeta, bareBody, skipped);
    }
    // response-after sees a whole (non-streamed) answer: ask for it uncompressed so it can be read
    const afterHook = !!plugins?.hasHook('response-after') && !route.stream;
    if (afterHook && pass) { for (const k of Object.keys(headers)) if (k.toLowerCase() === 'accept-encoding') delete headers[k]; headers['accept-encoding'] = 'identity'; }
    const url = joinUrl(base, path);
    const sent = Date.now();
    // streaming: the first byte must come quickly; non-streaming: nothing arrives until the whole answer is done.
    // A sidecar needs longer: it uploads an oversized prompt as an attachment before it generates anything.
    const waitMs = route.stream
      ? (p.id.startsWith('sidecar:') ? SIDECAR_FIRST_BYTE_MS : this.firstByteMs)
      : this.nonStreamMs;
    const deadline = sent + waitMs;
    const aborted = (firstByteMs?: number): Attempt => ({ kind: 'aborted', status: 499, message: tr('客户端已断开'), firstByteMs, model });
    const switchOn = (status: number, message: string): Attempt => {
      if (track) { this.states.fail(group.id, key, { action: 'switch', kind: 'transient' }, status, message, Date.now(), sent); this.emit('changed'); }
      if (track && (p.auth || p.account)) void this.deps.upstreams?.markFailure(p.id, 'error', message);
      return { kind: 'switch', status, message: `${p.name}：${message}`, passthrough: pass, model };
    };
    // 客户端指纹 (fingerprint/): opt-in per source (gateway.fingerprint) — the official CLI's headers / key order / TLS; off = no change
    const fp = clientFingerprint(this.deps.meta.settings(), p, { outbound, path, stream: route.stream });
    if (fp) [headers, body, retryBody, noThinkingBody, noEffortBody, bareBody] = [fp.headers(headers), fp.body(body), fp.body(retryBody), fp.body(noThinkingBody), fp.body(noEffortBody), fp.body(bareBody)];
    const agentFor = fp ? fp.agentFor(p.proxy) : p.proxy ? () => accountProxyAgent(p.proxy!) : undefined;
    let up: UpstreamResponse;
    try {
      up = await sendUpstream(url, { method: 'POST', headers, body, signal: ctx.signal, headerTimeoutMs: waitMs, agentFor });
      // an upstream that may not know prompt_cache_key: this request once more without it; the profile only
      // remembers when the error named the field (a retry that happens to work proves nothing about the key)
      if ((retryBody || noThinkingBody || noEffortBody) && isParamRejection(up.status)) {
        let text = '';
        try { text = await readText(up.body, 1024 * 1024); } catch { /* keep empty */ }
        if (noThinkingBody && refusesForcedTool(text)) {
          up = await sendUpstream(url, { method: 'POST', headers, body: noThinkingBody, signal: ctx.signal, headerTimeoutMs: waitMs, agentFor });
        } else if (noEffortBody && mentionsEffort(text)) {
          // remembered for this member and model until the server restarts; the client never sees the failure. The
          // one retry also leaves out prompt_cache_key (a strict upstream may name only the first field it disliked);
          // the profile drops the key for good only when the error named it.
          this.effortRefused.add(`${p.id} ${model}`);
          if (bareBody && mentionsCacheKey(text)) void this.deps.meta.upsertProvider({ id: p.id, noPromptCacheKey: true }, { mustExist: true }).catch(() => { /* next request tries again */ });
          up = await sendUpstream(url, { method: 'POST', headers, body: bareBody ?? noEffortBody, signal: ctx.signal, headerTimeoutMs: waitMs, agentFor });
        } else if (retryBody) {
          if (mentionsCacheKey(text)) void this.deps.meta.upsertProvider({ id: p.id, noPromptCacheKey: true }, { mustExist: true }).catch(() => { /* next request tries again */ });
          up = await sendUpstream(url, { method: 'POST', headers, body: retryBody, signal: ctx.signal, headerTimeoutMs: waitMs, agentFor });
        } else {
          errText = text;
        }
      }
    } catch (e: any) {
      if (ctx.signal.aborted) return aborted();
      return switchOn(e instanceof UpstreamError && e.timeout ? 504 : 502, e?.message ?? String(e));
    }
    // 智能路由 / 来源健康: the answer's rate-limit headers and 429s (routing/quota.ts)
    if (track) observeUpstream(p, up.status, up.headers);
    if (up.status < 200 || up.status >= 300) {
      let text = errText ?? '';
      if (errText === undefined) { try { text = await readText(up.body, 4 * 1024 * 1024); } catch { /* keep empty */ } }
      // an upstream error may quote the request: secrets masked before it reaches a log, the ledger or the client
      if (this.deps.privacy) text = this.deps.privacy.scrub(text);
      if (ctx.signal.aborted) return aborted();
      const st = this.states.get(group.id, key);
      const v = classify(up.status, up.headers, text, st.strikes);
      const msg = `HTTP ${up.status} ${upstreamErrorMessage(text)}`.trim();
      if (track) {
        this.states.fail(group.id, key, v, up.status, v.action === 'switch' && v.kind === 'auth' ? tr('{msg}（鉴权失败，已停用，检查密钥后点「恢复」）', { msg }) : msg, Date.now(), sent);
        this.emit('changed');
      }
      if (track && (p.auth || p.account)) {
        // the account row follows the member state: expired login, cooling quota, or a plain error
        void this.deps.upstreams?.markFailure(
          p.id,
          v.action === 'switch' && v.kind === 'auth' ? 'expired' : v.action === 'switch' && v.kind === 'rate' ? 'cooling' : 'error',
          msg,
          v.action === 'switch' && v.kind === 'rate' ? Date.now() + v.cooldownMs : undefined,
        );
      }
      if (v.action === 'final') return { kind: 'final', status: up.status, text, headers: up.headers, passthrough: pass, model };
      return { kind: 'switch', status: up.status, message: `${p.name}：${msg}`, text, headers: up.headers, passthrough: pass, model };
    }

    // 2xx: hold the client until the first body byte arrives, so a member that stalls can still be skipped
    const src = pass ? up.body : decoded(up.body);
    let it = src[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let first: IteratorResult<Buffer>;
    try {
      first = await withTimeout(it.next(), deadline - Date.now());
    } catch (e: any) {
      up.body.destroy();
      if (ctx.signal.aborted) return aborted();
      return switchOn(504, e?.message === 'timeout' ? tr('{waitMs}s 内没有返回内容', { waitMs: Math.round(waitMs / 1000) }) : e?.message ?? String(e));
    }
    // 插件 response-after: the whole answer, before 隐私保护 restores it (the restore wraps ctx.res), so a plugin
    // sees placeholders, not the values. A compressed passthrough answer is left alone.
    if (afterHook && !first.done && (!pass || /^(identity)?$/i.test(String(up.headers['content-encoding'] ?? '')))) {
      try {
        const bufs: Buffer[] = [first.value];
        for (let r = await withTimeout(it.next(), IDLE_MS); !r.done; r = await withTimeout(it.next(), IDLE_MS)) bufs.push(r.value);
        const whole = Buffer.concat(bufs);
        const changed = await pluginBody(plugins!, 'response-after', hookMeta, whole, (ctx.plugins ??= []));
        first = { done: false, value: changed ?? whole };
      } catch (e: any) {
        up.body.destroy();
        if (ctx.signal.aborted) return aborted();
        return switchOn(502, e?.message ?? String(e));
      }
      const done: IteratorResult<Buffer> = { done: true, value: undefined };
      it = { next: async () => done } as AsyncIterator<Buffer>;
    }
    const firstByteMs = Date.now() - sent;
    if (track && this.states.ok(group.id, key, Date.now(), sent)) this.emit('changed'); // recovered / first success — not on every request
    if (track && (p.auth || p.account)) void this.deps.upstreams?.markSuccess(p.id);

    const memberHeader = {
      'x-cw-gateway-member': encodeURIComponent(p.name),
      'x-cw-gateway-switches': String(switches),
      ...(p.degraded ? { 'x-cw-degraded': '1' } : {}),
    };
    try {
      if (pass) return await this.pipePassthrough(ctx, up, it, first, memberHeader, firstByteMs, model);
      return await this.pipeTranslated(ctx, up, it, first, outbound, memberHeader, firstByteMs, model);
    } catch (e: any) {
      up.body.destroy();
      // the client hanging up mid-answer is not the member's fault: no cooldown
      if (ctx.signal.aborted) return aborted(firstByteMs);
      if (!ctx.res.headersSent) return switchOn(502, e?.message ?? String(e));
      ctx.res.destroy();
      return { kind: 'broken', status: 502, message: e?.message ?? String(e), firstByteMs, model };
    }
  }

  /** Same protocol: status, headers and raw bytes straight through; usage is sniffed from a decoded copy. */
  private async pipePassthrough(ctx: Ctx, up: UpstreamResponse, it: AsyncIterator<Buffer>, first: IteratorResult<Buffer>, extra: Record<string, string>, firstByteMs: number, model: string): Promise<Attempt> {
    const { res } = ctx;
    const isSse = /event-stream/i.test(String(up.headers['content-type'] ?? ''));
    res.writeHead(up.status, { ...responseHeaders(up.headers), ...extra });
    // the answer's signed reasoning is remembered for a client that drops it next turn (replay-cache.ts)
    const rec = up.status >= 200 && up.status < 300 ? this.replay.recorder(ctx.route.inbound, this.replaySession(ctx)) : null;
    const sniff = new UsageSniffer(ctx.route.inbound, isSse, String(up.headers['content-encoding'] ?? ''), rec ? (j) => rec.feed(j) : undefined);
    let r = first;
    let broken = '';
    while (!r.done && !ctx.signal.aborted) {
      sniff.push(r.value);
      if (!res.write(r.value)) await waitDrain(res, ctx.signal);
      if (ctx.signal.aborted) break;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? tr('上游超过 5 分钟没有数据') : e?.message ?? String(e); up.body.destroy(); break; }
    }
    if (ctx.signal.aborted) { up.body.destroy(); res.destroy(); sniff.abort(); return { kind: 'aborted', status: 499, message: tr('客户端已断开'), firstByteMs, model }; }
    res.end();
    const usage = await sniff.end();
    if (broken) return { kind: 'broken', status: 502, message: broken, firstByteMs, model };
    rec?.finish();
    return { kind: 'done', status: up.status, usage, firstByteMs, model };
  }

  /** Cross protocol: parse the member's response (or SSE) into IR and render it in the client's protocol. */
  private async pipeTranslated(ctx: Ctx, up: UpstreamResponse, it: AsyncIterator<Buffer>, first: IteratorResult<Buffer>, outbound: Outbound, extra: Record<string, string>, firstByteMs: number, model: string): Promise<Attempt> {
    const { res, route } = ctx;
    const clientModel = ctx.model || model;
    if (!route.stream) {
      const bufs: Buffer[] = [];
      let r = first;
      while (!r.done) { bufs.push(r.value); r = await withTimeout(it.next(), IDLE_MS); }
      const text = Buffer.concat(bufs).toString('utf8');
      let j: any;
      try { j = JSON.parse(text); } catch { throw new Error(tr('上游返回的不是 JSON：{text}', { text: text.slice(0, 120) })); }
      const ir = parseOutboundResponse(outbound, j, model);
      if (ctx.signal.aborted) return { kind: 'aborted', status: 499, message: tr('客户端已断开'), firstByteMs, model };
      res.writeHead(200, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(renderInboundResponse(route.inbound, ir, clientModel, ctx.customTools)));
      return { kind: 'done', status: up.status, usage: ir.usage, firstByteMs, model };
    }
    const parser = outboundStreamParser(outbound, model);
    const renderer = inboundStreamRenderer(route.inbound, clientModel, { includeUsage: !!ctx.json?.stream_options?.include_usage, customTools: ctx.customTools });
    const usage: IrUsage = { input: 0, output: 0 };
    const sse = new SseParser();
    const dec = new StringDecoder('utf8');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
    const emit = async (evs: IrEvent[]) => {
      if (ctx.signal.aborted) return; // nobody to write to: never wait for a drain that cannot come
      let out = '';
      for (const e of evs) { if (e.t === 'usage') Object.assign(usage, e.usage); out += renderer.push(e); }
      if (out && !res.write(out)) await waitDrain(res, ctx.signal);
    };
    let r = first;
    let broken = '';
    while (!r.done && !ctx.signal.aborted) {
      for (const ev of sse.feed(dec.write(r.value))) await emit(parser.feed(ev));
      if (ctx.signal.aborted) break;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? tr('上游超过 5 分钟没有数据') : e?.message ?? String(e); up.body.destroy(); break; }
    }
    if (ctx.signal.aborted) { up.body.destroy(); res.destroy(); return { kind: 'aborted', status: 499, message: tr('客户端已断开'), firstByteMs, model }; }
    if (broken) await emit([{ t: 'error', message: broken }]);
    else { for (const ev of sse.feed(dec.end())) await emit(parser.feed(ev)); for (const ev of sse.end()) await emit(parser.feed(ev)); await emit(parser.end()); }
    const tail = renderer.end();
    res.end(tail || undefined);
    if (broken) return { kind: 'broken', status: 502, message: broken, firstByteMs, model };
    return { kind: 'done', status: up.status, usage, firstByteMs, model };
  }

  /** Minimal request through our own endpoint, the way an agent would send it. */
  async test(groupId: string, protocol: GatewayProtocol = 'anthropic'): Promise<GatewayTestResult> {
    const g = this.group(groupId);
    if (!g) return { ok: false, status: 0, ms: 0, error: tr('组不存在') };
    if (!this.enabled()) return { ok: false, status: 0, ms: 0, error: tr('网关未启用') };
    const m0 = g.members[0];
    const p0 = m0?.providerId ? this.deps.meta.provider(m0.providerId) : undefined;
    const model = m0?.model || p0?.defaultModel || p0?.models?.find((x) => /haiku|mini|flash/i.test(x)) || p0?.models?.[0] || 'claude-haiku-4-5';
    const prompt = 'Reply with exactly: ok';
    const t0 = Date.now();
    const base = `http://127.0.0.1:${this.port}/gateway/${encodeURIComponent(groupId)}`;
    const reqs: Record<GatewayProtocol, { url: string; body: any; headers: Record<string, string> }> = {
      anthropic: { url: `${base}/v1/messages`, body: { model, max_tokens: 16, messages: [{ role: 'user', content: prompt }] }, headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' } },
      openai: { url: `${base}/v1/chat/completions`, body: { model, max_tokens: 16, messages: [{ role: 'user', content: prompt }] }, headers: { authorization: `Bearer ${this.key}` } },
      responses: { url: `${base}/v1/responses`, body: { model, max_output_tokens: 16, input: prompt }, headers: { authorization: `Bearer ${this.key}` } },
      gemini: { url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 } }, headers: { 'x-goog-api-key': this.key } },
    };
    const r0 = reqs[protocol];
    try {
      const r = await fetch(r0.url, { method: 'POST', headers: { 'content-type': 'application/json', ...r0.headers }, body: JSON.stringify(r0.body), signal: AbortSignal.timeout(FIRST_BYTE_MS * 2) });
      const text = await r.text();
      const member = r.headers.get('x-cw-gateway-member');
      const out: GatewayTestResult = { ok: r.ok, status: r.status, ms: Date.now() - t0, member: member ? decodeURIComponent(member) : undefined, switches: Number(r.headers.get('x-cw-gateway-switches') ?? 0) };
      if (g.members.some((m) => m.providerId && this.deps.meta.provider(m.providerId)?.type === 'anthropic')) out.note = tr('测试请求不带 Claude Code 指纹（系统提示 / UA），只认官方客户端的中转可能拒绝这条测试，但真实的 Claude 对话经网关透传能通过。');
      let j: any = null;
      try { j = JSON.parse(text); } catch { /* not json */ }
      if (r.ok) out.text = (j?.content?.[0]?.text ?? j?.choices?.[0]?.message?.content ?? j?.output?.[0]?.content?.[0]?.text ?? j?.candidates?.[0]?.content?.parts?.[0]?.text ?? text).toString().slice(0, 200);
      else out.error = upstreamErrorMessage(text);
      return out;
    } catch (e: any) {
      return { ok: false, status: 0, ms: Date.now() - t0, error: e?.message ?? String(e) };
    }
  }
}

/** Reads usage out of a passthrough body (SSE or JSON, possibly compressed) without delaying the bytes. */
class UsageSniffer {
  private usage: Partial<IrUsage> = {};
  private seen = false;
  private sse = new SseParser();
  private dec = new StringDecoder('utf8');
  private json = '';
  private z: import('node:stream').Transform | null = null;
  private zDone: Promise<void> | null = null;
  private off = false; // an encoding we cannot decode: no usage, bytes still pass through
  constructor(private protocol: GatewayProtocol, private isSse: boolean, encoding: string, private tap?: (j: any) => void) {
    const enc = encoding.toLowerCase().trim();
    if (enc && enc !== 'identity') {
      this.z = decoder(enc);
      if (!this.z) this.off = true;
      else {
        this.z.on('data', (c: Buffer) => this.text(this.dec.write(c)));
        this.zDone = new Promise((r) => { this.z!.on('end', () => r()); this.z!.on('error', () => r()); });
      }
    }
  }
  push(b: Buffer) {
    if (this.off) return;
    if (this.z) this.z.write(b);
    else this.text(this.dec.write(b));
  }
  private text(s: string) {
    if (!s) return;
    if (this.isSse) for (const e of this.sse.feed(s)) this.event(e.data);
    else if (this.json.length < 8 * 1024 * 1024) this.json += s;
  }
  private event(data: string) {
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    this.tap?.(j);
    const u = sniffUsage(this.protocol, j);
    if (u) { Object.assign(this.usage, Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined))); this.seen = true; }
  }
  /** Client went away: drop the decompressor without waiting for it. */
  abort() { this.off = true; this.z?.destroy(); }
  async end(): Promise<IrUsage | null> {
    if (this.off) return null;
    if (this.z) { this.z.end(); await this.zDone; }
    this.text(this.dec.end());
    if (this.isSse) for (const e of this.sse.end()) this.event(e.data);
    else if (this.json) this.event(this.json);
    return this.seen ? { input: 0, output: 0, ...this.usage } : null;
  }
}

