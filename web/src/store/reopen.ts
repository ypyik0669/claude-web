import type { EffortLevel, OpenSessionParams, PermissionMode, SessionInfoSnapshot } from '@shared';
import { PERMISSION_MODES } from '@/ui/terms';

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

/**
 * Chosen on the chips of a conversation that is not running: the params its next send resumes it with. `model: ''`
 * is a picked default (the account's / the profile's), not 「nothing picked」.
 */
export interface ResumeChoice { providerId?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; ultracode?: boolean }

/** The model the chips show: the pick ('' = the default, shown by name elsewhere), else live info, else the transcript's. */
function pickedModel(o: ResumeSource): string | undefined {
  if (o.resume?.model !== undefined) return o.resume.model || undefined;
  return o.info?.model ?? lastAssistantModel(o.conv.items);
}

interface ResumeSource {
  info?: SessionInfoSnapshot;
  resume?: ResumeChoice;
  /** the permission mode the transcript last recorded (loadHistory) */
  lastMode?: PermissionMode;
  conv: { items: readonly unknown[] };
}

/** The model of the last top-level answer (not a subagent's; Claude Code's `<synthetic>` error lines skipped). */
export function lastAssistantModel(items: readonly unknown[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as { kind?: string; model?: string; parentToolUseId?: string | null };
    if (it?.kind === 'assistant' && !it.parentToolUseId && it.model && it.model !== '<synthetic>') return it.model;
  }
  return undefined;
}

/**
 * The permission mode the transcript's last line carrying one had. Never 完全放开 (`danger`): resuming a
 * conversation in it is something to choose on its chip, not something a transcript turns on by itself.
 */
export function lastPermissionMode(msgs: readonly unknown[]): PermissionMode | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = (msgs[i] as { permissionMode?: unknown })?.permissionMode;
    if (typeof m !== 'string') continue;
    const mode = PERMISSION_MODES[m as PermissionMode];
    return mode && !mode.danger ? (m as PermissionMode) : undefined;
  }
  return undefined;
}

/**
 * What the model / permission chips of a conversation that is not running show — and so what a send will resume
 * it with (final review §9 #1: every conversation after a restart is one of these). The user's pick on the chips,
 * else what it last had live in this window, else its transcript (the last answer's model, the last recorded
 * mode), else the defaults: its recorded provider (SessionMeta.providerId) or the account, 每步询问.
 */
export function resumeView(o: ResumeSource, meta: { providerId?: string } | undefined): { providerId: string; model?: string; permissionMode: PermissionMode; effort?: EffortLevel; ultracode: boolean } {
  const r = o.resume ?? {};
  return {
    // live info knows the provider it ran on (none = the agent's own login); before that, the recorded one
    providerId: r.providerId ?? (o.info ? o.info.providerId || 'claude' : meta?.providerId ?? 'claude'),
    model: pickedModel(o),
    permissionMode: r.permissionMode ?? o.info?.permissionMode ?? o.lastMode ?? 'default',
    effort: r.effort ?? o.info?.effort ?? undefined,
    ultracode: r.ultracode ?? !!o.info?.ultracode,
  };
}

/**
 * The params a send resumes a conversation that is not running with: exactly what its chips show. The provider
 * goes when the user picked one there, or when it last ran on the account while the server's record (SessionMeta,
 * which only ever records a profile) still names one — otherwise the server restores the recorded one.
 */
export function resumeParams(o: ResumeSource, meta?: { providerId?: string }): Pick<OpenSessionParams, 'providerId' | 'model' | 'effort' | 'permissionMode' | 'ultracode' | 'features'> {
  const out: Pick<OpenSessionParams, 'providerId' | 'model' | 'effort' | 'permissionMode' | 'ultracode' | 'features'> = { ...reopenSettings(o.info) };
  const r = o.resume ?? {};
  if (r.providerId) out.providerId = r.providerId;
  else if (o.info && !o.info.providerId && meta?.providerId && meta.providerId !== 'claude') out.providerId = 'claude';
  const model = pickedModel(o);
  if (model) out.model = model;
  else delete out.model;
  const mode = r.permissionMode ?? o.info?.permissionMode ?? o.lastMode;
  if (mode) out.permissionMode = mode;
  if (r.effort) out.effort = r.effort;
  if (r.ultracode !== undefined) { if (r.ultracode) out.ultracode = true; else delete out.ultracode; }
  return out;
}
