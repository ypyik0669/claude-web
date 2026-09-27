// Configuration center for the non-Claude agents: one adapter per agent, one backup store, secrets masked on
// the way out. Claude's own MCP servers are only a *source* here (read-only, by name) for syncing.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../protocol.js';
import type { AgentConfigBackup, AgentConfigKind, AgentConfigState, ClaudeMcpEntry, McpSpec, McpSyncResult, McpSyncSource } from './types.js';
import type { AgentConfigAdapter, AdapterCtx } from './adapter.js';
import { BackupStore } from './backup.js';
import type { CliSpec } from './cli.js';
import { CodexConfigAdapter } from './codex.js';
import { GEMINI, GeminiLikeConfigAdapter, QWEN } from './gemini.js';
import { OpenCodeConfigAdapter } from './opencode.js';
import { parseConfig } from './edit.js';
import { findOnPath } from '../agents/resolve.js';

export const AGENT_CONFIG_KINDS: AgentConfigKind[] = ['codex', 'gemini', 'qwen', 'opencode'];
export const MASK = '••••••';

/** The slice of AgentRegistry the config center needs (install probe + effective command / env). */
export interface AgentLookup {
  list(refresh?: boolean): Promise<{ kind: AgentKind; installed: boolean; version: string; models: string[] }[]>;
  launch(kind: AgentKind): { command: string; env: Record<string, string> };
}

export interface AgentConfigOptions {
  agents: AgentLookup;
  backupDir: string;
  /** override the CLI invocation (tests: node + fake script) */
  cli?: (kind: AgentConfigKind) => CliSpec;
  home?: () => string;
  /** Claude's config dir (`~/.claude` or CLAUDE_CONFIG_DIR) — where to look for `.claude.json` */
  claudeDir?: string;
  /** how long to wait for the install probe before falling back to a PATH lookup (default 3 s) */
  probeWaitMs?: number;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reject specs the CLIs would choke on (or that could smuggle extra argv / TOML keys). */
export function validateSpec(spec: McpSpec, transports: McpSpec['transport'][]): McpSpec {
  if (!spec || typeof spec !== 'object') throw new Error('缺少 MCP 配置');
  if (!NAME.test(spec.name ?? '')) throw new Error(`名称 ${spec.name ?? ''} 不合法：只能用字母、数字、_ 和 -`);
  if (!['stdio', 'http', 'sse'].includes(spec.transport)) throw new Error(`未知传输方式 ${spec.transport}`);
  if (!transports.includes(spec.transport)) throw new Error(`不支持 ${spec.transport} 传输`);
  if (spec.transport === 'stdio') {
    if (!spec.command?.trim()) throw new Error('stdio 服务器需要命令');
    if (spec.args && (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string'))) throw new Error('args 必须是字符串数组');
  } else if (!/^https?:\/\/\S+$/i.test(spec.url ?? '')) throw new Error('URL 必须以 http:// 或 https:// 开头');
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!ENV_KEY.test(k)) throw new Error(`环境变量名 ${k} 不合法`);
    if (typeof v !== 'string' || /[\r\n]/.test(v)) throw new Error(`环境变量 ${k} 的值不合法`);
    if (v === MASK) throw new Error(`环境变量 ${k} 是打码值，请填写真实值`);
  }
  for (const [k, v] of Object.entries(spec.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new Error(`header 名 ${k} 不合法`);
    if (typeof v !== 'string' || /[\r\n]/.test(v)) throw new Error(`header ${k} 的值不合法`);
    if (v === MASK) throw new Error(`header ${k} 是打码值，请填写真实值`);
  }
  return spec;
}

/** Secrets never leave the server: env / header values become MASK. */
export function maskSpec(spec: McpSpec): McpSpec {
  const m = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.keys(o).map((k) => [k, MASK])) : undefined);
  return { ...spec, env: m(spec.env), headers: m(spec.headers) };
}

/** Claude's `{type, command, args, env, url, headers}` → neutral spec. */
export function fromClaude(name: string, c: any): McpSpec {
  const type = c?.type ?? (c?.url ? 'http' : 'stdio');
  if (type === 'stdio') return { name, transport: 'stdio', command: c.command, args: c.args ?? [], env: c.env && Object.keys(c.env).length ? c.env : undefined };
  return { name, transport: type === 'sse' ? 'sse' : 'http', url: c.url, headers: c.headers && Object.keys(c.headers).length ? c.headers : undefined };
}

export class AgentConfigService {
  readonly backups: BackupStore;
  private adapters: Map<AgentConfigKind, AgentConfigAdapter>;
  private models: Partial<Record<AgentConfigKind, string[]>> = {};

  constructor(private opts: AgentConfigOptions) {
    this.backups = new BackupStore(opts.backupDir);
    const ctx = (kind: AgentConfigKind): AdapterCtx => ({
      cli: () => opts.cli?.(kind) ?? (() => { const l = opts.agents.launch(kind); return { command: l.command, env: l.env }; })(),
      backups: this.backups,
      models: () => this.models[kind] ?? [],
      home: () => opts.home?.() ?? os.homedir(),
    });
    this.adapters = new Map<AgentConfigKind, AgentConfigAdapter>([
      ['codex', new CodexConfigAdapter(ctx('codex'))],
      ['gemini', new GeminiLikeConfigAdapter(GEMINI, ctx('gemini'))],
      ['qwen', new GeminiLikeConfigAdapter(QWEN, ctx('qwen'))],
      ['opencode', new OpenCodeConfigAdapter(ctx('opencode'))],
    ]);
  }

  adapter(kind: AgentConfigKind): AgentConfigAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new Error(`不支持的 agent：${kind}`);
    return a;
  }

  async list(cwd?: string): Promise<AgentConfigState[]> {
    const infos = await this.infos();
    return Promise.all(AGENT_CONFIG_KINDS.map((k) => this.state(k, cwd, infos)));
  }

  async get(kind: AgentConfigKind, cwd?: string): Promise<AgentConfigState> {
    return this.state(kind, cwd, await this.infos());
  }

  /**
   * Install / version probe. AgentRegistry caches it for 60 s, but a cold probe runs every agent's --version
   * (a cold `opencode --version` alone is ~10 s on Windows); past 3 s answer from PATH and leave version empty.
   */
  private async infos(): Promise<Awaited<ReturnType<AgentLookup['list']>>> {
    const probe = this.opts.agents.list().catch(() => []);
    const late = new Promise<null>((r) => setTimeout(() => r(null), this.opts.probeWaitMs ?? 3000).unref?.());
    const got = await Promise.race([probe, late]);
    if (got) return got;
    return AGENT_CONFIG_KINDS.map((kind) => ({ kind, installed: !!findOnPath(this.opts.agents.launch(kind).command), version: '', models: [] }));
  }

  private async state(kind: AgentConfigKind, cwd: string | undefined, infos: Awaited<ReturnType<AgentLookup['list']>>): Promise<AgentConfigState> {
    const a = this.adapter(kind);
    const info = infos.find((i) => i.kind === kind);
    this.models[kind] = info?.models ?? [];
    const installed = !!info?.installed;
    const files = await a.files(cwd);
    let mcp: McpSpec[] = [], mcpError: string | undefined;
    // Codex lists through its CLI, which can't be asked when it isn't there; the others read their files
    if (kind !== 'codex' || installed) {
      try { mcp = (await a.mcpList()).map(maskSpec); } catch (e: any) { mcpError = e?.message ?? String(e); }
    } else mcpError = '未安装 Codex，无法运行 codex mcp list';
    let settings: AgentConfigState['settings'] = [], settingsError: string | undefined;
    try { settings = await a.settings(); } catch (e: any) { settingsError = e?.message ?? String(e); }
    return { kind, name: a.name, installed, version: info?.version ?? '', configPath: a.configPath(), files, mcp, mcpError, mcpVia: a.mcpVia, transports: a.transports, settings, settingsError };
  }

  async mcpAdd(kind: AgentConfigKind, spec: McpSpec, overwrite = false): Promise<string> {
    const a = this.adapter(kind);
    validateSpec(spec, a.transports);
    if (!overwrite) {
      const existing = await a.mcpList().catch(() => [] as McpSpec[]);
      if (existing.some((s) => s.name === spec.name)) throw new Error(`已存在同名服务器 ${spec.name}（勾选「覆盖」可替换）`);
    }
    return a.mcpAdd(spec);
  }

  async mcpRemove(kind: AgentConfigKind, name: string): Promise<string> {
    if (!NAME.test(name)) throw new Error(`名称 ${name} 不合法`);
    return this.adapter(kind).mcpRemove(name);
  }

  /** One source → several agents; every target reports its own outcome (a failure never stops the rest). */
  async sync(source: McpSyncSource, targets: AgentConfigKind[], overwrite = false): Promise<McpSyncResult[]> {
    const spec = 'claude' in source ? await this.claudeSpec(source.claude, source.cwd) : source.spec;
    const out: McpSyncResult[] = [];
    for (const t of [...new Set(targets)]) {
      try { out.push({ agent: t, ok: true, message: await this.mcpAdd(t, spec, overwrite) }); } catch (e: any) { out.push({ agent: t, ok: false, message: e?.message ?? String(e) }); }
    }
    return out;
  }

  async set(kind: AgentConfigKind, key: string, value: string | null): Promise<AgentConfigBackup | null> {
    return this.adapter(kind).setSetting(key, value);
  }

  /** Create an instructions / config file the adapter lists (and only those) so it can be opened in a doc tile. */
  async createFile(kind: AgentConfigKind, file: string, cwd?: string): Promise<string> {
    const files = await this.adapter(kind).files(cwd);
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const hit = files.find((f) => norm(f.path) === norm(file));
    if (!hit) throw new Error(`不是 ${kind} 的配置 / 说明文件：${file}`);
    if (!hit.exists) {
      await fs.mkdir(path.dirname(hit.path), { recursive: true });
      await fs.writeFile(hit.path, hit.kind === 'config' && hit.path.endsWith('.json') ? '{}\n' : '', { flag: 'wx' }).catch((e) => { if (e?.code !== 'EEXIST') throw e; });
    }
    return hit.path;
  }

  listBackups(kind?: AgentConfigKind) { return this.backups.list(kind); }
  restore(id: string) { return this.backups.restore(id); }

  // ---- Claude as a sync source ----

  private claudeJsonCandidates() {
    const dir = this.opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(this.opts.home?.() ?? os.homedir(), '.claude');
    return [path.join(dir, '.claude.json'), path.join(path.dirname(dir), '.claude.json')];
  }

  private async readJson(p: string): Promise<any> {
    try { return parseConfig(await fs.readFile(p, 'utf8'), 'json'); } catch { return null; }
  }

  /** Claude's MCP servers: user (~/.claude.json), local (its projects[cwd]) and project (<cwd>/.mcp.json). Unmasked. */
  private async claudeAll(cwd?: string): Promise<ClaudeMcpEntry[]> {
    let user: any = null;
    for (const p of this.claudeJsonCandidates()) if ((user = await this.readJson(p))) break;
    const out: ClaudeMcpEntry[] = [];
    for (const [n, c] of Object.entries<any>(user?.mcpServers ?? {})) out.push({ scope: 'user', spec: fromClaude(n, c) });
    if (cwd) {
      const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
      const proj = Object.entries<any>(user?.projects ?? {}).find(([p]) => norm(p) === norm(cwd))?.[1];
      for (const [n, c] of Object.entries<any>(proj?.mcpServers ?? {})) out.push({ scope: 'local', spec: fromClaude(n, c) });
      const mcpJson = await this.readJson(path.join(cwd, '.mcp.json'));
      for (const [n, c] of Object.entries<any>(mcpJson?.mcpServers ?? {})) out.push({ scope: 'project', spec: fromClaude(n, c) });
    }
    return out;
  }

  async claudeMcp(cwd?: string): Promise<ClaudeMcpEntry[]> {
    return (await this.claudeAll(cwd)).map((e) => ({ ...e, spec: maskSpec(e.spec) }));
  }

  private async claudeSpec(name: string, cwd?: string): Promise<McpSpec> {
    // local overrides project overrides user, same precedence as Claude Code
    const all = (await this.claudeAll(cwd)).filter((e) => e.spec.name === name);
    const hit = all.find((e) => e.scope === 'local') ?? all.find((e) => e.scope === 'project') ?? all[0];
    if (!hit) throw new Error(`Claude 里没有名为 ${name} 的 MCP 服务器`);
    return hit.spec;
  }
}
