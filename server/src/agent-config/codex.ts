// Codex: MCP through `codex mcp list --json | add | remove`, settings as single top-level keys of
// `$CODEX_HOME/config.toml`. Custom HTTP headers have no CLI flag, so they're appended as
// `[mcp_servers.<name>.http_headers]` right after the CLI add (backed up, re-parsed).
import path from 'node:path';
import type { AgentConfigBackup, AgentSettingField, McpSpec } from './types.js';
import { checkField, cliEnv, fieldValue, fileList, homeOf, readConfig, standardFiles, type AdapterCtx, type AgentConfigAdapter } from './adapter.js';
import { runCliOk } from './cli.js';
import { appendTomlTable, setTomlTopLevel } from './edit.js';

// enum values as the CLI itself reports them for a bad value (codex-cli 0.155: "expected one of …");
// model_reasoning_effort accepts any string, these are the documented levels
const FIELDS: Omit<AgentSettingField, 'value'>[] = [
  { key: 'model', label: '默认模型', type: 'string', hint: 'config.toml 的 model' },
  { key: 'model_reasoning_effort', label: '推理强度', type: 'enum', options: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { key: 'approval_policy', label: '审批策略', type: 'enum', options: ['untrusted', 'on-failure', 'on-request', 'never'] },
  { key: 'sandbox_mode', label: '沙箱', type: 'enum', options: ['read-only', 'workspace-write', 'danger-full-access'] },
];

export class CodexConfigAdapter implements AgentConfigAdapter {
  readonly kind = 'codex' as const;
  readonly name = 'Codex';
  readonly mcpVia = 'cli' as const;
  readonly transports: McpSpec['transport'][] = ['stdio', 'http'];
  constructor(private ctx: AdapterCtx) {}

  private homeDir() { return cliEnv(this.ctx).CODEX_HOME || path.join(homeOf(this.ctx), '.codex'); }
  configPath() { return path.join(this.homeDir(), 'config.toml'); }

  files(cwd?: string) { return fileList(standardFiles(this.homeDir(), 'AGENTS.md', this.configPath(), cwd)); }

  async mcpList(): Promise<McpSpec[]> {
    const r = await runCliOk(this.ctx.cli(), ['mcp', 'list', '--json']);
    const start = r.stdout.indexOf('[');
    const list = JSON.parse(start >= 0 ? r.stdout.slice(start) : '[]') as any[];
    return list.map((s) => {
      const t = s.transport ?? {};
      if (t.type === 'stdio') return { name: s.name, transport: 'stdio', command: t.command, args: t.args ?? [], env: t.env ?? undefined, enabled: s.enabled !== false };
      const headers = { ...(t.http_headers ?? {}) } as Record<string, string>;
      if (t.bearer_token_env_var) headers.Authorization = `Bearer $${t.bearer_token_env_var}`;
      return { name: s.name, transport: 'http', url: t.url, headers: Object.keys(headers).length ? headers : undefined, enabled: s.enabled !== false };
    });
  }

  async mcpAdd(spec: McpSpec): Promise<string> {
    if (spec.transport === 'sse') throw new Error('Codex 只支持 stdio 与 streamable HTTP，不支持 SSE');
    const args = ['mcp', 'add', spec.name];
    if (spec.transport === 'stdio') {
      for (const [k, v] of Object.entries(spec.env ?? {})) args.push('--env', `${k}=${v}`);
      args.push('--', spec.command!, ...(spec.args ?? []));
    } else args.push('--url', spec.url!);
    const file = this.configPath();
    await this.ctx.backups.guard('codex', file, `mcp add ${spec.name}`, () => runCliOk(this.ctx.cli(), args));
    const headers = spec.transport === 'http' ? spec.headers ?? {} : {};
    if (Object.keys(headers).length) {
      await this.ctx.backups.writeChecked('codex', file, (t) => appendTomlTable(t, ['mcp_servers', spec.name, 'http_headers'], headers), `mcp ${spec.name} http_headers`);
      return `已通过 codex mcp add 添加，并写入 ${Object.keys(headers).length} 个 header`;
    }
    return '已通过 codex mcp add 添加';
  }

  async mcpRemove(name: string): Promise<string> {
    const { result } = await this.ctx.backups.guard('codex', this.configPath(), `mcp remove ${name}`, () => runCliOk(this.ctx.cli(), ['mcp', 'remove', name]));
    if (/No MCP server named/i.test(result.stdout + result.stderr)) throw new Error(`Codex 里没有名为 ${name} 的 MCP 服务器`);
    return '已通过 codex mcp remove 删除';
  }

  async settings(): Promise<AgentSettingField[]> {
    const doc = await readConfig(this.configPath(), 'toml');
    return FIELDS.map((f) => ({ ...f, value: fieldValue(doc, f.key), ...(f.key === 'model' ? { suggestions: this.ctx.models() } : {}) }));
  }

  async setSetting(key: string, value: string | null): Promise<AgentConfigBackup | null> {
    checkField(FIELDS, key, value);
    return this.ctx.backups.writeChecked('codex', this.configPath(), (t) => setTomlTopLevel(t, key, value || undefined), `设置 ${key}`);
  }
}
