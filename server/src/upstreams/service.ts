// 账号池: the accounts of every upstream family, the pools they are grouped into, how a request picks one, and
// what the gateway needs to send to it. Credential envelopes and health are the store's / adapter's business.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MetaStore } from '../meta/store.js';
import type { SecretService } from '../secrets/service.js';
import type { GatewayMember, GatewayTarget } from '../gateway/types.js';
import { AccountStore, normalizeCredential } from './store.js';
import { AffinityTable } from './affinity.js';
import { ClaudeAdapter, claudeToken } from './claude.js';
import { SidecarManager } from './sidecar.js';
import { GeminiAdapter } from './gemini.js';
import { WorkBuddyAdapter } from './workbuddy.js';
import { maskProxyUrl, normalizeAccountProxy } from './proxy.js';
import { probeExit, startExitTunnel, type ExitTunnel } from './exit-tunnel.js';
import { ProviderLoginService, refreshProviderCredential, type ProviderLoginBegin } from './provider-login.js';
import type { SidecarDriver, SidecarReadOptions } from './drivers.js';
import type {
  LoginTunnel,
  MaintenanceKind,
  SidecarAccount,
  SidecarGuard,
  SidecarId,
  SidecarProxy,
  SidecarProxyInput,
  SidecarProxyPatch,
  SidecarStatus,
  TaskResult,
  UpstreamAccount,
  UpstreamAccountInput,
  UpstreamAccountPatch,
  UpstreamAccountView,
  UpstreamGroup,
  UpstreamKind,
  UpstreamStatus,
} from './types.js';
import { tr } from '../i18n/index.js';

export interface UpstreamDeps {
  meta: MetaStore;
  secrets: SecretService;
  claude?: ClaudeAdapter;
  /** the sidecar processes (Gemini web / WorkBuddy); tests pass fakes */
  sidecars?: SidecarManager;
  gemini?: SidecarDriver;
  workbuddy?: SidecarDriver;
  /** where a Claude login's requests go (tests point it at a fake) */
  claudeBase?: string;
  /** fetch used by provider logins / provider probes (tests pass a fake; never real in unit tests) */
  providerFetch?: typeof fetch;
  /** where local-credential readers look (tests pass a temp home) */
  home?: string;
  now?: () => number;
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** How long a sidecar's model list is trusted. It is per-login (anonymous answers two models, a subscription many). */
const MODELS_TTL_MS = 5 * 60_000;

/**
 * A model a family lists under a region prefix (WorkBuddy: `global:x`, `cn:x`) asked for by its bare name: the listed
 * id, global first; undefined when the family doesn't have it under any prefix.
 */
export function familyIdFor(model: string, known: string[]): string | undefined {
  const bare = model.toLowerCase();
  const hits = known.filter((k) => { const i = k.indexOf(':'); return i > 0 && k.slice(i + 1).toLowerCase() === bare; });
  return hits.find((k) => k.startsWith('global:')) ?? hits[0];
}

export class UpstreamService extends EventEmitter {
  /** set by the server: a gateway group may have just been created (the gateway mirrors each group as a profile) */
  onGatewayGroups: (() => void) | null = null;
  readonly store: AccountStore;
  readonly affinity = new AffinityTable();
  readonly sidecars: SidecarManager;
  readonly logins: ProviderLoginService;
  private providerFetch: typeof fetch;
  private claude: ClaudeAdapter;
  private gemini: SidecarDriver;
  private workbuddy: SidecarDriver;
  private now: () => number;
  private cursor = new Map<string, number>();
  /** what each sidecar family last said its models are (for /v1/models) */
  private familyModelsCache = new Map<UpstreamKind, string[]>();
  /** families with a lazy model pull in flight, and when one last ran (an empty answer must not re-pull per call) */
  private modelsLoading = new Set<UpstreamKind>();
  private modelsTried = new Map<UpstreamKind, number>();
  /** when each family's model list was last pulled (the list depends on which login the sidecar has) */
  private familyModelsAt = new Map<UpstreamKind, number>();
  /** one sync per family at a time: two OAuth polls must not both add the same remote account */
  private syncing = new Map<SidecarId, Promise<UpstreamAccountView[]>>();
  /** in-flight requests per account (maxConcurrent) */
  private live = new Map<string, number>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private deps: UpstreamDeps) {
    super();
    this.store = new AccountStore(deps.meta, deps.secrets);
    this.now = deps.now ?? Date.now;
    this.claude = deps.claude ?? new ClaudeAdapter({ baseUrl: deps.claudeBase ?? process.env.CW_CLAUDE_BASE });
    this.sidecars = deps.sidecars ?? new SidecarManager();
    this.gemini = deps.gemini ?? new GeminiAdapter(this.sidecars);
    this.workbuddy = deps.workbuddy ?? new WorkBuddyAdapter(this.sidecars);
    this.providerFetch = deps.providerFetch ?? fetch;
    this.logins = new ProviderLoginService({
      accounts: { add: (input) => this.add(input) },
      fetch: this.providerFetch,
      home: deps.home,
      now: deps.now,
    });
    this.sidecars.on('changed', () => this.emit('changed'));
    this.sidecars.on('crash', (id: SidecarId, detail: string) => this.emit('crash', id, detail));
  }

  status(): UpstreamStatus {
    const sidecar = new Map(this.sidecars.statuses().map((s) => [s.id, s]));
    const accounts = this.store.list();
    const warnings: string[] = [];
    for (const kind of ['gemini', 'workbuddy'] as const) {
      const list = accounts.filter((a) => a.kind === kind);
      if (!list.length) continue;
      const healthy = list.filter((a) => a.health === 'ok' && a.enabled).length;
      if (!healthy) warnings.push(tr('{family} 账号没有一个是正常的，检查登录或出口', { family: kind === 'gemini' ? tr('Gemini') : tr('WorkBuddy') }));
      const relogin = list.filter((a) => a.autoDisabledAt).length;
      if (relogin) warnings.push(tr('{family} 有 {n} 个账号的登录过期了，点「重新登录」', { family: kind === 'gemini' ? tr('Gemini') : tr('WorkBuddy'), n: relogin }));
      const stopped = list.filter((a) => (!a.enabled || a.health === 'disabled') && !a.autoDisabledAt).length;
      if (stopped) warnings.push(tr('{family} 有 {n} 个账号已停用', { family: kind === 'gemini' ? tr('Gemini') : tr('WorkBuddy'), n: stopped }));
    }
    return {
      accounts: accounts.map((a) => this.view(a)),
      groups: this.groups(),
      families: [
        { kind: 'claude', ready: true },
        this.familyLine('gemini', sidecar.get('gemini')),
        this.familyLine('workbuddy', sidecar.get('workbuddy')),
      ],
      logins: this.logins.providers(),
      sidecars: [...sidecar.values()],
      warnings,
    };
  }

  private familyLine(kind: UpstreamKind, s?: SidecarStatus): UpstreamStatus['families'][number] {
    if (!s) return { kind, ready: false, detail: tr('组件还没有准备好') };
    if (s.running && s.health === 'ok') return { kind, ready: true, detail: tr('组件运行中（端口 {port}）', { port: String(s.port ?? '') }) };
    if (s.installed) return { kind, ready: true, detail: tr('组件已安装，当前未运行') };
    return { kind, ready: false, detail: tr('需要下载组件才能使用') };
  }

  private driver(kind: UpstreamKind): SidecarDriver | null {
    if (kind === 'gemini') return this.gemini;
    if (kind === 'workbuddy') return this.workbuddy;
    return null;
  }

  private view(a: UpstreamAccount): UpstreamAccountView {
    const { credential: _credential, proxy, fingerprint: _fingerprint, ...rest } = a;
    return { ...rest, credentialMasked: `${a.credentialKind} · ••••`, hasProxy: !!proxy };
  }

  async add(input: UpstreamAccountInput): Promise<{ account: UpstreamAccountView; duplicate: boolean; id: string }> {
    if (input.kind === 'provider') return this.addProvider(input);
    if (input.kind !== 'claude') return this.addSidecar(input);
    const { account, duplicate } = await this.store.add(input);
    if (!duplicate && input.probe !== false) await this.probe(account.id);
    await this.ensureDefaultGroup(account.id);
    this.emit('changed');
    return { account: this.view(this.store.get(account.id)!), duplicate, id: account.id };
  }

  /** A generic provider login (codex / copilot / an imported OpenCode entry): local credential, gateway target. */
  private async addProvider(input: UpstreamAccountInput): Promise<{ account: UpstreamAccountView; duplicate: boolean; id: string }> {
    if (!input.providerId?.trim()) throw new Error(tr('第三方登录账号缺少 providerId'));
    if (input.proxy && !normalizeAccountProxy(input.proxy)) throw new Error(tr('代理地址需要 http(s):// 或 socks5://'));
    const { account, duplicate } = await this.store.add({ ...input, probe: false });
    if (!duplicate && input.probe !== false) await this.probe(account.id);
    await this.ensureDefaultGroup(account.id);
    this.emit('changed');
    return { account: this.view(this.store.get(account.id)!), duplicate, id: account.id };
  }

  /**
   * Explicitly route one account through the default entry (the gateway page's 「加入默认入口」). Unlike the
   * automatic first-account rule this creates the 默认 group even next to the user's own groups — it only runs
   * when the user asks, so their layout is never changed behind their back.
   */
  async attachDefault(accountId: string): Promise<{ groupId: string; name: string }> {
    const a = this.store.get(accountId);
    if (!a) throw new Error(tr('没有这个账号'));
    const groups = this.deps.meta.gatewayGroups();
    let g = groups.find((x) => x.id === 'default');
    if (!g) {
      g = { id: 'default', name: tr('默认'), strategy: 'failover', members: [] };
      groups.push(g);
    }
    if (!g.members.some((m) => m.accountId === accountId)) g.members.push({ accountId });
    await this.deps.meta.saveGateway();
    this.emit('changed');
    return { groupId: g.id, name: g.name };
  }

  /**
   * A fresh setup has no gateway group, so an account added from the gateway page would never be used. When the
   * user has not made any groups, put the account in a group called 默认 — the root /v1 then works with no setup.
   * Once the user has groups of their own, adding an account never touches them.
   */
  private async ensureDefaultGroup(accountId: string): Promise<void> {
    const groups = this.deps.meta.gatewayGroups();
    // a 默认 group that exists takes every new account; without one, a fresh setup gets it and a user's own
    // layout is left alone
    let g = groups.find((x) => x.id === 'default');
    if (!g) {
      if (groups.length) return;
      g = { id: 'default', name: tr('默认'), strategy: 'failover', members: [] };
      groups.push(g);
    }
    if (g.members.some((m) => m.accountId === accountId)) return;
    g.members.push({ accountId });
    await this.deps.meta.saveGateway();
    this.onGatewayGroups?.();
  }

  /**
   * A Gemini / WorkBuddy account lives in its sidecar first (that is where the login is used); the row here
   * mirrors it, keyed by the sidecar's own id. The sidecar is installed and started on demand.
   */
  private async addSidecar(input: UpstreamAccountInput): Promise<{ account: UpstreamAccountView; duplicate: boolean; id: string }> {
    const kind = input.kind as SidecarId;
    const driver = this.driver(kind)!;
    if (input.proxy && !normalizeAccountProxy(input.proxy)) throw new Error(tr('代理地址需要 http(s):// 或 socks5://'));
    const normalized = normalizeCredential(input.kind, input.credential, input.credentialKind);
    const dup = this.store.list().find((a) => a.kind === input.kind && a.fingerprint === normalized.fingerprint);
    if (dup) {
      // its sidecar database may have been reset: make sure the login is there as well
      await driver.ensureReady();
      const again = await driver.addAccount({ credential: input.credential, credentialKind: input.credentialKind, name: input.name, proxy: input.proxy, proxyId: input.proxyId });
      await this.link(dup, kind, again);
      // a cockpit export can bring several accounts; mirror the rest too (and the family's models)
      await this.syncFamily(kind);
      await this.ensureDefaultGroup(dup.id);
      this.emit('changed');
      return { account: this.view(dup), duplicate: true, id: dup.id };
    }
    await driver.ensureReady();
    const remote = await driver.addAccount({ credential: input.credential, credentialKind: input.credentialKind, name: input.name, proxy: input.proxy, proxyId: input.proxyId });
    // the sidecar may already have this login under a row `sync` mirrored (a QR login later pasted as JSON): adopt it
    const linked = this.store.list().find((a) => a.kind === input.kind && a.sidecar?.remoteId === remote.remoteId);
    if (linked) {
      await this.store.update(linked.id, { name: input.name ?? linked.name, credential: input.credential, credentialKind: input.credentialKind });
      await this.link(linked, kind, remote);
      await this.syncFamily(kind);
      await this.ensureDefaultGroup(linked.id);
      this.emit('changed');
      return { account: this.view(this.store.get(linked.id)!), duplicate: true, id: linked.id };
    }
    let account: UpstreamAccount;
    try {
      ({ account } = await this.store.add({ ...input, probe: false }));
    } catch (e) {
      await driver.removeAccount(remote.remoteId).catch(() => {});
      throw e;
    }
    await this.link(account, kind, remote);
    // a cockpit export can bring several accounts; mirror the rest too (and the family's models)
    await this.syncFamily(kind);
    await this.ensureDefaultGroup(account.id);
    this.emit('changed');
    return { account: this.view(this.store.get(account.id)!), duplicate: false, id: account.id };
  }

  /** Copy the sidecar's view of an account onto its row and remember the link. */
  private async link(account: UpstreamAccount, id: SidecarId, remote: SidecarAccount): Promise<void> {
    account.sidecar = { id, remoteId: remote.remoteId, syncedAt: this.now() };
    account.health = remote.health;
    account.name = account.name || remote.name;
    if (remote.lastError) account.lastError = remote.lastError;
    else delete account.lastError;
    if (remote.identity) account.identity = remote.identity;
    if (remote.quota) account.quota = remote.quota;
    if (remote.proxyId) account.sidecarProxy = { id: remote.proxyId, name: remote.proxyName, failCount: remote.failCount };
    else delete account.sidecarProxy;
    account.updatedAt = this.now();
    await this.deps.meta.saveUpstreams();
  }

  /** Make sure the row carries a link to its sidecar account (older rows, a reset sidecar DB). */
  private async ensureLink(a: UpstreamAccount): Promise<{ id: SidecarId; remoteId: string; syncedAt: number }> {
    const kind = a.kind as SidecarId;
    const driver = this.driver(kind)!;
    await driver.ensureReady();
    if (a.sidecar) return a.sidecar;
    const remote = await driver.addAccount({ credential: JSON.parse(await this.store.revealCredential(a)), name: a.name });
    await this.link(a, kind, remote);
    return a.sidecar!;
  }

  async update(id: string, patch: UpstreamAccountPatch): Promise<UpstreamAccountView> {
    const before = this.store.get(id);
    if (!before) throw new Error(tr('没有这个账号'));
    const driver = this.driver(before.kind);
    if (driver) {
      if (patch.proxy !== undefined && patch.proxy !== null && patch.proxy !== '' && !normalizeAccountProxy(patch.proxy)) {
        throw new Error(tr('代理地址需要 http(s):// 或 socks5://'));
      }
      const link = await this.ensureLink(before);
      let credentialMoved = false;
      if (patch.credential !== undefined) {
        const added = await driver.addAccount({ credential: patch.credential, credentialKind: patch.credentialKind, name: patch.name ?? before.name, proxy: patch.proxy ?? undefined });
        // the same login (a refreshed cookie / token) keeps its sidecar id: never remove what was just written
        if (added.remoteId !== link.remoteId) await driver.removeAccount(link.remoteId).catch(() => {});
        // a new credential plus `enabled` (re-login of a stopped account): both have to reach the component
        if (patch.enabled !== undefined) await driver.updateAccount(added.remoteId, { enabled: patch.enabled });
        if (patch.proxyId !== undefined) await driver.updateAccount(added.remoteId, { proxyId: patch.proxyId });
        before.sidecar = { id: link.id, remoteId: added.remoteId, syncedAt: this.now() };
        before.health = added.health;
        before.lastError = added.lastError;
        credentialMoved = true;
        await this.deps.meta.saveUpstreams();
        // a new login brings the subscription's models: the sidecar answered the anonymous two until now
        if (before.kind !== 'claude') await this.rememberModels(before.kind as SidecarId);
      }
      if (!credentialMoved && (patch.name !== undefined || patch.enabled !== undefined || patch.proxyId !== undefined)) {
        const remote = await driver.updateAccount(link.remoteId, { name: patch.name, enabled: patch.enabled, proxyId: patch.proxyId });
        before.health = remote.health;
        before.lastError = remote.lastError;
        if (remote.quota) before.quota = remote.quota;
        await this.deps.meta.saveUpstreams();
      }
    }
    const a = await this.store.update(id, patch);
    this.emit('changed');
    return this.view(a);
  }

  async remove(id: string): Promise<void> {
    const a = this.store.get(id);
    const driver = a ? this.driver(a.kind) : null;
    if (driver && a?.sidecar) await driver.removeAccount(a.sidecar.remoteId).catch(() => {});
    this.affinity.dropAccount(id);
    await this.store.remove(id);
    this.emit('changed');
  }

  async probe(id: string): Promise<UpstreamAccountView> {
    const a = this.store.get(id);
    if (!a) throw new Error(tr('没有这个账号'));
    if (a.kind === 'provider') {
      try {
        let r = await this.probeProvider(a);
        if (r.health === 'expired') {
          // Codex / Copilot tokens expire; refresh silently before telling the user to sign in again
          const credential = JSON.parse(await this.store.revealCredential(a));
          const refreshed = await refreshProviderCredential(this.providerFetch, a.providerId ?? String(credential.providerId ?? ''), credential, this.now())
            .catch(() => null);
          if (refreshed) {
            await this.store.update(id, { credential: refreshed, credentialKind: refreshed.kind === 'oauth' ? 'oauth' : 'token' });
            r = await this.probeProvider(this.store.get(id)!);
          }
        }
        await this.store.setHealth(id, {
          health: r.health,
          lastError: r.error,
          ...(r.cooldownUntil ? { cooldownUntil: r.cooldownUntil } : {}),
          ...(r.health === 'ok' ? { lastOkAt: this.now() } : {}),
          ...(r.models ? { models: r.models } : {}),
        });
      } catch (e: any) {
        await this.store.setHealth(id, { health: 'error', lastError: e?.message ?? String(e) });
      }
      this.emit('changed');
      return this.view(this.store.get(id)!);
    }
    if (a.kind !== 'claude') {
      const driver = this.driver(a.kind)!;
      try {
        const link = await this.ensureLink(a);
        const r = await driver.checkAccount(link.remoteId);
        await this.store.setHealth(id, {
          health: r.health,
          lastError: r.lastError,
          ...(r.health === 'ok' ? { lastOkAt: this.now() } : {}),
          ...(r.quota ? { quota: r.quota } : {}),
          ...(r.identity ? { identity: r.identity } : {}),
        });
      } catch (e: any) {
        await this.store.setHealth(id, { health: 'error', lastError: e?.message ?? String(e) });
      }
      this.emit('changed');
      return this.view(this.store.get(id)!);
    }
    let credential = await this.store.revealCredential(a);
    let r = await this.claude.probe(a, credential);
    if (r.health === 'expired') {
      const refreshed = await this.claude.refresh(a, credential);
      if (refreshed) {
        await this.store.update(id, { credential: JSON.parse(refreshed.credential) });
        credential = refreshed.credential;
        r = await this.claude.probe(a, credential);
      }
    }
    await this.store.setHealth(id, {
      health: r.health,
      cooldownUntil: r.cooldownUntil,
      lastError: r.error,
      ...(r.health === 'ok' ? { lastOkAt: this.now() } : {}),
      ...(r.quota ? { quota: r.quota } : {}),
      ...(r.identity ? { identity: r.identity } : {}),
    });
    this.emit('changed');
    return this.view(this.store.get(id)!);
  }

  async reset(id: string): Promise<void> {
    await this.store.setHealth(id, { health: 'unknown', cooldownUntil: undefined, lastError: undefined });
    this.emit('changed');
  }

  /**
   * A provider account's health: one model-list request with the same credential/headers the gateway will use.
   * It never sends a prompt (no tokens spent) and never logs the credential.
   */
  private async probeProvider(a: UpstreamAccount): Promise<{ health: UpstreamAccount['health']; models?: string[]; error?: string; cooldownUntil?: number }> {
    let c: any;
    try { c = JSON.parse(await this.store.revealCredential(a)); } catch { return { health: 'error', error: tr('凭据无法读取') }; }
    const token = c.token ?? c.accessToken;
    if (typeof token !== 'string' || !token) return { health: 'error', error: tr('凭据里没有令牌') };
    const base = String(c.baseUrl ?? '').replace(/\/+$/, '');
    if (!base) return { health: 'error', error: tr('没有接口地址') };
    const protocol = String(c.protocol ?? '');
    // vendor-root bases (Copilot / Codex) list /models directly; a plain OpenAI / Anthropic base needs its version
    const versioned = /\/v\d+[a-z]*$/i.test(base);
    const url = c.chatPath || versioned
      ? `${base}/models`
      : protocol === 'gemini' ? `${base}/v1beta/models`
        : `${base}/v1/models`;
    const headers: Record<string, string> = { accept: 'application/json', ...(c.headers ?? {}) };
    if (c.accountId) headers['chatgpt-account-id'] = String(c.accountId);
    if (protocol === 'gemini') headers['x-goog-api-key'] = token;
    else if (protocol === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (c.authStyle === 'bearer') headers.authorization = `Bearer ${token}`;
      else if (c.authStyle === 'x-api-key') headers['x-api-key'] = token;
      else { headers.authorization = `Bearer ${token}`; headers['x-api-key'] = token; }
    } else if (c.authStyle === 'x-api-key') headers['x-api-key'] = token;
    else headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.providerFetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (e: any) {
      return { health: 'error', error: tr('连接失败：{message}', { message: e?.message ?? String(e) }) };
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) return { health: 'expired', error: `HTTP ${res.status} ${text.slice(0, 160)}`.trim() };
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '');
      return { health: 'cooling', error: `HTTP 429 ${text.slice(0, 160)}`.trim(), cooldownUntil: this.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000) };
    }
    if (!res.ok) return { health: 'error', error: `HTTP ${res.status} ${text.slice(0, 160)}`.trim() };
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* a model list is optional: a 200 still proves the login */ }
    const raw: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    const models = raw.map((m: any) => String(m?.id ?? m?.slug ?? m?.name ?? m)).filter((x) => !!x && x !== 'undefined');
    return { health: 'ok', ...(models.length ? { models: [...new Set(models)] } : {}) };
  }

  /** a gateway request failed on this account: keep the account row's health in step with the member state */
  async markFailure(id: string, health: UpstreamAccount['health'], error: string, cooldownUntil?: number): Promise<void> {
    this.affinity.dropAccount(id); // the next request of a bound conversation may pick another account
    await this.store.setHealth(id, { health, lastError: error, ...(cooldownUntil ? { cooldownUntil } : {}) });
    this.emit('changed');
  }

  async markSuccess(id: string): Promise<void> {
    const a = this.store.get(id);
    if (!a || a.health === 'ok') return;
    await this.store.setHealth(id, { health: 'ok', lastOkAt: this.now(), lastError: undefined, cooldownUntil: undefined });
    this.emit('changed');
  }

  groups(): UpstreamGroup[] { return this.deps.meta.upstreamGroups(); }

  async upsertGroup(patch: Partial<UpstreamGroup> & { id?: string }): Promise<UpstreamGroup> {
    const list = this.groups();
    let g = patch.id ? list.find((x) => x.id === patch.id) : undefined;
    if (!g) {
      g = {
        id: patch.id && /^[A-Za-z0-9_-]{1,40}$/.test(patch.id) ? patch.id : crypto.randomBytes(4).toString('hex'),
        kind: patch.kind ?? 'claude',
        name: patch.name?.trim() || tr('新账号池'),
        strategy: patch.strategy ?? 'failover',
        members: [],
        enabled: patch.enabled ?? true,
        createdAt: this.now(),
      };
      list.push(g);
    }
    if (patch.name !== undefined) g.name = patch.name.trim() || g.name;
    if (patch.kind) g.kind = patch.kind;
    if (patch.strategy) g.strategy = patch.strategy;
    if (patch.enabled !== undefined) g.enabled = patch.enabled;
    if (patch.members) g.members = [...new Set(patch.members.filter((id) => this.store.get(id)?.kind === g.kind))];
    // a pool only holds accounts of its own family
    g.members = g.members.filter((id) => this.store.get(id)?.kind === g.kind);
    if (patch.modelMap !== undefined) g.modelMap = Object.fromEntries(Object.entries(patch.modelMap ?? {}).map(([k, v]) => [k.trim(), String(v).trim()]).filter(([k, v]) => k && v));
    if (patch.affinity !== undefined) g.affinity = patch.affinity;
    await this.deps.meta.saveUpstreams();
    this.emit('changed');
    return g;
  }

  async removeGroup(id: string): Promise<void> {
    this.deps.meta.data.upstreamGroups = this.groups().filter((g) => g.id !== id);
    for (const g of this.deps.meta.gatewayGroups()) g.members = g.members.filter((m) => m.upstreamGroupId !== id);
    await this.deps.meta.saveUpstreams();
    this.emit('changed');
  }

  /**
   * Accounts of a pool to try, in order: healthy ones by the pool's strategy; when none is usable, the one whose
   * cooldown ends soonest (the caller marks the response degraded). A session key, when given, pins the first pick.
   */
  /** Whether a request may pick this account right now (enabled, not expired / cooling, under today's limit). */
  private usable(a: UpstreamAccount, now: number): boolean {
    if (!a.enabled || a.health === 'disabled' || a.health === 'expired') return false;
    if (a.cooldownUntil && a.cooldownUntil > now) return false;
    const day = today(now);
    if (a.dailyRequestLimit && a.stats?.day === day && a.stats.requests >= a.dailyRequestLimit) return false;
    return true;
  }

  order(g: UpstreamGroup, sessionKey?: string): UpstreamAccount[] {
    const now = this.now();
    const all = g.members.map((id) => this.store.get(id)).filter((a): a is UpstreamAccount => !!a);
    const usable = all.filter((a) => this.usable(a, now));
    const cooling = all.filter((a) => a.enabled && a.cooldownUntil && a.cooldownUntil > now).sort((x, y) => (x.cooldownUntil ?? 0) - (y.cooldownUntil ?? 0));
    let list = usable.length ? usable : cooling;
    let sticky = false;
    // session affinity: the same conversation key sticks to the same account for the TTL, whatever the strategy
    if (sessionKey && (g.affinity?.mode ?? 'session') === 'session') {
      const bound = this.affinity.get(g.id, sessionKey, now);
      if (bound) {
        const hit = list.find((a) => a.id === bound);
        if (hit) { list = [hit, ...list.filter((a) => a.id !== bound)]; sticky = true; }
        else this.affinity.drop(g.id, sessionKey);
      }
      if (list[0]) this.affinity.bind(g.id, sessionKey, list[0].id, g.affinity?.ttlMinutes ?? 60, now);
    }
    if (sticky) return list;
    if (g.strategy === 'round-robin') {
      const n = this.cursor.get(g.id) ?? 0;
      this.cursor.set(g.id, (n + 1) % Math.max(1, list.length));
      return [...list.slice(n % Math.max(1, list.length)), ...list.slice(0, n % Math.max(1, list.length))];
    }
    if (g.strategy === 'least-used') return [...list].sort((x, y) => (x.stats?.requests ?? 0) - (y.stats?.requests ?? 0));
    if (g.strategy === 'most-quota') {
      const ratio = (a: UpstreamAccount) => {
        const w = a.quota?.windows.find((x) => x.usedPct !== undefined);
        return w?.usedPct === undefined ? -1 : 100 - w.usedPct;
      };
      return [...list].sort((x, y) => ratio(y) - ratio(x));
    }
    return list;
  }

  private mapModel(map: Record<string, string> | undefined, model: string): string {
    if (!map) return model;
    if (map[model]) return map[model];
    for (const [k, v] of Object.entries(map)) {
      if (k.endsWith('*') && model.startsWith(k.slice(0, -1))) return v;
    }
    return model;
  }

  /** why an account gave no target on its last resolve (the gateway's 503 says it instead of 「no usable member」) */
  readonly whyNot = new Map<string, string>();
  /** the reasons of the accounts behind a member, for the gateway's error */
  whyMember(m: GatewayMember): string[] {
    const ids = m.accountId ? [m.accountId] : m.upstreamGroupId ? this.groups().find((x) => x.id === m.upstreamGroupId)?.members ?? [] : [];
    return ids.map((id) => this.whyNot.get(id)).filter((x): x is string => !!x);
  }

  async resolveMembers(m: GatewayMember, model: string, sessionKey?: string): Promise<GatewayTarget[]> {
    if (m.accountId) {
      const a = this.store.get(m.accountId);
      if (a) this.whyNot.delete(a.id);
      // a single account member follows the same health / limit rules as a pool
      if (a && !this.usable(a, this.now())) this.whyNot.set(a.id, a.lastError || (a.health === 'expired' || a.health === 'disabled' ? tr('{name} 要重新登录', { name: a.name }) : tr('{name} 暂时不可用', { name: a.name })));
      return a && this.usable(a, this.now()) ? this.targets([a], model) : [];
    }
    if (m.upstreamGroupId) {
      const g = this.groups().find((x) => x.id === m.upstreamGroupId);
      if (!g || !g.enabled) return [];
      return this.targets(this.order(g, sessionKey), this.mapModel(g.modelMap, model));
    }
    return [];
  }

  private async targets(accounts: UpstreamAccount[], model: string): Promise<GatewayTarget[]> {
    const out: GatewayTarget[] = [];
    // one endpoint per sidecar family: its own pool decides which login serves the request
    const sidecarEndpoints = new Map<UpstreamKind, { baseUrl: string; apiKey: string } | null>();
    // A mixed 默认 group holds every family. A request names one model; send it to the family that has it, so a
    // Gemini model is not tried on the Claude subscription first (a 400 would not fail over).
    const sidecarModels = new Map<UpstreamKind, string[]>(this.familyModelsCache);
    const knownElsewhere = !!model && [...sidecarModels.values()].some((list) => list.includes(model));
    for (const a of accounts) {
      if (a.kind === 'provider') {
        // a probed provider list only serves the models it names (a group's modelMap may have changed the model)
        if (model && a.models?.length && !a.models.includes(model)) continue;
        let c: any;
        try { c = JSON.parse(await this.store.revealCredential(a)); } catch { continue; }
        // a short-lived login (Grok's CLI token lasts hours) is renewed before it is handed out, not after a 401
        if (typeof c.expiresAt === 'number' && c.refreshToken && c.expiresAt - this.now() < 2 * 60_000) c = (await this.renewProvider(a, c)) ?? c;
        const token = c.token ?? c.accessToken;
        if (typeof token !== 'string' || !token) continue;
        const protocol = ['anthropic', 'openai', 'responses', 'gemini'].includes(String(c.protocol)) ? String(c.protocol) : 'openai';
        const type: 'anthropic' | 'openai' | 'gemini' = protocol === 'anthropic' ? 'anthropic' : protocol === 'gemini' ? 'gemini' : 'openai';
        const proxy = await this.store.revealProxy(a).catch(() => undefined);
        const headers = {
          ...(c.headers ?? {}),
          ...(c.accountId ? { 'chatgpt-account-id': String(c.accountId) } : {}),
        };
        out.push({
          id: a.id,
          name: a.name,
          type,
          baseUrl: String(c.baseUrl ?? ''),
          apiKey: token,
          createdAt: 0,
          protocol: protocol as 'anthropic' | 'openai' | 'responses' | 'gemini',
          ...(c.authStyle ? { authStyle: c.authStyle } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(c.chatPath ? { chatPath: c.chatPath } : {}),
          ...(a.kind === 'provider' && protocol === 'anthropic' && c.kind === 'oauth' ? { auth: 'oauth' as const, forceTranslate: true } : {}),
          ...(model ? { model } : {}),
          ...(proxy ? { proxy } : {}),
          ...(a.cooldownUntil && a.cooldownUntil > this.now() ? { degraded: true } : {}),
          account: true,
        });
        continue;
      }
      if (a.kind === 'claude') {
        if (knownElsewhere) continue;
        const credential = JSON.parse(await this.store.revealCredential(a));
        const token = claudeToken(credential);
        if (!token) continue;
        const proxy = await this.store.revealProxy(a).catch(() => undefined);
        out.push({
          id: a.id,
          name: a.name,
          type: 'anthropic',
          baseUrl: this.deps.claudeBase ?? process.env.CW_CLAUDE_BASE ?? 'https://api.anthropic.com',
          apiKey: token,
          createdAt: 0,
          auth: 'oauth',
          forceTranslate: true,
          account: true,
          ...(model ? { model } : {}),
          ...(proxy ? { proxy } : {}),
          // a pool with nobody healthy still tries its soonest-to-recover account; the answer says so
          ...(a.cooldownUntil && a.cooldownUntil > this.now() ? { degraded: true } : {}),
        });
        continue;
      }
      const driver = this.driver(a.kind);
      if (!driver) continue;
      const known = sidecarModels.get(a.kind);
      // the family's own id for a bare name: WorkBuddy lists `global:deepseek-v4.1-flash`, a profile / conversation says
      // `deepseek-v4.1-flash` (user report 2026-11-03: every request got 「组没有可用成员」)
      const own = model && known?.length && !known.includes(model) ? familyIdFor(model, known) : model;
      if (model && known?.length && !own) { this.whyNot.set(a.id, tr('{name} 没有模型 {model}', { name: a.name, model })); continue; }
      const sent = own || model;
      if (!sidecarEndpoints.has(a.kind)) sidecarEndpoints.set(a.kind, await driver.endpoint().catch((e) => { this.whyNot.set(a.id, String(e?.message ?? e)); return null; }));
      const ep = sidecarEndpoints.get(a.kind);
      if (!ep) { if (!this.whyNot.has(a.id)) this.whyNot.set(a.id, tr('{name} 组件没有启动', { name: a.kind === 'gemini' ? tr('Gemini 网页') : 'WorkBuddy' })); continue; }
      const id = `sidecar:${a.kind}`;
      if (!ep || out.some((t) => t.id === id)) continue;
      out.push({
        id,
        name: a.kind === 'gemini' ? tr('Gemini 网页') : 'WorkBuddy',
        type: 'openai',
        baseUrl: ep.baseUrl,
        apiKey: ep.apiKey,
        createdAt: 0,
        ...(sent ? { model: sent } : {}),
      });
    }
    return out;
  }

  private renewing = new Map<string, Promise<any | null>>();
  /** Refresh a provider login now (one at a time per account); the stored credential is updated. */
  private renewProvider(a: UpstreamAccount, c: any): Promise<any | null> {
    let p = this.renewing.get(a.id);
    if (!p) {
      p = refreshProviderCredential(this.providerFetch, a.providerId ?? String(c.providerId ?? ''), c, this.now())
        .then(async (r) => { if (r) await this.store.update(a.id, { credential: r, credentialKind: r.kind === 'oauth' ? 'oauth' : 'token' }); return r; })
        .catch(() => null)
        .finally(() => { this.renewing.delete(a.id); });
      this.renewing.set(a.id, p);
    }
    return p;
  }

  /** One in-flight slot for an account (maxConcurrent); false when it is at its cap. */
  acquire(id: string): boolean {
    const cap = this.store.get(id)?.maxConcurrent;
    if (!cap) return true;
    const n = this.live.get(id) ?? 0;
    if (n >= cap) return false;
    this.live.set(id, n + 1);
    return true;
  }

  release(id: string): void {
    this.live.set(id, Math.max(0, (this.live.get(id) ?? 1) - 1));
  }

  noteUse(id: string, usage: { input: number; output: number }): void {
    const a = this.store.get(id);
    if (!a) return;
    const day = today(this.now());
    const s = a.stats?.day === day ? a.stats : { day, requests: 0, tokensIn: 0, tokensOut: 0 };
    s.requests += 1;
    s.tokensIn += usage.input;
    s.tokensOut += usage.output;
    a.stats = s;
    a.lastUsedAt = this.now();
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { void this.flush(); }, 30_000);
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    await this.deps.meta.saveUpstreams();
  }

  /** The task center's per-account work: a health / quota check here, a sidecar task there. */
  async runAccountTask(id: string, kind: MaintenanceKind): Promise<TaskResult> {
    const a = this.store.get(id);
    if (!a) throw new Error(tr('没有这个账号'));
    if (kind === 'account-check' || kind === 'quota-refresh') {
      const v = await this.probe(id);
      return { ok: v.health === 'ok', detail: v.lastError, quota: v.quota };
    }
    const driver = this.driver(a.kind);
    if (!driver) return { ok: false, detail: tr('这个类型的账号没有这项任务') };
    const link = await this.ensureLink(a);
    const r = await driver.runTask(link.remoteId, kind);
    if (r.quota) await this.store.setHealth(id, { quota: r.quota });
    return r;
  }

  // ---- a sidecar family's proxy pool (residential exits) ----

  private proxiesDriver(id: SidecarId): NonNullable<SidecarDriver['listProxies']> {
    const d = this.driver(id);
    if (!d?.listProxies) throw new Error(tr('这个类型的账号没有出口设置'));
    return d.listProxies.bind(d);
  }

  async proxies(id: SidecarId): Promise<SidecarProxy[]> { return this.proxiesDriver(id)(); }

  async addProxy(id: SidecarId, input: SidecarProxyInput): Promise<SidecarProxy[]> {
    const d = this.driver(id);
    if (!d?.addProxy) throw new Error(tr('这个类型的账号没有出口设置'));
    const url = normalizeAccountProxy(input.url);
    if (!url) throw new Error(tr('代理地址需要 http(s):// 或 socks5://'));
    const out = await d.addProxy({ ...input, url });
    this.emit('changed');
    return out;
  }

  async updateProxy(id: SidecarId, proxyId: number, patch: SidecarProxyPatch): Promise<SidecarProxy[]> {
    const d = this.driver(id);
    if (!d?.updateProxy) throw new Error(tr('这个类型的账号没有出口设置'));
    const clean = { ...patch };
    if (clean.url !== undefined) {
      const url = normalizeAccountProxy(clean.url);
      if (!url) throw new Error(tr('代理地址需要 http(s):// 或 socks5://'));
      clean.url = url;
    }
    const out = await d.updateProxy(proxyId, clean);
    this.emit('changed');
    return out;
  }

  async removeProxy(id: SidecarId, proxyId: number): Promise<SidecarProxy[]> {
    const d = this.driver(id);
    if (!d?.removeProxy) throw new Error(tr('这个类型的账号没有出口设置'));
    const out = await d.removeProxy(proxyId);
    this.emit('changed');
    return out;
  }

  async resetProxy(id: SidecarId, proxyId: number): Promise<SidecarProxy[]> {
    const d = this.driver(id);
    if (!d?.resetProxy) throw new Error(tr('这个类型的账号没有出口设置'));
    const out = await d.resetProxy(proxyId);
    this.emit('changed');
    return out;
  }

  /** One sign-in's loopback tunnel; the plaintext exit URL never leaves the server. */
  private loginTunnels = new Map<string, ExitTunnel>();
  private tunnelSeq = 0;

  async openLoginTunnel(id: SidecarId, proxyId?: number): Promise<LoginTunnel> {
    const d = this.driver(id);
    if (!d?.exitUrl) throw new Error(tr('这个类型的账号没有出口设置'));
    const url = await d.exitUrl(proxyId);
    if (!url) throw new Error(tr('还没有可用的出口，先添加一个'));
    try {
      await probeExit(url);
    } catch (e) {
      // never open the window on a dead exit: Chrome would fall back to direct and leak the real IP
      throw new Error(tr('出口连不上：{e}', { e: (e as Error).message }));
    }
    const tunnel = await startExitTunnel(url);
    const tunnelId = `t${++this.tunnelSeq}`;
    this.loginTunnels.set(tunnelId, tunnel);
    return { tunnelId, server: `127.0.0.1:${tunnel.port}`, exit: maskProxyUrl(url) };
  }

  async closeLoginTunnel(tunnelId: string): Promise<void> {
    const t = this.loginTunnels.get(tunnelId);
    if (!t) return;
    this.loginTunnels.delete(tunnelId);
    await t.close();
  }

  // ---- guard settings (the family's own rate limits / breaker / fallbacks) ----

  async guard(id: SidecarId): Promise<SidecarGuard> {
    const d = this.driver(id);
    if (!d?.settings) return { perIpConcurrent: 0, perIpRpm: 0, perIpRph: 0, proxyCooldownMin: 0, fallbackDirect: false, fallbackAnon: false, multiTurn: false, maxPromptBytes: 0, supported: false };
    const c = await d.settings();
    return {
      perIpConcurrent: Number(c.per_ip_concurrent ?? 0),
      perIpRpm: Number(c.per_ip_rpm ?? 0),
      perIpRph: Number(c.per_ip_rph ?? 0),
      proxyCooldownMin: Number(c.proxy_cooldown_min ?? 0),
      fallbackDirect: !!c.fallback_direct,
      fallbackAnon: !!c.fallback_anon,
      multiTurn: !!c.multi_turn,
      maxPromptBytes: Number(c.max_prompt_bytes ?? 0),
      supported: true,
    };
  }

  async saveGuard(id: SidecarId, patch: Partial<Omit<SidecarGuard, 'supported'>>): Promise<SidecarGuard> {
    const d = this.driver(id);
    if (!d?.saveSettings) throw new Error(tr('这个类型的账号没有防护设置'));
    const body: Record<string, unknown> = {};
    if (patch.perIpConcurrent !== undefined) body.per_ip_concurrent = Math.max(0, Math.floor(patch.perIpConcurrent));
    if (patch.perIpRpm !== undefined) body.per_ip_rpm = Math.max(0, Math.floor(patch.perIpRpm));
    if (patch.perIpRph !== undefined) body.per_ip_rph = Math.max(0, Math.floor(patch.perIpRph));
    if (patch.proxyCooldownMin !== undefined) body.proxy_cooldown_min = Math.max(0, Math.floor(patch.proxyCooldownMin));
    if (patch.fallbackDirect !== undefined) body.fallback_direct = !!patch.fallbackDirect;
    if (patch.fallbackAnon !== undefined) body.fallback_anon = !!patch.fallbackAnon;
    if (patch.multiTurn !== undefined) body.multi_turn = !!patch.multiTurn;
    if (patch.maxPromptBytes !== undefined) body.max_prompt_bytes = Math.max(0, Math.floor(patch.maxPromptBytes));
    await d.saveSettings(body);
    this.emit('changed');
    return this.guard(id);
  }

  familyModels(kind: UpstreamKind): string[] {
    // provider accounts each have their own model list (an account row), not one per family
    if (kind === 'provider') return [];
    const known = this.familyModelsCache.get(kind) ?? [];
    // The list a sidecar reports depends on the login: without a usable account it answers only the anonymous
    // models (2), after a sign-in it answers the subscription's full set. So it goes stale — refresh on a TTL,
    // and when the cache is empty pull right away.
    const at = this.familyModelsAt.get(kind) ?? 0;
    const stale = !known.length || Date.now() - at > MODELS_TTL_MS;
    const triedAt = this.modelsTried.get(kind) ?? 0;
    if (stale && !this.modelsLoading.has(kind) && Date.now() - triedAt > 30_000) {
      this.modelsLoading.add(kind);
      this.modelsTried.set(kind, Date.now());
      void this.rememberModels(kind as SidecarId).finally(() => { this.modelsLoading.delete(kind); this.emit('changed'); });
    }
    return known;
  }

  /** The user's 刷新模型: ask the sidecar again now (its answer depends on which login it currently has). */
  async refreshModels(id: SidecarId): Promise<string[]> {
    await this.rememberModels(id);
    this.emit('changed');
    return this.familyModelsCache.get(id) ?? [];
  }

  private async rememberModels(kind: SidecarId, options?: SidecarReadOptions): Promise<void> {
    try {
      const models = await this.driver(kind)!.models(options);
      if (models.length) {
        this.familyModelsCache.set(kind, models);
        this.familyModelsAt.set(kind, Date.now());
      }
    } catch { /* the sidecar may still be starting; the next add / sync fills it */ }
  }

  /** Which maintenance kinds make sense for a family. */
  familyTasks(kind: UpstreamKind): MaintenanceKind[] {
    // Gemini's current sidecar exposes cookie health checks, not 5-hour/weekly quota windows. Do not present a
    // misleading "refresh quota" task until the sidecar returns resetAt/usedPct data.
    if (kind === 'gemini') return ['keepalive', 'account-check'];
    if (kind === 'workbuddy') return ['checkin', 'keepalive', 'growth', 'travel', 'lottery', 'activity', 'quota-refresh', 'account-check'];
    return ['account-check', 'quota-refresh'];
  }

  /**
   * The models a gateway member brings to the menu: a provider account has its own probed list; a provider pool is
   * the union of its members; every other family reports one list per sidecar.
   */
  modelsForMember(m: { accountId?: string; upstreamGroupId?: string }): string[] {
    if (m.accountId) {
      const a = this.store.get(m.accountId);
      if (!a) return [];
      return a.kind === 'provider' ? (a.models ?? []) : this.familyModels(a.kind);
    }
    if (m.upstreamGroupId) {
      const g = this.groups().find((x) => x.id === m.upstreamGroupId);
      if (!g) return [];
      if (g.kind !== 'provider') return this.familyModels(g.kind);
      const out = new Set<string>();
      for (const id of g.members) for (const model of this.store.get(id)?.models ?? []) out.add(model);
      return [...out];
    }
    return [];
  }

  // ---- generic provider logins (upstreams.login.*) ----

  loginProviders() { return this.logins.providers(); }
  loginBegin(input: ProviderLoginBegin) { return this.logins.begin(input); }
  loginStatus(id: string) { return this.logins.status(id); }
  loginCancel(id: string) { return this.logins.cancel(id); }

  // ---- sidecar management (phase B/C) ----

  sidecarStatus(): SidecarStatus[] { return this.sidecars.statuses(); }

  async installSidecar(id: SidecarId): Promise<SidecarStatus> {
    await this.sidecars.ensure(id);
    this.emit('changed');
    return this.sidecars.status(id);
  }

  async startSidecar(id: SidecarId): Promise<SidecarStatus> {
    await this.driver(id)!.ensureReady();
    await this.rememberModels(id);
    this.emit('changed');
    return this.sidecars.status(id);
  }

  async stopSidecar(id: SidecarId): Promise<SidecarStatus> {
    await this.sidecars.stop(id);
    this.emit('changed');
    return this.sidecars.status(id);
  }

  async sidecarLogs(id: SidecarId, lines = 200): Promise<string> {
    return this.sidecars.logs(id, lines);
  }

  /** Mirror the accounts a sidecar already has (its own OAuth / QR login) into the account list. */
  async syncFamily(id: SidecarId, options?: SidecarReadOptions): Promise<UpstreamAccountView[]> {
    const inFlight = this.syncing.get(id);
    if (inFlight) return inFlight;
    const p = this.doSyncFamily(id, options).finally(() => { if (this.syncing.get(id) === p) this.syncing.delete(id); });
    this.syncing.set(id, p);
    return p;
  }

  private async doSyncFamily(id: SidecarId, options?: SidecarReadOptions): Promise<UpstreamAccountView[]> {
    const driver = this.driver(id)!;
    if (options?.start !== false) await driver.ensureReady();
    const remotes = await driver.listAccounts(options);
    await this.rememberModels(id, options);
    for (const r of remotes) {
      const known = this.store.list().find((a) => a.kind === id && a.sidecar?.remoteId === r.remoteId);
      if (known) {
        // remember that the *component* stopped it (3 consecutive auth failures), so a passing check may
        // switch it back on; a stop the user made is never undone
        // the component's own stop surfaces as `expired` (its `dead` = fail_count > 0, whether enabled or
        // auto-disabled); a stop the user made surfaces as `disabled`. Only the former may be auto-recovered.
        const autoStopped = known.enabled && !r.enabled && r.health === 'expired' && !!r.lastError;
        // the row has to say stopped too, or the recovery sweep (which looks at !enabled) never sees it
        if (autoStopped) known.enabled = false;
        if (r.proxyId) known.sidecarProxy = { id: r.proxyId, name: r.proxyName, failCount: r.failCount };
        await this.store.setHealth(known.id, {
          health: r.health,
          lastError: r.lastError,
          ...(autoStopped ? { autoDisabledAt: this.now() } : {}),
          ...(r.health === 'ok' ? { autoDisabledAt: undefined } : {}),
          ...(r.quota ? { quota: r.quota } : {}),
          ...(r.identity ? { identity: r.identity } : {}),
        });
        continue;
      }
      const account = await this.store.addManaged(id, r.name, r.remoteId);
      await this.link(account, id, r);
      await this.ensureDefaultGroup(account.id);
    }
    this.emit('changed');
    return this.store.list().filter((a) => a.kind === id).map((a) => this.view(a));
  }

  async oauthStart(realm: 'cn' | 'global' = 'cn'): Promise<{ url: string; state: string }> {
    await this.workbuddy.ensureReady();
    if (!this.workbuddy.startLogin) throw new Error(tr('这个组件不支持扫码登录'));
    return this.workbuddy.startLogin(realm);
  }

  async oauthPoll(state: string): Promise<{ done: boolean; message?: string; uid?: string }> {
    if (!this.workbuddy.pollLogin) throw new Error(tr('这个组件不支持扫码登录'));
    return this.workbuddy.pollLogin(state);
  }

  async stop(): Promise<void> {
    await this.flush();
    await this.sidecars.stopAll();
  }
}
