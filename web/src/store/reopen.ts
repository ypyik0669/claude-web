import type { OpenSessionParams, SessionInfoSnapshot } from '@shared';

/**
 * What a session that is transparently reopened (reaped after idling, crashed, opened from history) should
 * come back with: the model, effort, permission mode, deep-orchestration switch and features the user last
 * had. The provider profile is not included: the server restores it from SessionMeta.providerId.
 */
export function reopenSettings(info: SessionInfoSnapshot | undefined | null): Pick<OpenSessionParams, 'model' | 'effort' | 'permissionMode' | 'ultracode' | 'features'> {
  if (!info) return {};
  const out: Pick<OpenSessionParams, 'model' | 'effort' | 'permissionMode' | 'ultracode' | 'features'> = {};
  if (info.model) out.model = info.model;
  if (info.effort) out.effort = info.effort;
  if (info.permissionMode) out.permissionMode = info.permissionMode;
  if (info.ultracode) out.ultracode = true;
  if (info.features && Object.keys(info.features).length) out.features = info.features;
  return out;
}
