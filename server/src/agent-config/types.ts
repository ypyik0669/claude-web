// Wire types for the agent configuration center (Codex / Gemini / Qwen / OpenCode). Re-exported from
// protocol.ts so the web client sees them through `@shared`. Types only — no runtime imports here.

export type AgentConfigKind = 'codex' | 'gemini' | 'qwen' | 'opencode';

/** One MCP server in agent-neutral form. `env` / `headers` values are masked (`••••••`) on the way out. */
export interface McpSpec {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** false = present in the config but disabled (Codex `enabled = false`, OpenCode `enabled: false`) */
  enabled?: boolean;
}

export interface AgentConfigFile {
  /** e.g. 「全局说明」「项目说明」「配置文件」 */
  label: string;
  path: string;
  exists: boolean;
  kind: 'instructions' | 'config';
  scope: 'global' | 'project';
}

export interface AgentSettingField {
  /** dotted path inside the config file (`model`, `model.name`, `general.defaultApprovalMode`) */
  key: string;
  label: string;
  type: 'enum' | 'string';
  options?: string[];
  /** suggestions for a free-text field (known model ids) */
  suggestions?: string[];
  value?: string;
  hint?: string;
}

export interface AgentConfigState {
  kind: AgentConfigKind;
  name: string;
  installed: boolean;
  version: string;
  /** the config file the settings / file-edited MCP live in */
  configPath: string;
  files: AgentConfigFile[];
  mcp: McpSpec[];
  /** set when the MCP list could not be read (CLI failed, file does not parse…) */
  mcpError?: string;
  /** how MCP changes are made: through the agent's own CLI, or a structured edit of its config file */
  mcpVia: 'cli' | 'file';
  /** transports this agent can take */
  transports: McpSpec['transport'][];
  settings: AgentSettingField[];
  settingsError?: string;
}

export interface AgentConfigBackup {
  id: string; // `<agent>/<backup file name>`
  agent: AgentConfigKind;
  /** the file that was backed up */
  path: string;
  at: number;
  reason: string;
  size: number;
  /** the file's state before the config center first touched it — never pruned */
  first?: boolean;
}

/** A Claude Code MCP server offered as a sync source (values masked). */
export interface ClaudeMcpEntry { scope: 'user' | 'local' | 'project'; spec: McpSpec }

export interface McpSyncResult { agent: AgentConfigKind; ok: boolean; message: string }

/** Where a synced MCP server comes from: a Claude server read server-side by name (secrets never reach the client), or a full spec. */
export type McpSyncSource = { claude: string; cwd?: string } | { spec: McpSpec };

export type AgentConfigRequest =
  | { kind: 'agentConfig.list'; cwd?: string }
  | { kind: 'agentConfig.get'; agent: AgentConfigKind; cwd?: string }
  | { kind: 'agentConfig.claudeMcp'; cwd?: string }
  | { kind: 'agentConfig.mcp.add'; agent: AgentConfigKind; spec: McpSpec; overwrite?: boolean }
  | { kind: 'agentConfig.mcp.remove'; agent: AgentConfigKind; name: string }
  | { kind: 'agentConfig.mcp.sync'; source: McpSyncSource; targets: AgentConfigKind[]; overwrite?: boolean }
  | { kind: 'agentConfig.set'; agent: AgentConfigKind; key: string; value: string | null }
  | { kind: 'agentConfig.createFile'; agent: AgentConfigKind; path: string; cwd?: string }
  | { kind: 'agentConfig.backups'; agent?: AgentConfigKind }
  | { kind: 'agentConfig.restore'; id: string };
