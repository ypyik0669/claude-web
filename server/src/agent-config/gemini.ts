// Gemini CLI and Qwen Code (a Gemini fork): MCP writes through `<cli> mcp add|remove -s user`, the list is
// read straight from settings.json because `<cli> mcp list` connects to every server to report status
// (spawns stdio servers, hits URLs). Settings are nested JSON keys edited in place (comments kept).
import path from 'node:path';
import type { AgentConfigBackup, AgentSettingField, McpSpec } from './types.js';
import { checkField, cliEnv, fieldValue, fileList, homeOf, readConfig, standardFiles, type AdapterCtx, type AgentConfigAdapter } from './adapter.js';
import { runCliOk } from './cli.js';
import { parseConfig, setJsonPath } from './edit.js';

interface Flavor {
  kind: 'gemini' | 'qwen';
  name: string;
  instructions: string;
  /** the directory holding settings.json */
  dir(env: Record<string, string | undefined>, home: string): string;
  fields: Omit<AgentSettingField, 'value'>[];
}

export const GEMINI: Flavor = {
  kind: 'gemini',
  name: 'Gemini CLI',
  instructions: 'GEMINI.md',
  // GEMINI_CLI_HOME replaces the home directory; `.gemini` lives under it (gemini-cli 0.41 `homedir()`)
  dir: (env, home) => path.join(env.GEMINI_CLI_HOME || home, '.gemini'),
  fields: [
    { key: 'model.name', label: '默认模型', type: 'string', hint: 'settings.json 的 model.name' },
    { key: 'general.defaultApprovalMode', label: '默认审批模式', type: 'enum', options: ['default', 'auto_edit', 'plan'], hint: 'YOLO 只能用命令行参数开启' },
  ],
};

export const QWEN: Flavor = {
  kind: 'qwen',
  name: 'Qwen Code',
  instructions: 'QWEN.md',
  // QWEN_HOME is the `.qwen` directory itself (qwen-code 0.24 Storage.getGlobalQwenDir)
  dir: (env, home) => env.QWEN_HOME || path.join(home, '.qwen'),
  fields: [{ key: 'model.name', label: '默认模型', type: 'string', hint: 'settings.json 的 model.name' }],
};

export class GeminiLikeConfigAdapter implements AgentConfigAdapter {
  readonly kind: 'gemini' | 'qwen';
  readonly name: string;
  readonly mcpVia = 'cli' as const;
  readonly transports: McpSpec['transport'][] = ['stdio', 'http', 'sse'];
  constructor(private flavor: Flavor, private ctx: AdapterCtx) {
    this.kind = flavor.kind;
    this.name = flavor.name;
  }

  private dir() { return this.flavor.dir(cliEnv(this.ctx), homeOf(this.ctx)); }
  configPath() { return path.join(this.dir(), 'settings.json'); }
  files(cwd?: string) { return fileList(standardFiles(this.dir(), this.flavor.instructions, this.configPath(), cwd)); }

  async mcpList(): Promise<McpSpec[]> {
    const doc = await readConfig(this.configPath(), 'json');
    const servers = (doc.mcpServers ?? {}) as Record<string, any>;
    return Object.entries(servers).map(([name, s]) => {
      if (s.command) return { name, transport: 'stdio', command: s.command, args: s.args ?? [], env: s.env };
      // Gemini writes http as {url, type:'http'}; Qwen as {httpUrl}; a bare url is SSE in both
      if (s.httpUrl || s.type === 'http') return { name, transport: 'http', url: s.httpUrl ?? s.url, headers: s.headers };
      return { name, transport: 'sse', url: s.url, headers: s.headers };
    });
  }

  async mcpAdd(spec: McpSpec): Promise<string> {
    const args = ['mcp', 'add', '-s', 'user', '-t', spec.transport];
    for (const [k, v] of Object.entries(spec.env ?? {})) if (spec.transport === 'stdio') args.push('-e', `${k}=${v}`);
    for (const [k, v] of Object.entries(spec.headers ?? {})) if (spec.transport !== 'stdio') args.push('-H', `${k}: ${v}`);
    args.push(spec.name, spec.transport === 'stdio' ? spec.command! : spec.url!);
    // after `--` yargs takes everything literally — otherwise `docker run -e X --timeout 5 --trust` loses the
    // options it knows (they'd configure the server entry instead of being its arguments)
    if (spec.transport === 'stdio' && spec.args?.length) args.push('--', ...spec.args);
    let corrected = false;
    await this.ctx.backups.guard(this.kind, this.configPath(), `mcp add ${spec.name}`, () => runCliOk(this.ctx.cli(), args, { cwd: homeOf(this.ctx) }), (text) => {
      // the CLI can still lose data (gemini-cli 0.41 splits `-e K=a=b` at every `=`): compare what it wrote
      // with the spec and write the entry ourselves where they differ
      const next = this.correctEntry(text, spec);
      corrected = next !== null;
      return next;
    });
    return `已通过 ${this.kind} mcp add 添加（用户级）${corrected ? '，并按原值修正了 CLI 写错的字段' : ''}`;
  }

  /** The settings.json text with `mcpServers.<name>` fixed up to match `spec`, or null if the CLI got it right. */
  private correctEntry(text: string, spec: McpSpec): string | null {
    const doc = parseConfig(text, 'json') as any;
    const cur = doc.mcpServers?.[spec.name];
    if (!cur || typeof cur !== 'object') throw new Error(`${this.kind} mcp add 之后 settings.json 里没有 ${spec.name}`);
    const want: Record<string, unknown> = spec.transport === 'stdio'
      ? { command: spec.command, args: spec.args ?? [], env: spec.env && Object.keys(spec.env).length ? spec.env : undefined }
      : spec.transport === 'http'
        ? (this.kind === 'qwen' ? { httpUrl: spec.url, headers: spec.headers } : { url: spec.url, type: 'http', headers: spec.headers })
        : { url: spec.url, headers: spec.headers };
    const norm = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length ? undefined : v);
    const same = (a: unknown, b: unknown) => JSON.stringify(norm(a) ?? null) === JSON.stringify(norm(b) ?? null);
    const wrong = Object.keys(want).filter((k) => !same(cur[k], want[k]));
    if (!wrong.length) return null;
    const fixed = { ...cur };
    for (const k of wrong) { if (want[k] === undefined) delete fixed[k]; else fixed[k] = want[k]; }
    return setJsonPath(text, ['mcpServers', spec.name], fixed);
  }

  async mcpRemove(name: string): Promise<string> {
    const { result } = await this.ctx.backups.guard(this.kind, this.configPath(), `mcp remove ${name}`, () => runCliOk(this.ctx.cli(), ['mcp', 'remove', '-s', 'user', name], { cwd: homeOf(this.ctx) }));
    if (/not found/i.test(result.stdout + result.stderr)) throw new Error(`${this.name} 的用户设置里没有名为 ${name} 的 MCP 服务器`);
    return `已通过 ${this.kind} mcp remove 删除`;
  }

  async settings(): Promise<AgentSettingField[]> {
    const doc = await readConfig(this.configPath(), 'json');
    return this.flavor.fields.map((f) => ({ ...f, value: fieldValue(doc, f.key), ...(f.key === 'model.name' ? { suggestions: this.ctx.models() } : {}) }));
  }

  async setSetting(key: string, value: string | null): Promise<AgentConfigBackup | null> {
    checkField(this.flavor.fields, key, value);
    return this.ctx.backups.writeChecked(this.kind, this.configPath(), (t) => setJsonPath(t, key.split('.'), value || undefined), `设置 ${key}`);
  }
}
