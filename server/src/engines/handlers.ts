// Hub dispatch for `engines.*` (kept out of hub.ts). No sessionId on any of these: no federation routing entry.
import { tr } from '../i18n/index.js';
import type { EngineManager, InstallOptions } from './manager.js';
import { MANIFESTS } from './manifests/index.js';
import type { EngineId, EngineRequest } from './types.js';

const KINDS = new Set(['engines.status', 'engines.install', 'engines.upgrade', 'engines.rollback', 'engines.start', 'engines.stop', 'engines.uninstall', 'engines.connect', 'engines.logs', 'engines.login.providers', 'engines.login.begin', 'engines.login.status', 'engines.login.cancel', 'engines.login.import']);

export const isEngineRequest = (req: { kind: string }): req is EngineRequest => KINDS.has(req.kind);

const engineId = (id: unknown): EngineId => {
  if (typeof id !== 'string' || !(id in MANIFESTS)) throw new Error(tr('没有这个托管程序：{id}', { id: String(id) }));
  return id as EngineId;
};

/**
 * The user's confirmation of one downloaded file (SEC-09): only from their click on the hash dialog, and only with the
 * hash they saw — allowUnverified without a sha256 installs nothing (manager.consented).
 */
const consent = (req: { allowUnverified?: unknown; sha256?: unknown }): InstallOptions =>
  req.allowUnverified === true && typeof req.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(req.sha256.trim())
    ? { allowUnverified: true, sha256: req.sha256.trim().toLowerCase() }
    : {};

/**
 * `remote`: a federation peer, a remote-access browser or a paired phone. They may read the status; everything
 * else downloads / runs programs on this computer or reads their logs (upstream errors, OAuth messages), so it is
 * for a window on this computer only (review E4).
 */
export async function handleEngineRequest(svc: EngineManager, req: EngineRequest, remote = false): Promise<unknown> {
  if (remote && req.kind !== 'engines.status') throw new Error(tr('只有本机的桌面窗口才能管理托管程序'));
  switch (req.kind) {
    case 'engines.status': return { engines: await svc.statuses() };
    case 'engines.install': return svc.install(engineId(req.id), typeof req.version === 'string' && req.version ? req.version : undefined, consent(req));
    case 'engines.upgrade': return svc.upgrade(engineId(req.id), consent(req));
    case 'engines.rollback': return svc.rollback(engineId(req.id));
    case 'engines.start': return svc.start(engineId(req.id));
    case 'engines.stop': return svc.stop(engineId(req.id));
    case 'engines.uninstall': return svc.uninstall(engineId(req.id));
    case 'engines.connect': return svc.connect(engineId(req.id), typeof req.port === 'number' ? req.port : undefined, typeof req.key === 'string' ? req.key : undefined);
    case 'engines.logs': return { text: await svc.logs(engineId(req.id), typeof req.lines === 'number' ? req.lines : 200) };
    case 'engines.login.providers': return { providers: svc.loginProviders() };
    case 'engines.login.begin': return svc.loginBegin(engineId(req.id), req.provider);
    case 'engines.login.status': return svc.loginStatus(engineId(req.id), req.loginId);
    case 'engines.login.cancel': await svc.loginCancel(engineId(req.id), req.loginId); return null;
    case 'engines.login.import': return svc.loginImport(engineId(req.id), req.provider, req.text);
  }
  throw new Error(`unknown engine request ${(req as { kind: string }).kind}`);
}
