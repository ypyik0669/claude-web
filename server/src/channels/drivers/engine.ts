// Local engines (engines/): CLIProxyAPI and Magpie. The source is the engine; its provider profile (an
// Anthropic-format endpoint on 127.0.0.1) carries the models.
import { tr } from '../../i18n/index.js';
import type { EngineManager } from '../../engines/manager.js';
import type { EngineId, EngineStatus } from '../../engines/types.js';
import type { CatalogEntry, SourceHealth, SourceSummary } from '../types.js';
import { projectLinked } from './provider.js';
import type { AddInput, ChannelDriver, DriverContext } from './types.js';

function health(e: EngineStatus): SourceHealth {
  if (e.running && e.health === 'ok') return 'ready';
  if (e.health === 'error') return 'attention';
  if (e.installed || e.mode === 'connected') return 'disabled';
  return 'unconfigured';
}

/** A download that needs the user to confirm its SHA-256 (SEC-09) is never installed from here: send them to the panel. */
function needsConfirm(st: EngineStatus): void {
  if (st.confirm) throw new Error(tr('{name} {version} 要你先确认下载文件的 SHA-256：在它的面板里点「下载并启动」', { name: st.name, version: st.confirm.version }));
}

export class EngineDriver implements ChannelDriver {
  readonly kind = 'engine' as const;
  readonly needs = 'engine' as const;
  readonly id: `engine:${EngineId}`;

  constructor(private engines: EngineManager, readonly engine: EngineId) {
    this.id = `engine:${engine}`;
  }

  owns(sourceId: string) { return sourceId === this.id; }

  list(ctx: DriverContext): SourceSummary[] {
    const e = ctx.engines.find((x) => x.id === this.engine);
    if (!e) return [];
    // configured = installed, connected or has its provider; else it lives only in the catalog (with `detected`)
    if (!e.installed && e.mode !== 'connected' && !e.providerId) return [];
    const p = e.providerId ? ctx.providers.find((x) => x.id === e.providerId) : undefined;
    const entry = ctx.catalog.find((c) => c.id === this.engine);
    const models = p ? projectLinked(p, entry, false).models : [];
    return [{
      id: this.id,
      kind: 'engine',
      name: e.name,
      category: 'local-engine',
      health: health(e),
      ...(e.detail ? { detail: e.detail } : {}),
      models,
      ...(e.providerId ? { providerId: e.providerId } : {}),
      catalogId: this.engine,
      needs: 'engine',
      engine: {
        installed: e.installed,
        running: e.running,
        ...(e.version ? { version: e.version } : {}),
        ...(e.mode ? { mode: e.mode } : {}),
        ...(e.port ? { port: e.port } : {}),
        ...(e.detected ? { detected: e.detected } : {}),
        health: e.health,
        ...(e.warnings.length ? { warnings: e.warnings } : {}),
      },
      actions: { canAddAccount: false, canEditProvider: false, canManageEngine: true, canRemove: true },
    }];
  }

  /** Connect to the copy already running when there is one (with the key the user gave, if any), else install + start. */
  async add(_entry: CatalogEntry, input: AddInput): Promise<string> {
    const st = await this.engines.status(this.engine);
    if (st.detected && !st.running) await this.engines.connect(this.engine, st.detected.port, input.key);
    else needsConfirm(await this.engines.start(this.engine));
    return this.id;
  }

  async refresh(): Promise<void> {
    const st = await this.engines.status(this.engine);
    if (!st.running) throw new Error(st.detail || tr('{name} 没有在运行', { name: st.name }));
  }

  async remove(): Promise<void> { await this.engines.disconnect(this.engine); }
  async install(): Promise<void> { needsConfirm(await this.engines.install(this.engine)); }
  async start(): Promise<void> { needsConfirm(await this.engines.start(this.engine)); }
  async stop(): Promise<void> { await this.engines.stop(this.engine); }
}
