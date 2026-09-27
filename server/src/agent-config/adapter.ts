// The per-agent seam of the config center. Each adapter knows where its agent keeps instructions / config,
// how to list / add / remove MCP servers (own CLI first, structured file edit only where no CLI exists),
// and which settings keys it exposes (only keys verified against the real CLI — see the plan doc).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfigBackup, AgentConfigFile, AgentConfigKind, AgentSettingField, McpSpec } from './types.js';
import type { BackupStore } from './backup.js';
import type { CliSpec } from './cli.js';
import { parseConfig, type ConfigFormat } from './edit.js';

export interface AdapterCtx {
  /** the agent's CLI as configured (settings → CLI Agents command + env) */
  cli(): CliSpec;
  backups: BackupStore;
  /** known model ids, offered as suggestions for the model field */
  models(): string[];
  /** home directory (os.homedir() unless a test overrides it) */
  home(): string;
}

export interface AgentConfigAdapter {
  readonly kind: AgentConfigKind;
  readonly name: string;
  readonly mcpVia: 'cli' | 'file';
  readonly transports: McpSpec['transport'][];
  configPath(): string;
  files(cwd?: string): Promise<AgentConfigFile[]>;
  /** unmasked — the service masks secrets before anything goes on the wire */
  mcpList(): Promise<McpSpec[]>;
  mcpAdd(spec: McpSpec): Promise<string>;
  mcpRemove(name: string): Promise<string>;
  settings(): Promise<AgentSettingField[]>;
  setSetting(key: string, value: string | null): Promise<AgentConfigBackup | null>;
}

export async function exists(p: string) {
  return fs.stat(p).then(() => true, () => false);
}

export async function readConfig(file: string, format: ConfigFormat): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (e: any) { if (e?.code === 'ENOENT') return {}; throw e; }
  return parseConfig(text, format);
}

/** env of the agent's CLI as it will run: our process env + the agent's configured overrides. */
export function cliEnv(ctx: AdapterCtx): Record<string, string | undefined> {
  return { ...process.env, ...ctx.cli().env };
}

export function homeOf(ctx: AdapterCtx) {
  return ctx.home() || os.homedir();
}

export async function fileList(entries: Omit<AgentConfigFile, 'exists'>[]): Promise<AgentConfigFile[]> {
  return Promise.all(entries.map(async (e) => ({ ...e, exists: await exists(e.path) })));
}

/** Global instructions, project instructions (when a cwd is given), then the config file. */
export function standardFiles(globalDir: string, instr: string, config: string, cwd?: string): Omit<AgentConfigFile, 'exists'>[] {
  return [
    { label: `全局说明 ${instr}`, path: path.join(globalDir, instr), kind: 'instructions', scope: 'global' },
    ...(cwd ? [{ label: `项目说明 ${instr}`, path: path.join(cwd, instr), kind: 'instructions' as const, scope: 'project' as const }] : []),
    { label: `配置 ${path.basename(config)}`, path: config, kind: 'config', scope: 'global' },
  ];
}

export function fieldValue(doc: Record<string, unknown>, key: string): string | undefined {
  let node: any = doc;
  for (const k of key.split('.')) node = node && typeof node === 'object' ? node[k] : undefined;
  return node === undefined || node === null ? undefined : typeof node === 'string' ? node : JSON.stringify(node);
}

/** Validate a settings write against the adapter's own field table (no arbitrary keys from the wire). */
export function checkField(fields: AgentSettingField[], key: string, value: string | null): void {
  const f = fields.find((x) => x.key === key);
  if (!f) throw new Error(`不支持的设置项：${key}`);
  if (value !== null && f.type === 'enum' && f.options && !f.options.includes(value)) throw new Error(`${f.label} 只能是 ${f.options.join(' / ')}`);
  if (value !== null && /[\r\n]/.test(value)) throw new Error('值不能包含换行');
}
