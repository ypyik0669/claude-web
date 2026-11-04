// The generic provider-login session service behind `upstreams.login.begin / status / cancel`.
//
// It owns the in-memory state of a sign-in (never the account: a completed login goes through UpstreamService.add,
// which encrypts the credential via SecretService). Tokens are held only until that hand-off. Nothing here writes a
// token to disk or to a log.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { tr } from '../i18n/index.js';
import { loginDef, loginInfos, type ProviderLoginDef, type ProviderLoginInfo, type LoginMode } from './oauth-registry.js';
import {
  createPkce, createState, startLoopbackReceiver, authorizeUrl, exchangeCode, startDeviceAuthorization,
  pollDeviceToken, exchangeCopilotToken, identityFromIdToken, fetchIdentity, postForm, tokensFrom,
  type TokenSet, type LoopbackReceiver,
} from './oauth.js';
import type { UpstreamAccountInput, UpstreamAccountView } from './types.js';
import { ssoToGrokTokens } from './grok-sso.js';

export type LoginSessionState = 'pending' | 'done' | 'error' | 'cancelled' | 'unavailable';

export interface LoginSessionView {
  id: string;
  providerId: string;
  auth: ProviderLoginDef['auth'];
  state: LoginSessionState;
  /** authorization URL (OAuth) or verification URL (device code) */
  url?: string;
  /** device-code user code */
  userCode?: string;
  expiresAt?: number;
  message?: string;
  accounts?: UpstreamAccountView[];
}

export interface ProviderLoginBegin {
  providerId: string;
  mode?: LoginMode;
  /** paste mode only */
  credential?: string;
  name?: string;
}

export interface AccountSink {
  add(input: UpstreamAccountInput): Promise<{ account: UpstreamAccountView; duplicate: boolean; id: string }>;
}

interface Session {
  id: string;
  def: ProviderLoginDef;
  auth: ProviderLoginDef['auth'];
  state: LoginSessionState;
  url?: string;
  userCode?: string;
  expiresAt?: number;
  message?: string;
  accounts?: UpstreamAccountView[];
  createdAt: number;
  receiver?: LoopbackReceiver;
  abort?: AbortController;
}

export interface ProviderLoginDeps {
  accounts: AccountSink;
  fetch?: typeof fetch;
  now?: () => number;
  /** tests pass a short timeout; real logins get ten minutes */
  timeoutMs?: number;
  /** local credential files are resolved against this home in tests */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** device-code poll interval override (tests); 0 / unset = the vendor's own interval */
  minDevicePollMs?: number;
  /** tests substitute the registry (defaults to the real definitions) */
  lookup?: (id: string) => ProviderLoginDef | undefined;
  list?: () => ProviderLoginInfo[];
}

const MAX_SESSIONS = 20;

export class ProviderLoginService {
  private sessions = new Map<string, Session>();
  private fetchImpl: typeof fetch;
  private now: () => number;
  private timeoutMs: number;
  private home: string;
  private env: NodeJS.ProcessEnv;
  private minDevicePollMs: number;
  private lookup: (id: string) => ProviderLoginDef | undefined;
  private listDefs: () => ProviderLoginInfo[];

  constructor(private deps: ProviderLoginDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60_000;
    this.home = deps.home ?? os.homedir();
    this.env = deps.env ?? process.env;
    this.minDevicePollMs = deps.minDevicePollMs ?? 0;
    this.lookup = deps.lookup ?? loginDef;
    this.listDefs = deps.list ?? loginInfos;
  }

  providers(): ProviderLoginInfo[] {
    return this.listDefs();
  }

  /** Begin one login. OAuth / device-code return while pending; paste / local finish in the same call. */
  async begin(input: ProviderLoginBegin): Promise<LoginSessionView> {
    const def = this.lookup(input.providerId);
    if (!def) throw new Error(tr('没有这个登录方式'));
    const mode = input.mode ?? defaultMode(def);
    const session = this.create(def);
    if (!def.available || !def.account?.usable) {
      session.state = 'unavailable';
      session.message = def.reason ?? def.account?.reason ?? tr('这个来源还不能从 claude-web 登录');
      return this.view(session);
    }
    try {
      if (mode === 'paste') {
        await this.beginPaste(session, input.credential, input.name);
      } else if (mode === 'local') {
        await this.beginLocal(session);
      } else if (mode === 'oauth') {
        await this.beginOAuth(session);
      } else if (mode === 'device') {
        await this.beginDevice(session);
      } else {
        throw new Error(tr('这个来源没有这种登录方式'));
      }
    } catch (e: any) {
      this.fail(session, e);
    }
    return this.view(session);
  }

  status(id: string): LoginSessionView {
    const session = this.sessions.get(id);
    if (!session) throw new Error(tr('这个登录已经结束了'));
    return this.view(session);
  }

  async cancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'pending') return;
    session.state = 'cancelled';
    session.message = tr('登录已取消');
    session.abort?.abort();
    await session.receiver?.close().catch(() => {});
    session.receiver = undefined;
  }

  private create(def: ProviderLoginDef): Session {
    const session: Session = {
      id: `pl_${crypto.randomBytes(6).toString('hex')}`,
      def,
      auth: def.auth,
      state: 'pending',
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    // bound the map: a user may leave several windows open over days
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].filter((s) => s.state !== 'pending').sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    return session;
  }

  private view(s: Session): LoginSessionView {
    return {
      id: s.id,
      providerId: s.def.id,
      auth: s.auth,
      state: s.state,
      ...(s.url ? { url: s.url } : {}),
      ...(s.userCode ? { userCode: s.userCode } : {}),
      ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
      ...(s.message ? { message: s.message } : {}),
      ...(s.accounts?.length ? { accounts: s.accounts } : {}),
    };
  }

  private fail(s: Session, e: any): void {
    if (s.state === 'cancelled') return;
    s.state = 'error';
    s.message = e?.message ?? String(e);
  }

  private async beginOAuth(s: Session): Promise<void> {
    const cfg = s.def.oauth;
    if (!cfg) throw new Error(tr('这个来源没有浏览器登录'));
    const state = createState();
    const pkce = createPkce();
    const receiver = await startLoopbackReceiver({
      port: cfg.redirectPort,
      path: cfg.redirectPath ?? '/callback',
      host: cfg.redirectHost,
      state,
      timeoutMs: this.timeoutMs,
    });
    s.receiver = receiver;
    s.url = authorizeUrl(cfg, { redirectUri: receiver.redirectUri, state, challenge: pkce.challenge });
    s.expiresAt = this.now() + this.timeoutMs;
    void (async () => {
      try {
        const code = await receiver.code;
        const tokens = await exchangeCode(this.fetchImpl, cfg, { code, redirectUri: receiver.redirectUri, verifier: pkce.verifier }, this.now());
        await this.finishTokens(s, tokens);
        if (s.state === 'pending') s.state = 'done';
      } catch (e: any) {
        this.fail(s, e);
      } finally {
        s.receiver = undefined;
        await receiver.close().catch(() => {});
      }
    })();
  }

  private async beginDevice(s: Session): Promise<void> {
    const cfg = s.def.device;
    if (!cfg) throw new Error(tr('这个来源没有设备码登录'));
    const device = await startDeviceAuthorization(this.fetchImpl, cfg, this.now());
    s.url = device.verificationUri;
    s.userCode = device.userCode;
    s.expiresAt = device.expiresAt;
    const abort = new AbortController();
    s.abort = abort;
    void (async () => {
      try {
        const tokens = await pollDeviceToken(this.fetchImpl, cfg, {
          ...device,
          intervalMs: this.minDevicePollMs > 0 ? this.minDevicePollMs : device.intervalMs,
        }, { signal: abort.signal, now: this.now });
        await this.finishTokens(s, tokens);
        if (s.state === 'pending') s.state = 'done';
      } catch (e: any) {
        this.fail(s, e);
      }
    })();
  }

  private async beginPaste(s: Session, credential: string | undefined, name?: string): Promise<void> {
    const cfg = s.def.paste;
    if (!cfg) throw new Error(tr('这个来源不支持粘贴令牌'));
    const text = credential?.trim();
    if (!text) throw new Error(tr('先粘贴凭据'));
    if (cfg.convert === 'grok-sso') {
      const t = await ssoToGrokTokens(text, { fetch: this.fetchImpl });
      await this.finishTokens(s, { accessToken: t.accessToken, refreshToken: t.refreshToken, idToken: t.idToken, expiresAt: t.expiresAt, scope: t.scope });
      return;
    }
    const input = this.accountInput(s.def, { token: text }, name, undefined, 'paste');
    await this.addAccounts(s, [input]);
  }

  private async beginLocal(s: Session): Promise<void> {
    const local = s.def.local;
    if (!local) throw new Error(tr('这个来源不支持读取本机登录态'));
    const inputs = local.reader === 'claude-credentials'
      ? await readClaudeCredentials(local.paths, this.home, this.env)
      : await readOpenCodeAuth(local.paths, this.home, this.env);
    if (!inputs.length) throw new Error(tr('没有找到可用的本机登录态。先在那个工具里登录，再试一次。'));
    await this.addAccounts(s, inputs);
  }

  private async finishTokens(s: Session, tokens: TokenSet): Promise<void> {
    const mapping = s.def.account;
    if (!mapping?.usable) throw new Error(s.def.reason ?? tr('这个来源还不能从 claude-web 登录'));
    let accessToken = tokens.accessToken;
    let refreshToken = tokens.refreshToken;
    let expiresAt = tokens.expiresAt;
    let identity: { email?: string; name?: string; accountId?: string } = identityFromIdToken(tokens.idToken);
    if (mapping.exchange === 'copilot') {
      const device = s.def.device;
      const copilot = await exchangeCopilotToken(this.fetchImpl, accessToken, device?.headers, this.now());
      refreshToken = accessToken; // keep the GitHub token for the next Copilot exchange
      accessToken = copilot.token;
      expiresAt = copilot.expiresAt ?? expiresAt;
      if (device?.identityUrl) identity = { ...identity, ...(await fetchIdentity(this.fetchImpl, device.identityUrl, refreshToken, device.headers)) };
    } else if (s.def.oauth?.identityUrl) {
      identity = { ...identity, ...(await fetchIdentity(this.fetchImpl, s.def.oauth.identityUrl, accessToken)) };
    }
    await this.addAccounts(s, [this.accountInput(s.def, {
      accessToken,
      refreshToken,
      expiresAt,
      idToken: tokens.idToken,
      scope: tokens.scope,
    }, identity.name ?? identity.email, identity)]);
  }

  /** The single place a completed token turns into the envelope an account row stores. */
  private accountInput(def: ProviderLoginDef, t: { accessToken?: string; token?: string; refreshToken?: string; expiresAt?: number; idToken?: string; scope?: string }, name?: string, identity?: { email?: string }, source: 'oauth' | 'paste' | 'file' = 'oauth'): UpstreamAccountInput {
    const mapping = def.account!;
    const token = t.accessToken ?? t.token ?? '';
    const label = name?.trim() || def.name;
    const identityField = identity?.email ? { identity: { email: identity.email } } : {};
    if (mapping.kind === 'claude') {
      return {
        kind: 'claude',
        name: label,
        source,
        credentialKind: 'oauth',
        ...identityField,
        credential: {
          kind: 'oauth',
          accessToken: token,
          ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
          ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
          ...(t.scope ? { scope: t.scope } : {}),
        },
      };
    }
    const providerId = mapping.providerId ?? def.id;
    const claims = identityFromIdToken(t.idToken);
    return {
      kind: 'provider',
      providerId,
      name: label,
      source,
      credentialKind: mapping.credentialKind,
      ...identityField,
      credential: {
        kind: mapping.credentialKind,
        providerId,
        protocol: mapping.protocol,
        baseUrl: mapping.baseUrl,
        ...(mapping.authStyle ? { authStyle: mapping.authStyle } : {}),
        ...(mapping.headers ? { headers: mapping.headers } : {}),
        ...(mapping.chatPath ? { chatPath: mapping.chatPath } : {}),
        ...(mapping.credentialKind === 'oauth' ? { accessToken: token } : { token }),
        ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
        ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
        ...(claims.accountId ? { accountId: claims.accountId } : {}),
      },
    };
  }

  private async addAccounts(s: Session, inputs: UpstreamAccountInput[]): Promise<void> {
    const views: UpstreamAccountView[] = [];
    for (const input of inputs) {
      const r = await this.deps.accounts.add(input);
      views.push(r.account);
    }
    s.accounts = views;
    s.state = 'done';
  }
}

function defaultMode(def: ProviderLoginDef): LoginMode {
  if (def.auth === 'device-code') return 'device';
  if (def.auth === 'paste-token') return 'paste';
  if (def.auth === 'local-credential') return 'local';
  return 'oauth';
}

// ---- local credential readers (read-only; the file itself is never modified) ----

function expandPath(raw: string, home: string, env: NodeJS.ProcessEnv): string | null {
  let out = raw;
  let missing = false;
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_all, name: string) => {
    const value = env[name];
    if (!value) { missing = true; return ''; }
    return value;
  });
  if (missing || out.includes('%')) return null;
  if (out === '~') out = home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(home, out.slice(2));
  return path.isAbsolute(out) ? out : path.join(home, out);
}

async function readJsonFile(raw: string, home: string, env: NodeJS.ProcessEnv): Promise<{ file: string; json: any } | null> {
  const file = expandPath(raw, home, env);
  if (!file) return null;
  try {
    const text = await fs.readFile(file, 'utf8');
    return { file, json: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** `claude ~/.claude/.credentials.json` (or CLAUDE_CONFIG_DIR) → one Claude OAuth account. */
export async function readClaudeCredentials(paths: string[], home: string, env: NodeJS.ProcessEnv): Promise<UpstreamAccountInput[]> {
  for (const p of paths) {
    const got = await readJsonFile(p, home, env);
    if (!got) continue;
    const oauth = got.json?.claudeAiOauth ?? got.json;
    if (typeof (oauth?.accessToken ?? oauth?.access_token) !== 'string') continue;
    return [{
      kind: 'claude',
      name: tr('Claude Code（本机）'),
      source: 'file',
      credentialKind: 'oauth',
      credential: oauth,
    }];
  }
  return [];
}

/**
 * OpenCode's auth.json: `{ anthropic: {type:'oauth', access, refresh, expires}, openai: {type:'api', key}, … }`.
 * Only entries whose endpoint we can name from the vendor's own documentation are imported; an entry we do not know
 * is left alone rather than mapped to a guessed URL.
 */
export async function readOpenCodeAuth(paths: string[], home: string, env: NodeJS.ProcessEnv): Promise<UpstreamAccountInput[]> {
  for (const p of paths) {
    const got = await readJsonFile(p, home, env);
    if (!got || !got.json || typeof got.json !== 'object' || Array.isArray(got.json)) continue;
    const out: UpstreamAccountInput[] = [];
    const auth = got.json as Record<string, any>;
    const anthropic = auth.anthropic;
    if (typeof anthropic?.access === 'string' && anthropic.access) {
      out.push({
        kind: 'claude', name: 'OpenCode · Anthropic', source: 'file', credentialKind: 'oauth',
        credential: {
          kind: 'oauth', accessToken: anthropic.access,
          ...(typeof anthropic.refresh === 'string' ? { refreshToken: anthropic.refresh } : {}),
          ...(typeof anthropic.expires === 'number' ? { expiresAt: anthropic.expires } : {}),
        },
      });
    } else if (typeof anthropic?.key === 'string' && anthropic.key) {
      out.push(providerInput('anthropic', 'OpenCode · Anthropic', 'anthropic', 'https://api.anthropic.com', anthropic.key, 'x-api-key'));
    }
    const openai = auth.openai;
    if (typeof openai?.key === 'string' && openai.key) {
      out.push(providerInput('openai', 'OpenCode · OpenAI', 'openai', 'https://api.openai.com/v1', openai.key));
    }
    const google = auth.google ?? auth.gemini;
    if (typeof google?.key === 'string' && google.key) {
      out.push(providerInput('google', 'OpenCode · Google', 'gemini', 'https://generativelanguage.googleapis.com', google.key));
    }
    return out;
  }
  return [];
}

/**
 * A long-lived provider login refreshed without another browser round: Codex's OAuth refresh_token grant, or
 * Copilot's GitHub-token → Copilot-token exchange. Returns the updated envelope, or null when this provider has no
 * refresh path (the account is then reported expired and the user signs in again).
 */
export async function refreshProviderCredential(
  fetchImpl: typeof fetch,
  providerId: string,
  credential: Record<string, any>,
  now = Date.now(),
): Promise<Record<string, any> | null> {
  const def = loginDef(providerId);
  if (!def) return null;
  const refreshToken = typeof credential.refreshToken === 'string' ? credential.refreshToken : '';
  if (!refreshToken) return null;
  // GitHub → Copilot: the stored refresh token is the GitHub OAuth token
  if (def.account?.exchange === 'copilot') {
    const c = await exchangeCopilotToken(fetchImpl, refreshToken, def.device?.headers, now);
    return { ...credential, token: c.token, expiresAt: c.expiresAt, refreshToken };
  }
  // a device-code login (Grok) refreshes at its token endpoint like an OAuth one
  const oauth = def.oauth ?? (def.device ? { tokenUrl: def.device.tokenUrl, clientId: def.device.clientId, clientSecret: def.device.clientSecret, extraTokenParams: undefined, tokenAuth: undefined } : undefined);
  if (!oauth) return null;
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: oauth.clientId,
    ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
    ...(oauth.extraTokenParams ?? {}),
  };
  const headers: Record<string, string> = {};
  if (oauth.clientSecret && oauth.tokenAuth === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64')}`;
  }
  const r = await postForm(fetchImpl, oauth.tokenUrl, params, headers);
  if (!r.ok || r.json?.error || !(r.json?.access_token ?? r.json?.accessToken)) return null;
  const t = tokensFrom(r.json, now);
  return {
    ...credential,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? refreshToken,
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
  };
}

function providerInput(providerId: string, name: string, protocol: 'anthropic' | 'openai' | 'gemini', baseUrl: string, token: string, authStyle?: 'bearer' | 'x-api-key'): UpstreamAccountInput {
  return {
    kind: 'provider',
    providerId,
    name,
    source: 'file',
    credentialKind: 'token',
    credential: { kind: 'token', providerId, protocol, baseUrl, ...(authStyle ? { authStyle } : {}), token },
  };
}
