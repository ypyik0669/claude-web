import { runClaudeCli } from '../claude-exe.js';

export interface McpHealth { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'unknown'; detail: string }
export interface RegistryServer { name: string; description: string; repo?: string; install?: { transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string; env?: string[] }; kind: 'npm' | 'pypi' | 'remote' | 'other' }

/** MCP helpers on top of the CLI: connection health (`claude mcp list`) and the official registry search. */
export class McpService {
  async health(cwd?: string): Promise<McpHealth[]> {
    const r = await runClaudeCli(['mcp', 'list'], { cwd, timeoutMs: 60_000 });
    const out: McpHealth[] = [];
    for (const raw of `${r.stdout}\n${r.stderr}`.split('\n')) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
      const m = /^([\w.-]+):\s*(.*?)\s*-\s*(.+)$/.exec(line);
      if (!m) continue;
      const tail = m[3].toLowerCase();
      out.push({ name: m[1], status: tail.includes('connected') && !tail.includes('failed') ? 'connected' : tail.includes('auth') ? 'needs-auth' : tail.includes('fail') ? 'failed' : 'unknown', detail: m[3] });
    }
    return out;
  }

  /** Search the official registry (registry.modelcontextprotocol.io) and turn entries into install specs. */
  async registry(q: string, limit = 20): Promise<RegistryServer[]> {
    const u = new URL('https://registry.modelcontextprotocol.io/v0/servers');
    if (q.trim()) u.searchParams.set('search', q.trim());
    u.searchParams.set('limit', String(limit));
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`注册表 ${res.status}`);
    const j: any = await res.json();
    const list: any[] = j.servers ?? j.data ?? [];
    return list.map((raw) => {
      const s = raw.server ?? raw;
      const pkg = (s.packages ?? [])[0];
      const remote = (s.remotes ?? [])[0];
      let install: RegistryServer['install'] | undefined;
      let kind: RegistryServer['kind'] = 'other';
      if (pkg) {
        const reg = (pkg.registry_name ?? pkg.registryType ?? pkg.registry_type ?? '').toLowerCase();
        const id = pkg.identifier ?? pkg.name;
        const envs = (pkg.environment_variables ?? pkg.environmentVariables ?? []).map((e: any) => e.name);
        if (reg === 'npm') { kind = 'npm'; install = { transport: 'stdio', command: 'npx', args: ['-y', id], env: envs }; }
        else if (reg === 'pypi') { kind = 'pypi'; install = { transport: 'stdio', command: 'uvx', args: [id], env: envs }; }
      }
      if (!install && remote) { kind = 'remote'; install = { transport: (remote.transport_type ?? remote.type ?? 'http').includes('sse') ? 'sse' : 'http', url: remote.url }; }
      return { name: s.name ?? raw.name, description: s.description ?? '', repo: s.repository?.url, install, kind };
    });
  }
}
