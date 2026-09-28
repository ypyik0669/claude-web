// OpenCode: `opencode mcp add` is an interactive wizard (no flags) and there is no `mcp remove`, so MCP is a
// structured edit of the `mcp` key in the global opencode.json(c) — comments and formatting kept, backed up.
import path from 'node:path';
import type { AgentConfigBackup, AgentSettingField, McpSpec } from './types.js';
import { checkField, cliEnv, exists, fieldValue, fileList, homeOf, readConfig, standardFiles, type AdapterCtx, type AgentConfigAdapter } from './adapter.js';
import { setJsonPath } from './edit.js';

const FIELDS: Omit<AgentSettingField, 'value'>[] = [
  { key: 'model', label: '默认模型', type: 'string', hint: '形如 provider/model，例如 anthropic/claude-sonnet-4-5' },
];
const CANDIDATES = ['opencode.jsonc', 'opencode.json', 'config.json'];

export class OpenCodeConfigAdapter implements AgentConfigAdapter {
  readonly kind = 'opencode' as const;
  readonly name = 'OpenCode';
  readonly mcpVia = 'file' as const;
  readonly transports: McpSpec['transport'][] = ['stdio', 'http', 'sse'];
  private resolved: string | null = null;
  constructor(private ctx: AdapterCtx) {}

  /** `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` (xdg-basedir, also on Windows). */
  private dir() { return path.join(cliEnv(this.ctx).XDG_CONFIG_HOME || path.join(homeOf(this.ctx), '.config'), 'opencode'); }
  configPath() { return this.resolved ?? path.join(this.dir(), 'opencode.json'); }

  /** Pick the config file that exists (jsonc → json → legacy config.json), defaulting to opencode.json. */
  private async locate() {
    for (const f of CANDIDATES) {
      const p = path.join(this.dir(), f);
      if (await exists(p)) return (this.resolved = p);
    }
    return (this.resolved = path.join(this.dir(), 'opencode.json'));
  }

  async files(cwd?: string) { return fileList(standardFiles(this.dir(), 'AGENTS.md', await this.locate(), cwd)); }

  async mcpList(): Promise<McpSpec[]> {
    const doc = await readConfig(await this.locate(), 'json');
    return Object.entries((doc.mcp ?? {}) as Record<string, any>).map(([name, s]) => {
      const enabled = s.enabled !== false;
      if (s.type === 'local' || Array.isArray(s.command)) {
        const [command, ...args] = s.command ?? [];
        return { name, transport: 'stdio', command, args, env: s.environment, enabled };
      }
      return { name, transport: 'http', url: s.url, headers: s.headers, enabled };
    });
  }

  async mcpAdd(spec: McpSpec): Promise<string> {
    const entry = spec.transport === 'stdio'
      ? { type: 'local', command: [spec.command!, ...(spec.args ?? [])], ...(spec.env && Object.keys(spec.env).length ? { environment: spec.env } : {}), enabled: true }
      : { type: 'remote', url: spec.url!, ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}), enabled: true };
    await this.ctx.backups.writeChecked('opencode', await this.locate(), (t) => setJsonPath(t, ['mcp', spec.name], entry), `mcp add ${spec.name}`);
    return `已写入 ${path.basename(this.configPath())} 的 mcp.${spec.name}`;
  }

  async mcpRemove(name: string): Promise<string> {
    if (!(await this.mcpList()).some((s) => s.name === name)) throw new Error(`OpenCode 配置里没有名为 ${name} 的 MCP 服务器`);
    await this.ctx.backups.writeChecked('opencode', await this.locate(), (t) => setJsonPath(t, ['mcp', name], undefined), `mcp remove ${name}`);
    return `已从 ${path.basename(this.configPath())} 删除 mcp.${name}`;
  }

  async settings(): Promise<AgentSettingField[]> {
    const doc = await readConfig(await this.locate(), 'json');
    return FIELDS.map((f) => ({ ...f, value: fieldValue(doc, f.key) }));
  }

  async setSetting(key: string, value: string | null): Promise<AgentConfigBackup | null> {
    checkField(FIELDS, key, value);
    return this.ctx.backups.writeChecked('opencode', await this.locate(), (t) => setJsonPath(t, key.split('.'), value || undefined), `设置 ${key}`);
  }
}
