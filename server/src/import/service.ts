import type { ImportItem, ImportResult, ImportScan, Provider } from '../protocol.js';
import fs from 'node:fs';
import path from 'node:path';
import { scanAll, type Usable, type FoundProvider, type McpConfig, type ScanResult } from './scan.js';

export interface ImportDeps {
  providers: {
    /** a saved provider with this endpoint and this key already (same kind, same base URL, same key) */
    hasSame(type: Provider['type'], baseUrl: string, apiKey: string): boolean;
    upsert(p: Partial<Provider>): Promise<Provider>;
  };
  mcp: {
    /** the MCP servers already configured for Claude Code (user scope) */
    names(): Promise<Set<string>>;
    add(name: string, json: string): Promise<{ code: number; stderr?: string }>;
  };
  scan?: () => Promise<ScanResult>;
}

/** A command given as a full path (not `npx`, not a name looked up on PATH) whose file is gone. */
export function commandMissing(c: McpConfig): boolean {
  if (!('command' in c) || !path.isAbsolute(c.command)) return false;
  return !fs.existsSync(c.command);
}

const detail = (f: Usable) => (f.kind === 'provider' ? f.baseUrl : 'command' in f.config ? [f.config.command, ...(f.config.args ?? [])].join(' ') : f.config.url);

/** 从其它工具导入: what the scan found, as the window shows it (no key), and taking the picked items in. */
export class ImportService {
  constructor(private deps: ImportDeps) {}

  private found() { return (this.deps.scan ?? scanAll)(); }

  async scan(): Promise<ImportScan> {
    const r = await this.found();
    const names = await this.deps.mcp.names().catch(() => new Set<string>());
    const items: ImportItem[] = r.found.map((f) => ({
      key: f.key,
      kind: f.kind,
      from: f.from,
      name: f.name,
      detail: detail(f).slice(0, 300),
      ...(f.kind === 'provider' ? { type: f.type, hasKey: !!f.apiKey, models: f.models?.length ?? 0 } : {}),
      already: f.kind === 'provider' ? this.deps.providers.hasSame(f.type, f.baseUrl, f.apiKey) : names.has(f.name),
      ...(f.kind === 'mcp' && commandMissing(f.config) ? { missing: true } : {}),
    }));
    return { items, unreadable: r.unreadable, scanned: r.scanned };
  }

  /** Read again and take what was picked: providers into the provider list, MCP servers into Claude Code's (user). */
  async run(keys: string[]): Promise<ImportResult> {
    const want = new Set(keys);
    const r = await this.found();
    const names = await this.deps.mcp.names().catch(() => new Set<string>());
    const out: ImportResult = { providers: [], mcp: [], skipped: [], failed: [] };
    for (const f of r.found) {
      if (!want.has(f.key)) continue;
      want.delete(f.key);
      try {
        if (f.kind === 'provider') {
          if (this.deps.providers.hasSame(f.type, f.baseUrl, f.apiKey)) { out.skipped.push(f.key); continue; }
          const p = await this.deps.providers.upsert(providerOf(f));
          out.providers.push(p.id);
        } else {
          // a name Claude Code already has is that server's: an import never replaces it
          if (names.has(f.name)) { out.skipped.push(f.key); continue; }
          const res = await this.deps.mcp.add(f.name, JSON.stringify(f.config));
          if (res.code !== 0) throw new Error((res.stderr || '').trim().split('\n').pop() || `exit ${res.code}`);
          names.add(f.name);
          out.mcp.push(f.name);
        }
      } catch (e) {
        out.failed.push({ key: f.key, error: (e as Error).message.slice(0, 300) });
      }
    }
    // gone between the scan and the import (the other tool changed it)
    for (const k of want) out.failed.push({ key: k, error: 'gone' });
    return out;
  }
}

export function providerOf(f: FoundProvider & { type: 'anthropic' }): Partial<Provider> {
  return {
    name: f.name,
    type: f.type,
    baseUrl: f.baseUrl,
    apiKey: f.apiKey,
    ...(f.models?.length ? { models: f.models } : {}),
    ...(f.defaultModel ? { defaultModel: f.defaultModel } : {}),
    ...(f.modelMap && Object.keys(f.modelMap).length ? { modelMap: f.modelMap } : {}),
  };
}

/** Two base URLs of one endpoint: case, a trailing slash and a trailing `/v1` do not make another one. */
export const sameBase = (a: string, b: string) => {
  const n = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '');
  return n(a) === n(b);
};
