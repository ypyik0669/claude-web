import { execFile } from 'node:child_process';
import { resolveSpawn } from './resolve.js';
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
  { kind: 'claude', name: 'Claude Code', icon: 'claude', protocol: 'claude', command: 'claude', args: [], versionArgs: ['--version'], install: 'npm i -g @anthropic-ai/claude-code', login: 'claude /login', models: catalogIds('claude'), docs: 'https://docs.anthropic.com/claude-code', builtin: true },
  { kind: 'codex', name: 'Codex', icon: 'codex', protocol: 'codex', command: 'codex', args: ['app-server'], versionArgs: ['--version'], install: 'npm i -g @openai/codex', login: 'codex login', models: catalogIds('codex'), docs: 'https://github.com/openai/codex' },
  { kind: 'gemini', name: 'Gemini CLI', icon: 'gemini', protocol: 'acp', command: 'gemini', args: ['--acp'], versionArgs: ['--version'], install: 'npm i -g @google/gemini-cli', login: 'gemini', models: catalogIds('gemini'), docs: 'https://github.com/google-gemini/gemini-cli' },
  { kind: 'qwen', name: 'Qwen Code', icon: 'qwen', protocol: 'acp', command: 'qwen', args: ['--acp'], versionArgs: ['--version'], install: 'npm i -g @qwen-code/qwen-code', login: 'qwen', models: catalogIds('qwen'), docs: 'https://github.com/QwenLM/qwen-code' },
  { kind: 'kimi', name: 'Kimi CLI', icon: 'kimi', protocol: 'acp', command: 'kimi', args: ['acp'], versionArgs: ['--version'], install: 'uv tool install kimi-cli', login: 'kimi login', models: catalogIds('kimi'), docs: 'https://github.com/MoonshotAI/kimi-cli' },
  { kind: 'opencode', name: 'OpenCode', icon: 'opencode', protocol: 'acp', command: 'opencode', args: ['acp'], versionArgs: ['--version'], install: 'npm i -g opencode-ai', login: 'opencode auth login', models: [], docs: 'https://opencode.ai' },
];

export interface AgentConfig { command?: string; args?: string[]; env?: Record<string, string>; model?: string; label?: string; enabled?: boolean; name?: string; protocol?: 'acp' | 'codex' }

/** Detect installed agents and merge user overrides (meta settings `agents.<kind>`). */
export class AgentRegistry {
  constructor(private meta: MetaStore) {}

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

  /** Effective launch spec after overrides. */
  launch(kind: AgentKind): { command: string; args: string[]; env: Record<string, string>; model?: string; def: AgentDef } {
    const def = this.def(kind);
    const c = this.config(kind);
    return { command: c.command || def.command, args: c.args ?? def.args, env: c.env ?? {}, model: c.model || undefined, def };
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
  private probeCache = new Map<string, { at: number; version: string; ok: boolean }>();
  private probing = new Map<string, Promise<{ version: string; ok: boolean }>>();
  private gen = 0;
  static PROBE_TTL_MS = 10 * 60_000;
  static MISS_TTL_MS = 45_000;
  invalidate() { this.gen++; this.probeCache.clear(); this.probing.clear(); }

  private fresh(hit: { at: number; ok: boolean } | undefined): boolean {
    return !!hit && Date.now() - hit.at < (hit.ok ? AgentRegistry.PROBE_TTL_MS : AgentRegistry.MISS_TTL_MS);
  }

  private probe(key: string, command: string, versionArgs: string[]): Promise<{ version: string; ok: boolean }> {
    const running = this.probing.get(key);
    if (running) return running;
    const gen = this.gen;
    const p = (async () => {
      let version = '', ok = false;
      try {
        const r = resolveSpawn(command, versionArgs);
        const { stdout, stderr } = await execFileAsync(r.command, r.args, { windowsHide: true, timeout: 15_000, env: { ...process.env, ...r.env }, windowsVerbatimArguments: r.via === 'cmd' });
        version = `${stdout}${stderr}`.trim().split('\n')[0].slice(0, 60);
        ok = true;
      } catch { ok = false; }
      if (gen === this.gen) this.probeCache.set(key, { at: Date.now(), ok, version });
      return { version, ok };
    })().finally(() => { if (this.probing.get(key) === p) this.probing.delete(key); });
    this.probing.set(key, p);
    return p;
  }

  async list(refresh = false): Promise<AgentInfo[]> {
    if (refresh) this.invalidate();
    return Promise.all(this.defs().map(async (d) => {
      const c = this.config(d.kind);
      const command = c.command || d.command;
      let version = '', ok = false;
      if (d.builtin) { ok = true; version = 'bundled'; }
      else if (command) {
        const key = `${d.kind}|${command}`;
        const hit = this.probeCache.get(key);
        ({ version, ok } = this.fresh(hit) ? hit! : await this.probe(key, command, d.versionArgs));
      }
      return { kind: d.kind, name: d.name, icon: d.icon, protocol: d.protocol, installed: ok, version, command, args: c.args ?? d.args, env: c.env ?? {}, model: c.model ?? '', models: d.models, install: d.install, login: d.login, docs: d.docs, label: c.label ?? '', enabled: c.enabled !== false, builtin: !!d.builtin };
    }));
  }
}

export function agentOf(params: OpenSessionParams): AgentKind {
  return (params.agent ?? 'claude') as AgentKind;
}
