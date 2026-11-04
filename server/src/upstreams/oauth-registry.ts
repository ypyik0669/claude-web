// Provider logins (2026-10-28): the data behind `upstreams.login.*`. One entry per subscription sign-in the hub
// advertises. A definition never holds a credential — only the public/native OAuth client facts (client ids are
// public by construction: they ship inside the vendor's CLI / extension), the endpoints, and how a token becomes an
// upstream account.
//
// Honesty rule (the task that added this file): a vendor is only `available` when we have a public OAuth client, a
// device-code endpoint, a documented local credential file, or a paste-token path AND the result is a model endpoint
// the gateway can actually call. Everything else stays listed (the hub shows the descriptor) with a reason instead
// of a made-up flow. See the report in the task for the per-provider status.
import { tr } from '../i18n/index.js';
import type { ProviderAuth } from '../channels/providers/types.js';
import { GROK_CLI_BASE, GROK_CLI_HEADERS, XAI_CLIENT_ID, XAI_ISSUER, XAI_SCOPES } from './grok-sso.js';

export type LoginAuth = Extract<ProviderAuth, 'oauth-loopback' | 'device-code' | 'paste-token' | 'local-credential'>;
export type LoginMode = 'oauth' | 'device' | 'paste' | 'local';
export type ProviderProtocol = 'anthropic' | 'openai' | 'responses' | 'gemini';

export interface OAuthLoginConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Always true for this framework: every authorization-code login here is PKCE S256. */
  pkce: true;
  /** The vendor registered one fixed loopback callback (Codex: 1455). Unset = a random free port. */
  redirectPort?: number;
  redirectPath?: string;
  /** `localhost` when the vendor's registered callback spells it that way; the listener still binds 127.0.0.1. */
  redirectHost?: string;
  extraAuthParams?: Record<string, string>;
  /** Who the token belongs to (shown on the account row); absent = the id_token / vendor-specific default. */
  identityUrl?: string;
  /** POST body (default) or HTTP Basic for the client credential. */
  tokenAuth?: 'post' | 'basic';
  /** Included in the token request for vendors that require it (RFC 8707 style resource). */
  extraTokenParams?: Record<string, string>;
}

export interface DeviceLoginConfig {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Extra headers on both device and token requests (GitHub Copilot asks for its editor identity). */
  headers?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  /** Who the token belongs to (GitHub Copilot: /user). */
  identityUrl?: string;
}

export interface PasteLoginConfig {
  /** What the user must paste, in words. */
  placeholder: string;
  /** A login that is only a key (an API-key preset, not a subscription) can still ride this path. */
  credentialKind?: 'token' | 'password';
  /** what is pasted is turned into OAuth tokens first (Grok: the grok.com sso cookie → the Grok CLI's tokens) */
  convert?: 'grok-sso';
}

export type LocalReader = 'opencode-auth' | 'claude-credentials';

export interface LocalLoginConfig {
  reader: LocalReader;
  /** `~` is the user's home; `%VAR%` reads an environment variable (Windows). */
  paths: string[];
}

/** How a completed token becomes an `UpstreamAccountInput`. */
export interface LoginAccountMapping {
  kind: 'claude' | 'provider';
  /** providerId written on the account row (defaults to the login def's id) */
  providerId?: string;
  credentialKind: 'oauth' | 'token';
  /** The wire protocol the gateway will speak to this account. */
  protocol?: ProviderProtocol;
  baseUrl?: string;
  authStyle?: 'bearer' | 'x-api-key' | 'both';
  /** Extra request headers the vendor needs (Copilot's editor identity, Codex's originator…). */
  headers?: Record<string, string>;
  /** The upstream path for this account when the vendor does not use /v1/chat/completions or /v1/responses. */
  chatPath?: string;
  /** A second token exchange after the OAuth/device token (GitHub → Copilot). */
  exchange?: 'copilot';
  /** False when the login is real but the result cannot be used by the gateway. */
  usable: boolean;
  /** Why it is not usable (shown instead of a fake success). */
  reason?: string;
}

export interface ProviderLoginDef {
  id: string;
  name: string;
  auth: LoginAuth;
  docsUrl?: string;
  /** One user-visible sentence: what happens when this flow starts. */
  instructions: string;
  available: boolean;
  /** Required when unavailable. */
  reason?: string;
  oauth?: OAuthLoginConfig;
  device?: DeviceLoginConfig;
  paste?: PasteLoginConfig;
  local?: LocalLoginConfig;
  account?: LoginAccountMapping;
}

export interface ProviderLoginInfo {
  id: string;
  name: string;
  auth: LoginAuth;
  docsUrl?: string;
  instructions: string;
  available: boolean;
  reason?: string;
  modes: LoginMode[];
  /** what the paste box asks for, when it is not a plain token */
  pastePlaceholder?: string;
}

/**
 * Codex CLI's public OAuth app. The redirect is the CLI's fixed loopback callback; the ChatGPT backend only speaks
 * the Responses API, hence `protocol: 'responses'` and the `/responses` path.
 */
const CODEX_OAUTH: OAuthLoginConfig = {
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  pkce: true,
  redirectPort: 1455,
  redirectPath: '/auth/callback',
  redirectHost: 'localhost',
  extraAuthParams: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' },
};

/** GitHub Copilot: public VS Code device-flow client + the token exchange every Copilot client performs. */
const COPILOT_DEVICE: DeviceLoginConfig = {
  deviceAuthorizationUrl: 'https://github.com/login/device/code',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  clientId: 'Iv1.b507a08c87ecfe98',
  scopes: ['read:user'],
  headers: {
    accept: 'application/json',
    'editor-version': 'Neovim/0.6.1',
    'user-agent': 'GitHubCopilot/1.155.0',
  },
  identityUrl: 'https://api.github.com/user',
};

const COPILOT_HEADERS: Record<string, string> = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': 'Neovim/0.6.1',
  'user-agent': 'GitHubCopilot/1.155.0',
};

const unavailable = (reason: string) => ({ available: false, reason });

const defs: ProviderLoginDef[] = [
  // ---- actually usable ----
  {
    id: 'codex',
    name: 'Codex',
    auth: 'oauth-loopback',
    docsUrl: 'https://developers.openai.com/codex/',
    instructions: tr('在浏览器里登录 ChatGPT（Codex）。授权后会自动回来添加账号。'),
    available: true,
    oauth: CODEX_OAUTH,
    account: {
      kind: 'provider',
      providerId: 'codex',
      credentialKind: 'oauth',
      protocol: 'responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      authStyle: 'bearer',
      chatPath: '/responses',
      headers: { 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' },
      usable: true,
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    auth: 'device-code',
    docsUrl: 'https://github.com/features/copilot',
    instructions: tr('在 GitHub 页面输入下面的一次性代码完成登录。'),
    available: true,
    device: COPILOT_DEVICE,
    account: {
      kind: 'provider',
      providerId: 'copilot',
      credentialKind: 'token',
      protocol: 'openai',
      baseUrl: 'https://api.githubcopilot.com',
      authStyle: 'bearer',
      chatPath: '/chat/completions',
      headers: COPILOT_HEADERS,
      exchange: 'copilot',
      usable: true,
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    auth: 'local-credential',
    docsUrl: 'https://opencode.ai/',
    instructions: tr('从 OpenCode 的 auth.json 读取登录态：Anthropic 登录会变成 Claude 账号，OpenAI / Google 的 Key 变成对应的接口账号。'),
    available: true,
    local: {
      reader: 'opencode-auth',
      paths: [
        '%XDG_DATA_HOME%/opencode/auth.json',
        '~/.local/share/opencode/auth.json',
        '%APPDATA%/opencode/auth.json',
        '%LOCALAPPDATA%/opencode/auth.json',
      ],
    },
    account: { kind: 'provider', providerId: 'opencode', credentialKind: 'token', usable: true },
  },
  {
    id: 'claude',
    name: 'Claude',
    auth: 'local-credential',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code',
    instructions: tr('读取本机 Claude Code 的登录态（~/.claude/.credentials.json）。'),
    available: true,
    local: {
      reader: 'claude-credentials',
      paths: ['%CLAUDE_CONFIG_DIR%/.credentials.json', '~/.claude/.credentials.json'],
    },
    account: { kind: 'claude', credentialKind: 'oauth', usable: true },
  },

  // ---- listed, but deliberately not available (no public client / not a model endpoint) ----
  {
    id: 'gemini',
    name: 'Gemini',
    auth: 'oauth-loopback',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    instructions: tr('用 Google 账号登录 Gemini。'),
    ...unavailable(tr('Gemini 的订阅登录只对 Gemini CLI 开放（Code Assist 协议），网关不能直接调用。请用「Gemini 网页」账号。')),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    auth: 'oauth-loopback',
    docsUrl: 'https://antigravity.google/',
    instructions: tr('用 Google 账号登录 Antigravity。'),
    ...unavailable(tr('Antigravity 的登录只在其客户端内有效，且 Google 限制账号在 Antigravity 之外使用；没有可用的公开 OAuth 客户端。')),
  },
  {
    id: 'kimi',
    name: 'Kimi',
    auth: 'oauth-loopback',
    docsUrl: 'https://platform.moonshot.cn/',
    instructions: tr('用 Kimi 账号登录。'),
    ...unavailable(tr('Moonshot 没有公开的第三方 OAuth 客户端。请改用「Kimi API」Key（OpenAI / Anthropic 兼容接口）。')),
  },
  {
    // the Grok CLI's own login (xAI device authorization) → cli-chat-proxy.grok.com: the current models (Grok 4.7 …)
    // with native tool calling, on the user's grok.com plan. Or paste the grok.com sso cookie: grok-sso.ts walks the
    // same authorization with it.
    id: 'grok',
    name: 'Grok',
    auth: 'device-code',
    docsUrl: 'https://grok.com/',
    instructions: tr('用 grok.com 账号登录（Grok CLI 的登录），或粘贴 grok.com 的 sso cookie。能用 Grok 4.7 等最新模型。'),
    available: true,
    device: {
      deviceAuthorizationUrl: `${XAI_ISSUER}/oauth2/device/code`,
      tokenUrl: `${XAI_ISSUER}/oauth2/token`,
      clientId: XAI_CLIENT_ID,
      scopes: XAI_SCOPES,
    },
    paste: { placeholder: tr('grok.com 的 sso cookie（F12 → Application → Cookies → sso），或整段 Cookie'), convert: 'grok-sso' },
    account: {
      kind: 'provider',
      providerId: 'grok',
      credentialKind: 'oauth',
      protocol: 'openai',
      baseUrl: GROK_CLI_BASE,
      authStyle: 'bearer',
      chatPath: '/chat/completions',
      headers: GROK_CLI_HEADERS,
      usable: true,
    },
  },
  {
    id: 'devin',
    name: 'Devin',
    auth: 'paste-token',
    docsUrl: 'https://devin.ai/',
    instructions: tr('粘贴 Devin 的会话令牌。'),
    ...unavailable(tr('Devin 是软件工程代理服务，不是模型接口，不能作为网关上游。')),
  },
  {
    id: 'kiro',
    name: 'Kiro',
    auth: 'device-code',
    docsUrl: 'https://kiro.dev/',
    instructions: tr('在 AWS 页面输入一次性代码完成登录。'),
    ...unavailable(tr('Kiro 的 AWS SSO 设备码需要其私有客户端注册，且接口不是 OpenAI / Anthropic / Gemini 兼容。')),
  },
  {
    id: 'cline',
    name: 'Cline',
    auth: 'oauth-loopback',
    docsUrl: 'https://cline.bot/',
    instructions: tr('在浏览器里登录 Cline。'),
    ...unavailable(tr('Cline 的 OAuth 客户端没有公开，无法从 claude-web 发起登录。')),
  },
  {
    id: 'qoder',
    name: 'Qoder',
    auth: 'device-code',
    docsUrl: 'https://qoder.com/',
    instructions: tr('在 Qoder 页面输入一次性代码完成登录。'),
    ...unavailable(tr('Qoder 的设备码接口没有公开文档，且它的服务不是模型 API。')),
  },
  {
    id: 'trae',
    name: 'Trae',
    auth: 'local-credential',
    docsUrl: 'https://www.trae.ai/',
    instructions: tr('读取已安装 Trae 的登录态。'),
    ...unavailable(tr('Trae 的登录态是加密的、没有公开格式，且服务不是模型 API。')),
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    auth: 'paste-token',
    docsUrl: 'https://www.workbuddy.ai/',
    instructions: tr('使用 WorkBuddy 卡片里的扫码登录或粘贴 cockpit JSON。'),
    ...unavailable(tr('WorkBuddy 有自己的登录卡片（扫码 / cockpit JSON / 每日签到），请从「WorkBuddy」来源添加。')),
  },
  {
    id: 'zcode',
    name: 'ZCode',
    auth: 'device-code',
    docsUrl: 'https://zcode.z.ai/',
    instructions: tr('在 Z.ai 页面输入一次性代码完成登录。'),
    ...unavailable(tr('Z.ai 编程套餐使用 API Key，没有公开的设备码流程。请在 API Key 里添加 Z.ai。')),
  },
  {
    id: 'factory',
    name: 'Factory',
    auth: 'local-credential',
    docsUrl: 'https://factory.ai/',
    instructions: tr('读取本机 Factory / Droid 的凭据。'),
    ...unavailable(tr('Droid 的凭据是加密的，且没有公开的模型接口。')),
  },
  {
    id: 'mimo',
    name: 'Xiaomi MiMo',
    auth: 'paste-token',
    docsUrl: 'https://platform.xiaomimimo.com/',
    instructions: tr('粘贴小米 MiMo Token Plan 的令牌。'),
    ...unavailable(tr('小米 MiMo 的 Token Plan 没有公开的 OAuth / 设备码流程，也没有可核实的 OpenAI 兼容地址；不能凭空填一个接口。')),
  },
];

export const PROVIDER_LOGINS: readonly ProviderLoginDef[] = Object.freeze(defs.map((d) => Object.freeze(d)));

export function loginDef(id: string): ProviderLoginDef | undefined {
  return defs.find((d) => d.id === id);
}

export function loginModes(d: ProviderLoginDef): LoginMode[] {
  const out: LoginMode[] = [];
  if (d.oauth) out.push('oauth');
  if (d.device) out.push('device');
  if (d.paste || d.auth === 'paste-token') out.push('paste');
  if (d.local) out.push('local');
  return out;
}

export function loginInfos(): ProviderLoginInfo[] {
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    auth: d.auth,
    ...(d.docsUrl ? { docsUrl: d.docsUrl } : {}),
    instructions: d.instructions,
    available: d.available && (d.account?.usable ?? false),
    ...(d.available ? {} : { reason: d.reason ?? d.account?.reason ?? tr('这个来源还不能从 claude-web 登录') }),
    modes: loginModes(d),
    ...(d.paste?.placeholder ? { pastePlaceholder: d.paste.placeholder } : {}),
  }));
}

const HTTPS = /^https:\/\/[^\s]+$/;

/**
 * Structural validation. Returns readable problems (empty = every definition is coherent). Called by tests and at
 * service start (a broken definition must never open a login window that cannot work).
 */
export function validateLoginDefs(list: readonly ProviderLoginDef[] = PROVIDER_LOGINS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of list) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(d.id)) out.push(`${d.id}: invalid id`);
    if (seen.has(d.id)) out.push(`${d.id}: duplicate id`);
    seen.add(d.id);
    if (!d.name.trim()) out.push(`${d.id}: empty name`);
    if (!d.instructions.trim()) out.push(`${d.id}: no instructions`);
    if (!d.available && !d.reason?.trim()) out.push(`${d.id}: unavailable without a reason`);
    if (d.available && (!d.account || !d.account.usable)) out.push(`${d.id}: available without a usable account mapping`);
    if (d.account && d.account.kind === 'provider') {
      // OpenCode's reader builds one mapping per auth.json entry; the definition's mapping is only the "usable" flag.
      const perEntry = d.id === 'opencode';
      if (!d.account.providerId?.trim() && !perEntry) out.push(`${d.id}: provider mapping has no providerId`);
      if (!d.account.protocol && !perEntry) out.push(`${d.id}: provider mapping has no protocol`);
      if (d.account.protocol && !['anthropic', 'openai', 'responses', 'gemini'].includes(d.account.protocol)) out.push(`${d.id}: unknown protocol ${d.account.protocol}`);
      if (!d.account.baseUrl?.trim() && !perEntry) out.push(`${d.id}: provider mapping has no baseUrl`);
      if (d.account.baseUrl && !HTTPS.test(d.account.baseUrl)) out.push(`${d.id}: baseUrl must be https`);
      if (d.account.chatPath && !d.account.chatPath.startsWith('/')) out.push(`${d.id}: chatPath must start with /`);
    }
    if (d.auth === 'oauth-loopback' && d.available) {
      const o = d.oauth;
      if (!o) out.push(`${d.id}: oauth-loopback without oauth config`);
      else {
        if (!HTTPS.test(o.authorizationUrl)) out.push(`${d.id}: authorizationUrl must be https`);
        if (!HTTPS.test(o.tokenUrl)) out.push(`${d.id}: tokenUrl must be https`);
        if (!o.clientId.trim()) out.push(`${d.id}: empty clientId`);
        if (!o.scopes.length) out.push(`${d.id}: no scopes`);
        if (o.pkce !== true) out.push(`${d.id}: loopback login must use PKCE`);
        if (o.redirectPort !== undefined && (!Number.isInteger(o.redirectPort) || o.redirectPort < 1024 || o.redirectPort > 65535)) out.push(`${d.id}: invalid redirectPort`);
        if (o.redirectPath && !o.redirectPath.startsWith('/')) out.push(`${d.id}: redirectPath must start with /`);
      }
    }
    if (d.auth === 'device-code' && d.available) {
      const v = d.device;
      if (!v) out.push(`${d.id}: device-code without device config`);
      else {
        if (!HTTPS.test(v.deviceAuthorizationUrl)) out.push(`${d.id}: deviceAuthorizationUrl must be https`);
        if (!HTTPS.test(v.tokenUrl)) out.push(`${d.id}: tokenUrl must be https`);
        if (!v.clientId.trim()) out.push(`${d.id}: empty clientId`);
        if (!v.scopes.length) out.push(`${d.id}: no scopes`);
      }
    }
    if (d.auth === 'paste-token' && d.available && !d.paste) out.push(`${d.id}: paste-token without paste config`);
    if (d.auth === 'local-credential' && d.available && (!d.local || !d.local.paths.length)) out.push(`${d.id}: local-credential without paths`);
  }
  return out;
}
