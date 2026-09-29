import type { EffortLevel, OpenSessionParams, PermissionMode, SessionInfoSnapshot } from '@shared';

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

interface ResumeSource {
  info?: SessionInfoSnapshot;
  resume?: ResumeChoice;
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
 * What the model / permission chips of a conversation that is not running show — and so what a send will resume
 * it with (final review §9 #1: every conversation after a restart is one of these): the user's pick on the chips,
 * else what it last had live in this window, else what the resume will really get — no model (the provider's /
 * account's / agent's default, which the chip names) and 每步询问. The transcript's last model is only a hint
 * (`lastModel`, the chip's tooltip): the answer names what the API ran (`claude-sonnet-5` for a `sonnet[1m]` pick,
 * a relay's upstream name), and resuming on it would pin the conversation to it (re-review I-1). The permission
 * mode is not read from the transcript at all: the SDK does not return it (re-review M-2).
 */
export function resumeView(o: ResumeSource, meta: { providerId?: string } | undefined): { providerId: string; model?: string; permissionMode: PermissionMode; effort?: EffortLevel; ultracode: boolean; lastModel?: string } {
  const r = o.resume ?? {};
  return {
    // live info knows the provider it ran on (none = the agent's own login); before that, the recorded one
    providerId: r.providerId ?? (o.info ? o.info.providerId || 'claude' : meta?.providerId ?? 'claude'),
    // '' = a picked default: shown by name like no model
    model: r.model !== undefined ? r.model || undefined : o.info?.model ?? undefined,
    permissionMode: r.permissionMode ?? o.info?.permissionMode ?? 'default',
    effort: r.effort ?? o.info?.effort ?? undefined,
    ultracode: r.ultracode ?? !!o.info?.ultracode,
    lastModel: lastAssistantModel(o.conv.items),
  };
}

/**
 * The params a send resumes a conversation that is not running with: what it last had live in this window
 * (`reopenSettings`), overridden by what the user picked on its chips. Nothing picked and no live info = exactly
 * `reopenSettings(undefined)` — the server and the CLI choose, as before the chips existed (re-review I-1). The
 * provider goes when the user picked one there, or when it last ran on the account while the server's record
 * (SessionMeta, which only ever records a profile) still names one — otherwise the server restores the recorded one.
 */
export function resumeParams(o: ResumeSource, meta?: { providerId?: string }): Pick<OpenSessionParams, 'providerId' | 'model' | 'effort' | 'permissionMode' | 'ultracode' | 'features'> {
  const out: Pick<OpenSessionParams, 'providerId' | 'model' | 'effort' | 'permissionMode' | 'ultracode' | 'features'> = { ...reopenSettings(o.info) };
  const r = o.resume ?? {};
  if (r.providerId) out.providerId = r.providerId;
  else if (o.info && !o.info.providerId && meta?.providerId && meta.providerId !== 'claude') out.providerId = 'claude';
  if (r.model !== undefined) { if (r.model) out.model = r.model; else delete out.model; }
  if (r.permissionMode) out.permissionMode = r.permissionMode;
  if (r.effort) out.effort = r.effort;
  if (r.ultracode !== undefined) { if (r.ultracode) out.ultracode = true; else delete out.ultracode; }
  return out;
}

/**
 * What the copy an edit-and-resend / rerun forks off starts with (re-review M-1): as the conversation would go on —
 * a running one with what it runs on (its live info and provider), one not running with its chips (resumeParams:
 * the picks over what it last had live). A provider goes explicitly when known: the fork gets a new id, and the
 * server would otherwise take the original's recorded one.
 */
export function forkParams(o: ResumeSource & { state: string }, meta?: { providerId?: string }): ReturnType<typeof resumeParams> {
  const running = o.state !== 'history' && o.state !== 'closed' && o.state !== 'error';
  if (!running) return resumeParams(o, meta);
  const out: ReturnType<typeof resumeParams> = { ...reopenSettings(o.info) };
  if (o.info?.providerId) out.providerId = o.info.providerId;
  // running on the account while the server still records a profile (older data): say so, as resumeParams does
  // (re-review n-2) — the fork would otherwise land on the recorded relay
  else if (o.info && meta?.providerId && meta.providerId !== 'claude') out.providerId = 'claude';
  return out;
}
