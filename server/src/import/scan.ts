import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

/**
 * 从其它工具导入 (2026-10-17 user request: 「Hermes 的配置迁移到你的项目」, and Mirasim, and every other IDE / agent):
 * what other tools on this computer have configured that this app can use — model providers (an endpoint, its key,
 * its models) and MCP servers. Everything here only reads: each tool's own files, cc-switch's database through a
 * copy. Keys never leave the server (the wire gets `hasKey`); an import re-reads and takes the picked keys.
 * Only Anthropic-format providers come out of a scan (this app talks to Claude only): the readers still recognise
 * the other formats a tool keeps, so those are told apart and left behind (`scanAll`).
 */

export type SourceId =
  | 'hermes' | 'cc-switch' | 'codex' | 'opencode' | 'gemini' | 'qwen' | 'cursor' | 'windsurf' | 'kiro' | 'claude-desktop'
  | 'vscode' | 'cline' | 'roo' | 'continue' | 'zed' | 'goose' | 'ollama' | 'mirasim' | 'cherry-studio'
  | 'vscode-insiders' | 'vscodium' | 'trae' | 'antigravity' | 'lmstudio' | 'pencil';

export interface FoundProvider {
  kind: 'provider';
  /** stable across scans: what an import names */
  key: string;
  from: SourceId;
  name: string;
  /** the format the tool keeps it in; only 'anthropic' ones leave scanAll */
  type: 'anthropic' | 'openai' | 'gemini' | 'grok';
  baseUrl: string;
  apiKey: string;
  models?: string[];
  defaultModel?: string;
  modelMap?: { haiku?: string; sonnet?: string; opus?: string };
}

export type McpConfig = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export interface FoundMcp { kind: 'mcp'; key: string; from: SourceId; name: string; config: McpConfig }

export type Found = FoundProvider | FoundMcp;

/** A tool whose settings are there but cannot be read as plain files (encrypted, a browser database). */
export interface Unreadable { from: SourceId; reason: 'encrypted' | 'browser-db' }

/** What a scan hands out: MCP servers, and the Anthropic-format providers. */
export type Usable = FoundMcp | (FoundProvider & { type: 'anthropic' });

export interface ScanResult { found: Usable[]; unreadable: Unreadable[]; scanned: SourceId[] }

export interface Where { home: string; appData: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; arch?: string }

export function where(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): Where {
  const appData = platform === 'win32' ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return { home, appData, env, platform };
}

// ---------------------------------------------------------------------------------------------------- helpers

const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const json = (p: string): any => { const t = read(p); if (t === null) return null; const v = parseJsonc(t, [], { allowTrailingComma: true }); return v && typeof v === 'object' ? v : null; };
const yaml = (p: string): any => { const t = read(p); if (t === null) return null; try { const v = parseYaml(t); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const toml = (p: string): any => { const t = read(p); if (t === null) return null; try { return parseToml(t); } catch { return null; } };
const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };
const firstExisting = (paths: string[]): string | null => paths.find((p) => exists(p)) ?? null;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const record = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = String(x);
  return out;
};

/** A `KEY=value` file (`.env`), quotes stripped, comments skipped. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v) out[m[1]] = v;
  }
  return out;
}

/** Any of the shapes tools write an MCP server in → ours; null when it is neither a command nor a URL. */
export function mcpOf(v: any): McpConfig | null {
  if (!v || typeof v !== 'object') return null;
  if (v.disabled === true || v.enabled === false) return null;
  const url = str(v.url) || str(v.serverUrl) || str(v.httpUrl);
  // SSE when said so, or (Cursor, Claude Desktop write only a URL) when the path ends in /sse
  const declared = str(v.type) || str(v.transport);
  const sse = declared ? /\bsse\b/i.test(declared) : /\/sse\/?(\?|$)/i.test(url);
  if (url) return { type: sse ? 'sse' : 'http', url, ...(Object.keys(record(v.headers)).length ? { headers: record(v.headers) } : {}) };
  // OpenCode keeps the command and its arguments in one array; Zed nests them under `command: { path, args }`
  const cmdArr = Array.isArray(v.command) ? strs(v.command) : [];
  const nested = v.command && typeof v.command === 'object' && !Array.isArray(v.command) ? v.command : null;
  const command = cmdArr[0] ?? (str(v.command) || str(nested?.path) || str(v.cmd));
  if (!command) return null;
  const args = cmdArr.length ? cmdArr.slice(1) : strs(v.args ?? nested?.args);
  const env = record(v.env ?? v.environment ?? v.envs ?? nested?.env);
  return { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
}

function mcpMap(from: SourceId, v: any, out: Found[]) {
  if (!v || typeof v !== 'object') return;
  for (const [name, conf] of Array.isArray(v) ? v.map((x: any) => [str(x?.name), x] as const) : Object.entries(v)) {
    const config = mcpOf(conf);
    if (name && config) out.push({ kind: 'mcp', key: `${from}:mcp:${name}`, from, name, config });
  }
}

/** The usual endpoint of a provider named by an environment variable or an id (Hermes, OpenCode, Continue, Aider…). */
export const KNOWN: Record<string, { name: string; type: FoundProvider['type']; baseUrl: string; env: string[] }> = {
  anthropic: { name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', env: ['ANTHROPIC_API_KEY'] },
  openai: { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', env: ['OPENAI_API_KEY'] },
  openrouter: { name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', env: ['OPENROUTER_API_KEY'] },
  gemini: { name: 'Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  google: { name: 'Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', env: [] },
  deepseek: { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', env: ['DEEPSEEK_API_KEY'] },
  xai: { name: 'xAI', type: 'grok', baseUrl: 'https://api.x.ai/v1', env: ['XAI_API_KEY', 'GROK_API_KEY'] },
  moonshot: { name: 'Kimi', type: 'openai', baseUrl: 'https://api.moonshot.ai/v1', env: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
  zai: { name: 'Z.ai (GLM)', type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', env: ['GLM_API_KEY', 'ZAI_API_KEY', 'ZHIPU_API_KEY'] },
  minimax: { name: 'MiniMax', type: 'openai', baseUrl: 'https://api.minimax.io/v1', env: ['MINIMAX_API_KEY'] },
  nous: { name: 'Nous Portal', type: 'openai', baseUrl: 'https://inference-api.nousresearch.com/v1', env: ['NOUS_API_KEY'] },
  groq: { name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'] },
  mistral: { name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', env: ['MISTRAL_API_KEY'] },
  together: { name: 'Together', type: 'openai', baseUrl: 'https://api.together.xyz/v1', env: ['TOGETHER_API_KEY'] },
  fireworks: { name: 'Fireworks', type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', env: ['FIREWORKS_API_KEY'] },
  dashscope: { name: 'Qwen (DashScope)', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: ['DASHSCOPE_API_KEY'] },
  siliconflow: { name: 'SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', env: ['SILICONFLOW_API_KEY'] },
  huggingface: { name: 'Hugging Face', type: 'openai', baseUrl: 'https://router.huggingface.co/v1', env: ['HF_TOKEN'] },
};
const KNOWN_BY_ENV = new Map(Object.entries(KNOWN).flatMap(([id, k]) => k.env.map((e) => [e, id] as const)));

/** A provider from a kind name ('openrouter', 'anthropic'…), an optional base URL and a key. */
function fromKnown(from: SourceId, id: string, apiKey: string, o: { baseUrl?: string; models?: string[]; defaultModel?: string; name?: string } = {}): FoundProvider | null {
  const k = KNOWN[id.toLowerCase()];
  const baseUrl = o.baseUrl || k?.baseUrl;
  if (!baseUrl || !apiKey) return null;
  return { kind: 'provider', key: `${from}:provider:${id}:${baseUrl}`, from, name: o.name || k?.name || id, type: k?.type ?? 'openai', baseUrl, apiKey, ...(o.models?.length ? { models: o.models } : {}), ...(o.defaultModel ? { defaultModel: o.defaultModel } : {}) };
}

/** Claude Code-style env (cc-switch's Claude providers): base URL, token, the three family models. */
function fromClaudeEnv(from: SourceId, id: string, name: string, env: Record<string, string>): FoundProvider | null {
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const modelMap = { haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_SMALL_FAST_MODEL, sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL, opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL };
  const models = [...new Set([env.ANTHROPIC_MODEL, modelMap.opus, modelMap.sonnet, modelMap.haiku].filter((m): m is string => !!m))];
  const mm = Object.fromEntries(Object.entries(modelMap).filter(([, v]) => v)) as FoundProvider['modelMap'];
  return { kind: 'provider', key: `${from}:provider:${id}`, from, name, type: 'anthropic', baseUrl, apiKey, ...(models.length ? { models, defaultModel: env.ANTHROPIC_MODEL || models[0] } : {}), ...(mm && Object.keys(mm).length ? { modelMap: mm } : {}) };
}

/** Codex's `[model_providers.<id>]` tables (+ the key from auth.json / an env name). */
function fromCodexToml(from: SourceId, conf: any, authKey: string, env: NodeJS.ProcessEnv, prefix = ''): FoundProvider[] {
  const out: FoundProvider[] = [];
  const mp = conf?.model_providers;
  if (!mp || typeof mp !== 'object') return out;
  for (const [id, p] of Object.entries<any>(mp)) {
    const baseUrl = str(p?.base_url);
    const apiKey = str(p?.experimental_bearer_token) || (str(p?.env_key) ? str(env[str(p.env_key)]) : '') || authKey;
    if (!baseUrl || !apiKey) continue;
    const model = conf.model_provider === id ? str(conf.model) : '';
    out.push({ kind: 'provider', key: `${from}:provider:${prefix}${id}`, from, name: str(p?.name) || id, type: 'openai', baseUrl, apiKey, ...(model ? { models: [model], defaultModel: model } : {}) });
  }
  return out;
}

/** A VS Code-style `User` folder: mcp.json (`servers`) and the older settings.json `mcp.servers`. */
function vscodeUser(from: SourceId, user: string, out: Found[]) {
  mcpMap(from, json(path.join(user, 'mcp.json'))?.servers, out);
  const s = json(path.join(user, 'settings.json'));
  mcpMap(from, s?.['mcp']?.servers ?? s?.['mcp.servers'], out);
}
/** Every VS Code-style editor's `User` folder (extensions like Cline keep their settings in its globalStorage). */
const editorUsers = (w: Where) =>
  ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Trae', 'Trae CN', 'Antigravity', 'Kiro'].map((d) => path.join(w.appData, d, 'User'));

// ---------------------------------------------------------------------------------------------------- sources

type Scan = (w: Where, out: Found[], unreadable: Unreadable[]) => void | Promise<void>;

const SOURCES: Record<SourceId, Scan> = {
  /** Hermes Agent (Nous Research): ~/.hermes/config.yaml (model, custom_providers, mcp_servers) + ~/.hermes/.env (keys) */
  hermes: (w, out) => {
    const dir = w.env.HERMES_HOME || path.join(w.home, '.hermes');
    const conf = yaml(path.join(dir, 'config.yaml')) ?? {};
    const env = parseDotenv(read(path.join(dir, '.env')) ?? '');
    const model = conf.model && typeof conf.model === 'object' ? conf.model : { default: conf.model };
    const defaultModel = str(model.default) || str(model.model);
    const seen = new Set<string>();
    const add = (p: FoundProvider | null) => { if (p && !seen.has(p.key)) { seen.add(p.key); out.push(p); } };
    // the main model's own endpoint, when it names one
    const baseUrl = str(model.base_url) || env.OPENAI_BASE_URL;
    const provider = str(model.provider).toLowerCase();
    if (baseUrl) add(fromKnown('hermes', provider && provider !== 'auto' && provider !== 'custom' ? provider : 'custom', str(model.api_key) || env.OPENAI_API_KEY || env.OPENROUTER_API_KEY, { baseUrl, defaultModel, models: defaultModel ? [defaultModel] : [], name: str(model.name) || 'Hermes' }));
    for (const c of Array.isArray(conf.custom_providers) ? conf.custom_providers : []) {
      const key = str(c?.api_key) || (str(c?.api_key_env) ? env[str(c.api_key_env)] ?? str(w.env[str(c.api_key_env)]) : '');
      const m = str(c?.model);
      add(fromKnown('hermes', str(c?.name) || 'custom', key, { baseUrl: str(c?.base_url), name: str(c?.name), ...(m ? { models: [m], defaultModel: m } : {}) }));
    }
    for (const [k, v] of Object.entries(env)) {
      const id = KNOWN_BY_ENV.get(k);
      if (id) add(fromKnown('hermes', id, v, provider === id && defaultModel ? { defaultModel, models: [defaultModel] } : {}));
    }
    mcpMap('hermes', conf.mcp_servers, out);
  },

  /** cc-switch: providers of every app it switches (Claude, Codex, Gemini, OpenCode, Hermes) and its MCP list */
  'cc-switch': (w, out) => {
    const db = path.join(w.home, '.cc-switch', 'cc-switch.db');
    if (!exists(db)) return;
    // a copy: the database may hold a hot journal, which even a read-only open would roll back in place
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ccs-'));
    try {
      fs.copyFileSync(db, path.join(tmp, 'c.db'));
      try { fs.copyFileSync(`${db}-journal`, path.join(tmp, 'c.db-journal')); } catch { /* none */ }
      try { fs.copyFileSync(`${db}-wal`, path.join(tmp, 'c.db-wal')); } catch { /* none */ }
      const d = new DatabaseSync(path.join(tmp, 'c.db'));
      try {
        const rows = d.prepare('SELECT id, app_type, name, settings_config FROM providers').all() as { id: string; app_type: string; name: string; settings_config: string }[];
        for (const r of rows) {
          let sc: any = {};
          try { sc = JSON.parse(r.settings_config); } catch { continue; }
          const env = record(sc?.env);
          const id = `${r.app_type}:${r.id}`;
          if (r.app_type === 'claude') { const p = fromClaudeEnv('cc-switch', id, r.name, env); if (p) out.push(p); continue; }
          if (r.app_type === 'codex') {
            const conf = typeof sc?.config === 'string' ? (() => { try { return parseToml(sc.config); } catch { return null; } })() : sc?.config;
            const authKey = str(sc?.auth?.OPENAI_API_KEY);
            for (const p of fromCodexToml('cc-switch', conf, authKey, {}, `${id}:`)) out.push({ ...p, name: r.name });
            continue;
          }
          if (r.app_type === 'gemini') {
            const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
            if (apiKey) out.push({ kind: 'provider', key: `cc-switch:provider:${id}`, from: 'cc-switch', name: r.name, type: 'gemini', baseUrl: env.GOOGLE_GEMINI_BASE_URL || KNOWN.gemini.baseUrl, apiKey, ...(env.GEMINI_MODEL ? { models: [env.GEMINI_MODEL], defaultModel: env.GEMINI_MODEL } : {}) });
            continue;
          }
          // OpenCode / Hermes providers: an OpenAI-compatible endpoint under whichever names the app uses
          const baseUrl = str(sc?.options?.baseURL) || str(sc?.base_url) || str(sc?.baseUrl) || env.OPENAI_BASE_URL;
          const apiKey = str(sc?.options?.apiKey) || str(sc?.api_key) || str(sc?.apiKey) || env.OPENAI_API_KEY;
          const models = sc?.models && typeof sc.models === 'object' ? (Array.isArray(sc.models) ? strs(sc.models) : Object.keys(sc.models)) : [];
          if (baseUrl && apiKey) out.push({ kind: 'provider', key: `cc-switch:provider:${id}`, from: 'cc-switch', name: r.name, type: 'openai', baseUrl, apiKey, ...(models.length ? { models, defaultModel: models[0] } : {}) });
        }
        const servers = d.prepare('SELECT name, server_config FROM mcp_servers').all() as { name: string; server_config: string }[];
        for (const s of servers) {
          let c: any = null;
          try { c = JSON.parse(s.server_config); } catch { continue; }
          const config = mcpOf(c);
          if (config && s.name) out.push({ kind: 'mcp', key: `cc-switch:mcp:${s.name}`, from: 'cc-switch', name: s.name, config });
        }
      } finally { d.close(); }
    } catch { /* an older layout or a locked file: nothing from it */ } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },

  /** Codex: ~/.codex/config.toml (model_providers, mcp_servers) + auth.json (OPENAI_API_KEY) */
  codex: (w, out) => {
    const dir = w.env.CODEX_HOME || path.join(w.home, '.codex');
    const conf = toml(path.join(dir, 'config.toml'));
    if (!conf) return;
    const authKey = str(json(path.join(dir, 'auth.json'))?.OPENAI_API_KEY);
    out.push(...fromCodexToml('codex', conf, authKey, w.env));
    mcpMap('codex', conf.mcp_servers, out);
  },

  /** OpenCode: opencode.json(c) `provider` (+ keys in auth.json) and `mcp` */
  opencode: (w, out) => {
    const dir = path.join(w.home, '.config', 'opencode');
    const conf = json(path.join(dir, 'opencode.json')) ?? json(path.join(dir, 'opencode.jsonc'));
    const auth = json(path.join(w.home, '.local', 'share', 'opencode', 'auth.json')) ?? {};
    const keyOf = (id: string) => str(auth?.[id]?.key);
    const providers = conf?.provider && typeof conf.provider === 'object' ? conf.provider : {};
    const named = new Set<string>();
    for (const [id, p] of Object.entries<any>(providers)) {
      named.add(id);
      const models = p?.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
      const baseUrl = str(p?.options?.baseURL);
      const apiKey = str(p?.options?.apiKey).replace(/^\{env:([^}]+)\}$/, (_m, n) => str(w.env[n])) || keyOf(id);
      const known = KNOWN[id];
      const type: FoundProvider['type'] = /anthropic/.test(str(p?.npm)) || id === 'anthropic' ? 'anthropic' : /google/.test(str(p?.npm)) || id === 'google' ? 'gemini' : known?.type ?? 'openai';
      if ((baseUrl || known) && apiKey) out.push({ kind: 'provider', key: `opencode:provider:${id}`, from: 'opencode', name: str(p?.name) || known?.name || id, type, baseUrl: baseUrl || known!.baseUrl, apiKey, ...(models.length ? { models, defaultModel: models[0] } : {}) });
    }
    // keys logged in for a built-in provider (`opencode auth login`) with no block of its own in the config
    for (const id of Object.keys(auth ?? {})) if (!named.has(id) && auth[id]?.type === 'api') { const p = fromKnown('opencode', id, keyOf(id)); if (p) out.push(p); }
    mcpMap('opencode', conf?.mcp, out);
  },

  gemini: (w, out) => mcpMap('gemini', json(path.join(w.home, '.gemini', 'settings.json'))?.mcpServers, out),
  qwen: (w, out) => mcpMap('qwen', json(path.join(w.home, '.qwen', 'settings.json'))?.mcpServers, out),
  cursor: (w, out) => mcpMap('cursor', json(path.join(w.home, '.cursor', 'mcp.json'))?.mcpServers, out),
  windsurf: (w, out) => mcpMap('windsurf', json(path.join(w.home, '.codeium', 'windsurf', 'mcp_config.json'))?.mcpServers, out),
  kiro: (w, out) => mcpMap('kiro', json(path.join(w.home, '.kiro', 'settings', 'mcp.json'))?.mcpServers, out),
  'claude-desktop': (w, out) => mcpMap('claude-desktop', json(path.join(w.appData, 'Claude', 'claude_desktop_config.json'))?.mcpServers, out),
  /** VS Code: the user's mcp.json (`servers`) and the older settings.json `mcp.servers` */
  vscode: (w, out) => vscodeUser('vscode', path.join(w.appData, 'Code', 'User'), out),
  'vscode-insiders': (w, out) => vscodeUser('vscode-insiders', path.join(w.appData, 'Code - Insiders', 'User'), out),
  vscodium: (w, out) => vscodeUser('vscodium', path.join(w.appData, 'VSCodium', 'User'), out),
  trae: (w, out) => { for (const d of ['Trae', 'Trae CN']) vscodeUser('trae', path.join(w.appData, d, 'User'), out); },
  /** Antigravity (Google): its own mcp_config.json, and the VS Code-style User folder */
  antigravity: (w, out) => {
    mcpMap('antigravity', json(path.join(w.home, '.gemini', 'antigravity', 'mcp_config.json'))?.mcpServers, out);
    vscodeUser('antigravity', path.join(w.appData, 'Antigravity', 'User'), out);
  },
  /** Cline / Roo Code: in VS Code and in every fork they can be installed into */
  cline: (w, out) => { for (const u of editorUsers(w)) mcpMap('cline', json(path.join(u, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'))?.mcpServers, out); },
  roo: (w, out) => { for (const u of editorUsers(w)) mcpMap('roo', json(path.join(u, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'))?.mcpServers, out); },
  lmstudio: (w, out) => mcpMap('lmstudio', json(path.join(w.home, '.lmstudio', 'mcp.json'))?.mcpServers, out),
  /**
   * Pencil (pencil.dev) keeps a copy of its MCP server per host app in ~/.pencil/mcp/<app>/out/ — unlike the
   * entries its extension writes into other tools, the path has no version in it, so it survives an update.
   */
  pencil: (w, out) => {
    const root = path.join(w.home, '.pencil', 'mcp');
    let apps: string[] = [];
    try { apps = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return; }
    const os_ = w.platform === 'win32' ? 'windows' : w.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = w.arch ?? process.arch;
    const found: { app: string; exe: string }[] = [];
    for (const app of apps) {
      const dir = path.join(root, app, 'out');
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((f) => f.startsWith(`mcp-server-${os_}-`) && (w.platform !== 'win32' || f.endsWith('.exe'))).sort(); } catch { continue; }
      const exe = files.find((f) => f.startsWith(`mcp-server-${os_}-${arch}`)) ?? files[0];
      if (exe) found.push({ app, exe: path.join(dir, exe) });
    }
    for (const { app, exe } of found) {
      out.push({ kind: 'mcp', key: `pencil:mcp:${app}`, from: 'pencil', name: found.length > 1 ? `pencil-${app}` : 'pencil', config: { command: exe, args: ['--app', app] } });
    }
  },
  /** Continue: config.yaml / config.json — `models` (provider, apiKey, apiBase) and `mcpServers` */
  continue: (w, out) => {
    const dir = path.join(w.home, '.continue');
    const conf = yaml(path.join(dir, 'config.yaml')) ?? json(path.join(dir, 'config.json'));
    if (!conf) return;
    for (const m of Array.isArray(conf.models) ? conf.models : []) {
      const id = str(m?.provider).toLowerCase();
      const model = str(m?.model);
      const p = fromKnown('continue', id, str(m?.apiKey), { baseUrl: str(m?.apiBase), name: str(m?.name) || undefined, ...(model ? { models: [model], defaultModel: model } : {}) });
      if (p) out.push({ ...p, key: `${p.key}:${model}` });
    }
    mcpMap('continue', conf.mcpServers ?? conf.experimental?.modelContextProtocolServers?.map((s: any) => ({ name: s?.name ?? s?.transport?.command, ...(s?.transport ?? {}) })), out);
  },
  /** Zed: settings.json `context_servers` */
  zed: (w, out) => {
    const p = w.platform === 'win32' ? path.join(w.appData, 'Zed', 'settings.json') : path.join(w.home, '.config', 'zed', 'settings.json');
    mcpMap('zed', json(p)?.context_servers, out);
  },
  /** Goose: config.yaml `extensions` (stdio command / args, or a URL) */
  goose: (w, out) => {
    const p = w.platform === 'win32' ? path.join(w.appData, 'Block', 'goose', 'config', 'config.yaml') : path.join(w.home, '.config', 'goose', 'config.yaml');
    const ext = yaml(p)?.extensions;
    if (!ext || typeof ext !== 'object') return;
    const servers: Record<string, any> = {};
    for (const [id, e] of Object.entries<any>(ext)) if (e && (e.type === 'stdio' || e.type === 'sse' || e.type === 'streamable_http') && e.enabled !== false) servers[str(e.name) || id] = { command: e.cmd, args: e.args, env: e.envs, url: e.uri, type: e.type === 'sse' ? 'sse' : undefined };
    mcpMap('goose', servers, out);
  },
  /** Ollama running here: its OpenAI-compatible endpoint, with the models it has pulled */
  ollama: async (w, out) => {
    const host = str(w.env.OLLAMA_HOST) || '127.0.0.1:11434';
    const base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    try {
      const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(800) });
      if (!r.ok) return;
      const models = ((await r.json()) as any)?.models?.map((m: any) => str(m?.name)).filter(Boolean) ?? [];
      if (models.length) out.push({ kind: 'provider', key: 'ollama:provider:local', from: 'ollama', name: 'Ollama', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'ollama', models, defaultModel: models[0] });
    } catch { /* not running */ }
  },
  /** Mirasim keeps its settings encrypted in a browser database: there, but not readable as files */
  mirasim: (w, _out, unreadable) => { if (exists(path.join(w.appData, '@mirasim', 'desktop'))) unreadable.push({ from: 'mirasim', reason: 'encrypted' }); },
  'cherry-studio': (w, _out, unreadable) => { if (exists(path.join(w.appData, 'CherryStudio', 'IndexedDB'))) unreadable.push({ from: 'cherry-studio', reason: 'browser-db' }); },
};

export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

/** Everything every source has, the same item once per source (two tools listing one server are two items). */
export async function scanAll(w: Where = where()): Promise<ScanResult> {
  const found: Found[] = [];
  const unreadable: Unreadable[] = [];
  const scanned: SourceId[] = [];
  for (const id of SOURCE_IDS) {
    const before = found.length + unreadable.length;
    try { await SOURCES[id](w, found, unreadable); } catch (e) { console.warn(`[import] ${id}: ${(e as Error).message}`); }
    if (found.length + unreadable.length > before) scanned.push(id);
  }
  const seen = new Set<string>();
  const usable = (f: Found): f is Usable => f.kind === 'mcp' || f.type === 'anthropic';
  return { found: found.filter(usable).filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true))), unreadable, scanned };
}
