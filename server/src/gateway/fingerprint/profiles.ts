// Client fingerprint profiles: what the official CLIs put on the wire, so a subscription upstream (or a relay that only
// lets the official client through) sees the request shape it expects. Ported from CLIProxyAPI (MIT):
// internal/runtime/executor/helps/utls_client.go (Claude Code ClientHello + header order), claude_executor_request.go
// (identity headers), codex_executor_request.go (Codex UA / originator). Versions are data: bump them together with a
// fresh capture of the real client.
import type { Outbound } from '../convert.js';
import { claudeCodeVersion } from '../../claude-version.js';

export type ProfileId = 'claude-code' | 'codex' | 'gemini-cli';
export const PROFILE_IDS: readonly ProfileId[] = ['claude-code', 'codex', 'gemini-cli'];

/** One header the profile puts on a request: `set` always wins, `ensure` only fills a missing one (a real client's value stays). */
export interface IdentityHeader { name: string; value: string; mode: 'set' | 'ensure' }

/** Node `tls.connect` options approximating the client's ClientHello (OpenSSL can't do extension order / GREASE / padding). */
export interface NodeTlsShape {
  /** OpenSSL cipher string, TLS 1.3 suites first; undefined = Node's default list (the client *is* Node) */
  ciphers?: string;
  sigalgs?: string;
  ecdhCurve?: string;
  minVersion: 'TLSv1.2' | 'TLSv1.3';
  maxVersion: 'TLSv1.2' | 'TLSv1.3';
  /** always http/1.1 here: the gateway speaks HTTP/1.1, offering h2 and then not speaking it would break */
  ALPNProtocols: string[];
  /** status_request (OCSP stapling) in the ClientHello */
  requestOCSP?: boolean;
}

export interface Profile {
  id: ProfileId;
  /** the wire protocols whose headers / body this profile shapes (TLS applies whatever the protocol) */
  outbounds: readonly Outbound[];
  /** prefix of the real client's User-Agent: a passthrough request that already carries it keeps its own version */
  uaPrefix: RegExp;
  userAgent: string;
  identity: (ctx: { path: string; stream: boolean }) => IdentityHeader[];
  /** wire header order (names compared case-insensitively; the casing here is what goes out). Unlisted headers follow, in their own order. */
  headerOrder: (path: string) => readonly string[];
  /** top-level JSON body key order; unlisted keys follow in their own order */
  bodyOrder: readonly string[];
  tls: NodeTlsShape;
  /** the tlsfp helper has a uTLS ClientHello for this client (false: Node itself is the client, its TLS is already right) */
  helper: boolean;
}

function osName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'MacOS' : platform === 'linux' ? 'Linux' : `Other::${platform}`;
}
function archName(arch: string = process.arch): string {
  return arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x32' : `other::${arch}`;
}

// ---- Claude Code CLI (version: the newest known, claude-version.ts; @anthropic-ai/sdk 0.112.1) ----

const CLAUDE_SDK_VERSION = '0.112.1';
const CLAUDE_RUNTIME_VERSION = 'v26.3.0';

const CLAUDE_HEADER_HEAD = [
  'Accept', 'Authorization', 'X-Api-Key', 'Content-Type', 'User-Agent', 'X-Claude-Code-Session-Id',
  'X-Stainless-Arch', 'X-Stainless-Lang', 'X-Stainless-OS', 'X-Stainless-Package-Version', 'X-Stainless-Retry-Count',
  'X-Stainless-Runtime', 'X-Stainless-Runtime-Version',
] as const;
const CLAUDE_HEADER_TAIL = [
  'anthropic-beta', 'anthropic-dangerous-direct-browser-access', 'anthropic-version', 'x-app', 'x-client-request-id',
  'Connection', 'Host', 'Accept-Encoding', 'Content-Length',
] as const;
const CLAUDE_MESSAGES_ORDER = [...CLAUDE_HEADER_HEAD, 'X-Stainless-Timeout', ...CLAUDE_HEADER_TAIL];
const CLAUDE_COUNT_ORDER = [...CLAUDE_HEADER_HEAD, ...CLAUDE_HEADER_TAIL];

const isCount = (path: string) => /\/messages\/count_tokens\b/.test(path);

const claudeCode: Profile = {
  id: 'claude-code',
  outbounds: ['anthropic'],
  uaPrefix: /^claude-cli\//i,
  // a getter: Anthropic gates new models on this version, so it follows the newest Claude Code (claude-version.ts)
  get userAgent() { return `claude-cli/${claudeCodeVersion()} (external, cli)`; },
  identity: ({ path }) => [
    { name: 'Accept', value: 'application/json', mode: 'ensure' },
    { name: 'anthropic-version', value: '2023-06-01', mode: 'ensure' },
    { name: 'anthropic-dangerous-direct-browser-access', value: 'true', mode: 'set' },
    { name: 'x-app', value: 'cli', mode: 'set' },
    { name: 'X-Stainless-Arch', value: archName(), mode: 'ensure' },
    { name: 'X-Stainless-Lang', value: 'js', mode: 'set' },
    { name: 'X-Stainless-OS', value: osName(), mode: 'ensure' },
    { name: 'X-Stainless-Package-Version', value: CLAUDE_SDK_VERSION, mode: 'ensure' },
    { name: 'X-Stainless-Retry-Count', value: '0', mode: 'ensure' },
    { name: 'X-Stainless-Runtime', value: 'node', mode: 'set' },
    { name: 'X-Stainless-Runtime-Version', value: CLAUDE_RUNTIME_VERSION, mode: 'ensure' },
    // Claude Code leaves the timeout off count_tokens
    ...(isCount(path) ? [] : [{ name: 'X-Stainless-Timeout', value: '600', mode: 'ensure' as const }]),
  ],
  headerOrder: (path) => (isCount(path) ? CLAUDE_COUNT_ORDER : CLAUDE_MESSAGES_ORDER),
  // a native /v1/messages body: {"model","messages","system","tools","metadata","max_tokens","thinking",…,"stream"}
  bodyOrder: ['model', 'messages', 'system', 'tools', 'tool_choice', 'metadata', 'max_tokens', 'thinking', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'context_management', 'output_config', 'mcp_servers', 'container', 'stream'],
  tls: {
    // the Node/OpenSSL ClientHello Claude Code sends (CPA claudeCodeTLSClientHelloSpec), cipher by cipher
    ciphers: [
      'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-ECDSA-AES128-SHA', 'ECDHE-RSA-AES128-SHA', 'ECDHE-ECDSA-AES256-SHA', 'ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
    ].join(':'),
    sigalgs: [
      'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256', 'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384',
      'rsa_pkcs1_sha384', 'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512', 'rsa_pkcs1_sha1',
    ].join(':'),
    ecdhCurve: 'X25519:P-256:P-384',
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ALPNProtocols: ['http/1.1'],
    requestOCSP: true,
  },
  helper: true,
};

// ---- Codex CLI (codex-tui 0.154.0; Rust: reqwest + rustls, lowercase header names) ----

const CODEX_VERSION = '0.154.0';

const codex: Profile = {
  id: 'codex',
  outbounds: ['responses', 'openai'],
  uaPrefix: /^(codex[-_](tui|cli_rs|exec)|codex_vscode)\//i,
  userAgent: `codex-tui/${CODEX_VERSION} (${osName() === 'MacOS' ? 'Mac OS' : osName()}; ${process.arch === 'x64' ? 'x86_64' : process.arch}) (codex-tui; ${CODEX_VERSION})`,
  identity: () => [
    { name: 'originator', value: 'codex-tui', mode: 'ensure' },
  ],
  headerOrder: () => [
    'authorization', 'chatgpt-account-id', 'originator', 'user-agent', 'version', 'session_id', 'x-codex-turn-metadata',
    'x-client-request-id', 'openai-beta', 'accept', 'content-type', 'accept-encoding', 'content-length', 'host',
  ],
  // codex-rs ResponsesApiRequest field order
  bodyOrder: ['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'stream', 'include', 'service_tier', 'prompt_cache_key', 'text', 'client_metadata'],
  tls: {
    // rustls' default suites and groups (its ClientHello also offers h2; we speak HTTP/1.1, so only http/1.1)
    ciphers: [
      'TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256', 'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-RSA-CHACHA20-POLY1305',
    ].join(':'),
    sigalgs: [
      'ecdsa_secp384r1_sha384', 'ecdsa_secp256r1_sha256', 'ed25519', 'rsa_pss_rsae_sha512', 'rsa_pss_rsae_sha384',
      'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha512', 'rsa_pkcs1_sha384', 'rsa_pkcs1_sha256',
    ].join(':'),
    ecdhCurve: 'X25519:P-256:P-384',
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ALPNProtocols: ['http/1.1'],
  },
  helper: true,
};

// ---- Gemini CLI (Node + @google/genai over undici fetch) ----

const GEMINI_CLI_VERSION = '0.12.0';
const GENAI_SDK_VERSION = '1.30.0';
const nodeTag = `gl-node/${process.version}`;

const geminiCli: Profile = {
  id: 'gemini-cli',
  outbounds: ['gemini'],
  uaPrefix: /^GeminiCLI\//,
  userAgent: `GeminiCLI/${GEMINI_CLI_VERSION} (${process.platform}; ${process.arch}) google-genai-sdk/${GENAI_SDK_VERSION} ${nodeTag}`,
  identity: () => [
    { name: 'x-goog-api-client', value: `google-genai-sdk/${GENAI_SDK_VERSION} ${nodeTag}`, mode: 'ensure' },
    { name: 'accept', value: '*/*', mode: 'ensure' },
    { name: 'accept-language', value: '*', mode: 'ensure' },
    { name: 'sec-fetch-mode', value: 'cors', mode: 'ensure' },
  ],
  // undici writes host / connection first, then the request's headers, then what fetch adds
  headerOrder: () => [
    'host', 'connection', 'content-type', 'user-agent', 'x-goog-api-client', 'x-goog-api-key', 'authorization',
    'accept', 'accept-language', 'sec-fetch-mode', 'accept-encoding', 'content-length',
  ],
  bodyOrder: ['contents', 'systemInstruction', 'cachedContent', 'tools', 'toolConfig', 'safetySettings', 'generationConfig', 'labels'],
  // the real client is Node: Node's own defaults are its ClientHello (undici offers only http/1.1)
  tls: { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] },
  helper: false,
};

export const PROFILES: Record<ProfileId, Profile> = { 'claude-code': claudeCode, codex, 'gemini-cli': geminiCli };

/** The profile 'auto' picks for a wire protocol; null = none fits (an OpenAI chat-completions endpoint). */
export function autoProfile(outbound: Outbound, opts: { protocol?: string; chatPath?: string } = {}): ProfileId | null {
  if (outbound === 'anthropic') return 'claude-code';
  if (outbound === 'responses') return 'codex';
  if (outbound === 'gemini') return 'gemini-cli';
  if (opts.protocol === 'responses' || /\/responses\b/.test(opts.chatPath ?? '')) return 'codex';
  return null;
}
