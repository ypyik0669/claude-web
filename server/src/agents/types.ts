import { execFile } from 'node:child_process';
import { findOnPath, resolveSpawn } from './resolve.js';
import { findBundled, installTool, refreshProcessPath } from './locate.js';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import type { AgentKind, AgentInfo, EffortLevel, OpenSessionParams, PermissionMode, PermissionRequestEvent, PermissionResponse, RunnerState, SessionInfoSnapshot, AttachmentRef } from '../protocol.js';
import type { MetaStore } from '../meta/store.js';
import { modelsFor } from '../models/catalog.js';

const catalogIds = (k: AgentKind) => modelsFor(k).map((m) => m.value);

const execFileAsync = promisify(execFile);

/** What the pool / hub need from any live session, whatever agent is behind it. SessionRunner already fits. */
export interface AgentDriver extends EventEmitter {
  readonly id: string;
  sessionId: string;
  state: RunnerState;
  cwd: string;
  info: SessionInfoSnapshot;
  lastActivity: number;
  getHistory(): unknown[];
  getPendingPermissions(): PermissionRequestEvent[];
  respondPermission(requestId: string, r: PermissionResponse): boolean;
  send(text: string, images?: { mediaType: string; data: string }[], steer?: boolean, uuid?: string, attachments?: AttachmentRef[]): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort?(effort: EffortLevel): Promise<void>;
  /** Claude only: xhigh + dynamic workflows. Separate from effort on purpose — see catalog.ts. */
  setUltracode?(on: boolean): Promise<void>;
  stopTask?(taskId: string): Promise<void>;
  contextUsage?(detail: 'summary' | 'full'): Promise<unknown>;
  respawn?(): Promise<void>;
}

export interface AgentDef {
  kind: AgentKind;
  name: string;
  icon: string;
  protocol: 'claude' | 'acp' | 'codex';
  command: string; // default executable
  args: string[]; // default args to enter the protocol mode
  versionArgs: string[];
  install: string; // shell command
  login: string; // shell command to run in a terminal tile
  models: string[]; // known model ids (user can type others)
  docs: string;
  builtin?: boolean;
}

// `icon` is a name in web/src/ui/icons.tsx, not a glyph. `models` comes from the shared catalog so
// there is one place that knows Fable 5.1 is `claude-fable-5-1`.
export const AGENT_DEFS: AgentDef[] = [
  { kind: 'claude', name: 'Claude Code', icon: 'claude', protocol: 'claude', command: 'claude', args: [], versionArgs: ['--version'], install: 'npm i -g @anthropic-ai/claude-code', login: 'claude auth login', models: catalogIds('claude'), docs: 'https://docs.anthropic.com/claude-code', builtin: true },
  { kind: 'codex', name: 'Codex', icon: 'codex', protocol: 'codex', command: 'codex', args: ['app-server'], versionArgs: ['--version'], install: 'npm i -g @openai/codex', login: 'codex login', models: catalogIds('codex'), docs: 'https://github.com/openai/codex' },
  { kind: 'gemini', name: 'Gemini CLI', icon: 'gemini', protocol: 'acp', command: 'gemini', args: ['--acp'], versionArgs: ['--version'], install: 'npm i -g @google/gemini-cli', login: 'gemini', models: catalogIds('gemini'), docs: 'https://github.com/google-gemini/gemini-cli' },
  { kind: 'qwen', name: 'Qwen Code', icon: 'qwen', protocol: 'acp', command: 'qwen', args: ['--acp'], versionArgs: ['--version'], install: 'npm i -g @qwen-code/qwen-code', login: 'qwen', models: catalogIds('qwen'), docs: 'https://github.com/QwenLM/qwen-code' },
  { kind: 'kimi', name: 'Kimi CLI', icon: 'kimi', protocol: 'acp', command: 'kimi', args: ['acp'], versionArgs: ['--version'], install: 'uv tool install kimi-cli', login: 'kimi login', models: catalogIds('kimi'), docs: 'https://github.com/MoonshotAI/kimi-cli' },
  { kind: 'opencode', name: 'OpenCode', icon: 'opencode', protocol: 'acp', command: 'opencode', args: ['acp'], versionArgs: ['--version'], install: 'npm i -g opencode-ai', login: 'opencode auth login', models: [], docs: 'https://opencode.ai' },
];

export interface AgentConfig { command?: string; args?: string[]; env?: Record<string, string>; model?: string; label?: string; enabled?: boolean; name?: string; protocol?: 'acp' | 'codex'; /** the provider new sessions of this agent run on when none is picked ('' / absent = its own login) */ providerId?: string }

/** How the registry finds executables — injectable so tests do not depend on what this machine has installed. */
export interface AgentLocator {
  /** the absolute file of `command` on PATH (or the path itself when it is one), else null */
  onPath(command: string): string | null;
  /** an agent binary shipped inside another app (Codex desktop app / IDE extension) when there is none on PATH */
  bundled(kind: AgentKind): { file: string; from: string } | null;
  /** add the directories CLIs install into to this process's PATH (see locate.ts) */
  refreshPath(force: boolean): Promise<unknown>;
}
const realLocator: AgentLocator = { onPath: findOnPath, bundled: (kind) => findBundled(kind), refreshPath: refreshProcessPath };

interface Probe { version: string; ok: boolean; path?: string; from?: string; error?: string }

/** Why `<cmd> --version` failed, in one short line (never the whole stderr: it can be pages of a stack trace). */
export function versionError(e: any, shown: string): string {
  if (e?.killed || e?.signal === 'SIGTERM' || /ETIMEDOUT|timed out/i.test(String(e?.message))) return `找到了 ${shown}，但「${shown} --version」${AgentRegistry.VERSION_TIMEOUT_MS / 1000} 秒没有回答（第一次启动或杀毒软件扫描时常见，点「重新检测」再试）`;
  // a Node crash prints the source line and a caret before the message: skip those and the stack frames
  const lines = `${e?.stderr ?? ''}\n${e?.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter((l) => l && !/^at\s|^\^+$|^node:internal|new Error\(|^\{|^\}|^code:|^requireStack/.test(l));
  const last = lines.find((l) => /^\w*Error\b|^error\b/i.test(l)) ?? lines.find((l) => /cannot|not found|找不到|无法/i.test(l)) ?? lines[lines.length - 1] ?? e?.message ?? String(e);
  return `找到了 ${shown}，但「${shown} --version」失败：${String(last).slice(0, 200)}`;
}

/** Detect installed agents and merge user overrides (meta settings `agents.<kind>`). */
export class AgentRegistry {
  constructor(private meta: MetaStore, private loc: AgentLocator = realLocator) {}

  config(kind: AgentKind): AgentConfig {
    return ((this.meta.settings().agents as Record<string, AgentConfig> | undefined)?.[kind]) ?? {};
  }

  async setConfig(kind: AgentKind, patch: AgentConfig | null) {
    const all = { ...((this.meta.settings().agents as Record<string, AgentConfig> | undefined) ?? {}) };
    if (patch === null) delete all[kind]; else all[kind] = { ...all[kind], ...patch };
    await this.meta.setSetting('agents', all);
  }

  /** Built-in definitions + user-defined ACP agents (`acp:<id>` entries in settings). */
  defs(): AgentDef[] {
    const custom = Object.entries((this.meta.settings().agents as Record<string, AgentConfig> | undefined) ?? {})
      .filter(([k]) => k.startsWith('acp:'))
      .map(([k, c]) => ({ kind: k as AgentKind, name: c.name ?? k.slice(4), icon: '⌬', protocol: (c.protocol ?? 'acp') as 'acp' | 'codex', command: c.command ?? '', args: c.args ?? [], versionArgs: ['--version'], install: '', login: '', models: c.model ? [c.model] : [], docs: '' }));
    return [...AGENT_DEFS, ...custom];
  }

  def(kind: AgentKind): AgentDef {
    const d = this.defs().find((x) => x.kind === kind);
    if (!d) throw new Error(`未知 agent：${kind}`);
    return d;
  }

  /**
   * Effective launch spec after overrides. No command of the user's own and nothing on PATH → the copy another app
   * ships (the Codex desktop app's codex.exe), so a user who only has that can still start a session.
   */
  launch(kind: AgentKind): { command: string; args: string[]; env: Record<string, string>; model?: string; def: AgentDef } {
    const def = this.def(kind);
    const c = this.config(kind);
    return { command: c.command || this.defaultCommand(def), args: c.args ?? def.args, env: c.env ?? {}, model: c.model || undefined, def };
  }

  private defaultCommand(def: AgentDef): string {
    if (def.builtin || !def.command || this.loc.onPath(def.command)) return def.command;
    return this.loc.bundled(def.kind)?.file ?? def.command;
  }

  /**
   * `<agent> --version` results. A probe is a whole CLI start (opencode's alone runs four PowerShell AVX
   * checks), and list() has many callers — every ws connection (library detect + agents.list + library
   * sources), orchestra, every library.changed during a live session — so: one probe in flight per agent
   * however many callers, and results kept for PROBE_TTL_MS — a miss ("not installed") only MISS_TTL_MS, so
   * a freshly installed agent shows up within a minute. Settings → CLI Agents "刷新" (refresh) re-probes.
   * `gen` makes refresh / invalidate final: a probe started before them may still answer its own callers,
   * but it cannot write its (older) result over the cache.
   */
  private probeCache = new Map<string, Probe & { at: number }>();
  private probing = new Map<string, Promise<Probe>>();
  private gen = 0;
  static PROBE_TTL_MS = 10 * 60_000;
  static MISS_TTL_MS = 45_000;
  /** a cold first start (Defender scanning a fresh node_modules, opencode's AVX checks) can take well over 15 s */
  static VERSION_TIMEOUT_MS = 30_000;
  invalidate() { this.gen++; this.probeCache.clear(); this.probing.clear(); }

  private fresh(hit: { at: number; ok: boolean } | undefined): boolean {
    return !!hit && Date.now() - hit.at < (hit.ok ? AgentRegistry.PROBE_TTL_MS : AgentRegistry.MISS_TTL_MS);
  }

  /**
   * Found = installed: the file is on PATH (after locate.ts added the usual install directories), or — for the
   * default command only — shipped inside another app. `--version` then only names the version; when it fails or
   * times out the agent still counts as installed and `error` says what happened (it used to read 「未安装」, with
   * an 安装 button, for a Codex that was there all along).
   */
  private probe(key: string, kind: AgentKind, command: string, ownCommand: boolean, versionArgs: string[]): Promise<Probe> {
    const running = this.probing.get(key);
    if (running) return running;
    const gen = this.gen;
    const p = (async (): Promise<Probe> => {
      await this.loc.refreshPath(false).catch(() => {});
      let file = this.loc.onPath(command);
      let from: string | undefined;
      if (!file && !ownCommand) { const b = this.loc.bundled(kind); if (b) ({ file, from } = b); }
      let out: Probe;
      if (!file) out = { ok: false, version: '', error: ownCommand ? `找不到「${command}」（设置的命令不在 PATH 里，也不是存在的文件）` : `这台电脑的 PATH 里没有 ${command}` };
      else {
        try {
          const r = resolveSpawn(file, versionArgs);
          const { stdout, stderr } = await execFileAsync(r.command, r.args, { windowsHide: true, timeout: AgentRegistry.VERSION_TIMEOUT_MS, env: { ...process.env, ...r.env }, windowsVerbatimArguments: r.via === 'cmd' });
          out = { ok: true, version: `${stdout}${stderr}`.trim().split('\n')[0].slice(0, 60), path: file, from };
        } catch (e) {
          out = { ok: true, version: '', path: file, from, error: versionError(e, command) };
        }
      }
      if (gen === this.gen) this.probeCache.set(key, { at: Date.now(), ...out });
      return out;
    })().finally(() => { if (this.probing.get(key) === p) this.probing.delete(key); });
    this.probing.set(key, p);
    return p;
  }

  async list(refresh = false): Promise<AgentInfo[]> {
    if (refresh) { this.invalidate(); await this.loc.refreshPath(true).catch(() => {}); }
    return Promise.all(this.defs().map(async (d) => {
      const c = this.config(d.kind);
      const command = c.command || d.command;
      let r: Probe = { version: '', ok: false };
      if (d.builtin) r = { ok: true, version: 'bundled' };
      else if (command) {
        const key = `${d.kind}|${command}`;
        const hit = this.probeCache.get(key);
        r = this.fresh(hit) ? hit! : await this.probe(key, d.kind, command, !!c.command, d.versionArgs);
      }
      // a copy found outside PATH: the login command in the terminal has to name that file
      const login = r.from && r.path && d.login.startsWith(`${d.command} `) ? `"${r.path}"${d.login.slice(d.command.length)}` : d.login;
      // the 安装 button types `npm i -g …` / `uv tool install …` into a terminal: say so when that tool is missing
      const tool = !r.ok && d.install ? installTool(d.install) : null;
      const installNeeds = tool && !this.loc.onPath(tool.tool) ? { name: tool.name, url: tool.url } : undefined;
      return {
        kind: d.kind, name: d.name, icon: d.icon, protocol: d.protocol, installed: r.ok, version: r.version, command, args: c.args ?? d.args, env: c.env ?? {}, model: c.model ?? '', models: d.models, install: d.install, login, docs: d.docs, label: c.label ?? '', enabled: c.enabled !== false, builtin: !!d.builtin, providerId: c.providerId ?? '',
        ...(r.path ? { path: r.path } : {}), ...(r.from ? { from: r.from } : {}), ...(r.error ? { probeError: r.error } : {}), ...(installNeeds ? { installNeeds } : {}),
      };
    }));
  }
}

export function agentOf(params: OpenSessionParams): AgentKind {
  return (params.agent ?? 'claude') as AgentKind;
}
