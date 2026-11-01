import { randomUUID } from 'node:crypto';
import type { RunnerPool } from '../runtime/pool.js';
import type { MetaStore } from '../meta/store.js';
import { CLAUDE_PROVIDER_ID, type AgentKind, type OpenSessionParams, type SessionInfoSnapshot } from '../protocol.js';
import type { CanonicalLog } from './canonical.js';
import { renderBriefing, toClaudeEntries } from './handoff.js';
import { seedCanonical } from '../library/briefing.js';
import { tr } from '../i18n/index.js';
import { dropEmptyBlocks, findClaudeTranscript } from '../runtime/transcript-file.js';
import { isClaudeModel } from '../models/context-window.js';
import { providerModelId } from '../models/catalog.js';

/**
 * Swapping what is behind a live session without the user losing the session.
 *
 * A CLI's environment is fixed at spawn — a base URL or API key cannot be changed in place — so
 * "switch provider without restarting" can only mean an invisible restart: stop the child, spawn a
 * new one with the new env, resume from where the old one stopped, keep the same session id, title,
 * history and tiles. The user sees one system line, not a new session.
 */
export interface SwapDeps {
  pool: RunnerPool;
  canonical: CanonicalLog;
  meta: MetaStore;
}

export interface SwapResult {
  sessionId: string;
  info: SessionInfoSnapshot;
  history: unknown[];
}

async function stop(pool: RunnerPool, sessionId: string) {
  const r = pool.get(sessionId);
  if (!r) return null;
  const info = r.info;
  const midTurn = r.state === 'running' || r.state === 'waiting';
  // tell session watchers (orchestration) that the coming 'closed' is a handover to a new runner
  pool.emit('swapping', sessionId);
  await pool.close(sessionId).catch(() => { /* already gone */ });
  // a turn cut off by the switch never gets its result: windows kept it open (timer running, tool cards spinning)
  if (midTurn) {
    const text = tr('已切换，这一轮被中断了。需要的话把刚才的消息再发一次。');
    pool.emit('message', sessionId, {
      type: 'result', subtype: 'error_during_execution', is_error: true, result: text, errors: [text], terminal_reason: 'aborted_swap',
      duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], session_id: sessionId, uuid: randomUUID(),
    });
  }
  return info;
}

/**
 * Tell every window about the new process the moment it exists. The old one's 「closed」 has just gone out, and the
 * new runner speaks up only once its CLI has started — that can take many seconds — so until
 * then a window showed 「已关闭」 under the OLD model, and a send in that gap reopened the conversation on the old
 * provider (real-relay test 2026-10-01).
 */
function announce(pool: RunnerPool, r: { sessionId: string; info: unknown; state?: string }) {
  pool.emit('info', r.info);
  pool.emit('state', r.sessionId, r.state ?? 'starting');
}

/**
 * One swap at a time per session. setProvider closes the runner and opens a new one; two of them interleaving (a
 * double click, two windows) would open two processes on one session id. Not re-entrant: never call swapProvider
 * from inside a locked section of the same session.
 */
const swapLocks = new Map<string, Promise<unknown>>();
export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = swapLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  swapLocks.set(sessionId, tail);
  void tail.then(() => { if (swapLocks.get(sessionId) === tail) swapLocks.delete(sessionId); });
  return next;
}

/**
 * Resolves once nothing holds this conversation's lock: a message sent while its provider is being switched (the old
 * process closed, the new one not open yet) was refused "session … is not open" and lost — it waits instead.
 */
export function afterSwitch(sessionId: string): Promise<void> {
  const busy = swapLocks.get(sessionId);
  return busy ? busy.then(() => afterSwitch(sessionId)) : Promise.resolve();
}

export const normProvider = (id: string | undefined) => (id && id !== 'claude' ? id : undefined);

/**
 * What a provider change leaves behind — for a live swap (swapProvider) and for a conversation reopened on another
 * provider through the hub's `session.open` with an explicit providerId (a pick on the chips of a history
 * conversation, another window, a client whose state is stale; IM, schedules and orchestration open through the pool
 * and do not come this way): the recorded profile (SessionMeta.providerId; the account clears it, or a restart would
 * bring the old relay back) and the canonical `switch` line the hand-over briefing and usage attribution read
 * (fromProviderId: who answered the turns before it; 'claude' = the account). Callers hold the session's lock.
 */
export async function recordProviderSwitch(d: Pick<SwapDeps, 'meta' | 'canonical'>, sessionId: string, from: string | undefined, providerId: string | undefined, providerName: string): Promise<void> {
  // not fire-and-forget: a failed meta save would otherwise be an unhandled rejection that kills the server
  await d.meta.setSessionMeta(sessionId, { providerId: normProvider(providerId) }).catch(() => { /* kept in memory; the next save persists it */ });
  d.canonical.mark(sessionId, { providerId: normProvider(providerId), providerName, fromProviderId: normProvider(from) ?? 'claude', note: tr('已切换到供应商「{providerName}」', { providerName }) });
}

/**
 * `session.open` of an existing conversation with an explicit providerId (none = the recorded one, nothing to decide),
 * under the session's lock so two opens (two windows, a double send) are decided one after the other:
 * - running on another provider → the same as `session.setProvider`: swapProvider (close, respawn on the new env,
 *   record it) — `pool.open` would hand back the old runner and the pick would silently not happen (re-review m-3);
 * - running on that provider → a plain reattach;
 * - not running and the recorded provider differs (none recorded = the account) → open, then — only once it opened —
 *   the same bookkeeping as swapProvider (re-review n-3: a failed open leaves no record of a switch that never ran);
 * - otherwise a plain open.
 * So two opens racing on one idle conversation end with SessionMeta = the provider its process runs on: the first
 * opens and records, the second finds it running and swaps. Forks and rewinds get a new id and keep their own record.
 */
export function openOnProvider<T>(
  d: Pick<SwapDeps, 'pool' | 'meta' | 'canonical'>,
  params: OpenSessionParams,
  nameOf: (providerId: string) => string,
  hooks: { open: (p: OpenSessionParams) => Promise<T>; swapped: (r: SwapResult) => T; onRecorded?: () => void },
): Promise<T> {
  const sid = params.sessionId && !params.fork && !params.resumeAt ? params.sessionId : undefined;
  const to = params.providerId;
  if (!sid) return hooks.open(params);
  // a plain open waits for a switch in progress too: during one the old runner is gone and the new one not there yet,
  // so the open started a process on the provider still on record — and the switch then got that process back and
  // recorded a provider it was not running on (2026-10-01, real relays)
  if (to === undefined) return withSessionLock(sid, () => hooks.open(params));
  return withSessionLock(sid, async () => {
    const live = d.pool.get(sid);
    if (live && live.state !== 'closed' && live.state !== 'error') {
      if (normProvider(live.info.providerId) === normProvider(to)) return hooks.open(params);
      const r = await swapProviderNow(d, sid, to, nameOf(to), params.model);
      hooks.onRecorded?.();
      return hooks.swapped(r);
    }
    const from = d.meta.sessionMeta(sid).providerId;
    if (normProvider(to) === normProvider(from)) return hooks.open(params);
    await cleanForAnotherProvider(d, sid, to, params.model);
    const out = await hooks.open(params);
    await d.canonical.ensure(sid, params.cwd); // a CLI conversation that never ran here has no mirror yet
    await recordProviderSwitch(d, sid, from, to, nameOf(to));
    hooks.onRecorded?.();
    return out;
  });
}

/**
 * The next provider reads this history: take out the blocks one vendor's API wrote and another's refuses for good
 * (DeepSeek's blank unsigned thinking → Claude's 400, 2026-10-19; see dropEmptyBlocks). Called under the session lock
 * with no process of ours on the file.
 */
async function cleanForAnotherProvider(d: Pick<SwapDeps, 'meta' | 'canonical'>, sessionId: string, providerId: string | undefined, model: string | undefined) {
  const toClaude = goesToClaude(d, providerId, model);
  // a thinking signature is only good where it was issued: what another provider signed goes (the account's own stays)
  const switches = toClaude ? await d.canonical.providerSwitches(sessionId).catch(() => []) : [];
  const at = providerAt(switches);
  const target = normProvider(providerId);
  const foreign = switches.length ? (ts: number) => Number.isFinite(ts) && at(ts) !== target : undefined;
  if (dropEmptyBlocks(findClaudeTranscript(sessionId), { unsigned: toClaude, foreign })) console.warn(`[swap] ${sessionId}: blocks the next provider refuses taken out of the transcript`);
}

/**
 * Which provider (undefined = the account) the conversation ran on at a moment, from its recorded switches: before the
 * first, the one that switch came from; after each, the one it went to.
 */
export function providerAt(switches: readonly { t: number; providerId?: string; fromProviderId?: string }[]): (ts: number) => string | undefined {
  const list = [...switches].sort((a, b) => a.t - b.t);
  return (ts) => {
    let cur = normProvider(list[0]?.fromProviderId);
    for (const s of list) { if (s.t > ts) break; cur = normProvider(s.providerId); }
    return cur;
  };
}

/**
 * Whether the conversation goes on with a Claude model — whose API refuses another vendor's (unsigned) thinking:
 * 「Invalid `signature` in `thinking` block」 (2026-10-19, DeepSeek → Opus). Unknown: no (the runner's 400 still repairs).
 */
function goesToClaude(d: Pick<SwapDeps, 'meta'>, providerId: string | undefined, model: string | undefined): boolean {
  const id0 = normProvider(providerId);
  if (!id0) return !model || isClaudeModel(model.replace(/^cw-x:[^:]*:/, '')); // the Claude account
  const p = d.meta.provider(id0);
  if (!p) return false;
  if (p.type === 'claude-account') return true;
  const id = providerModelId(p, model);
  return !!id && isClaudeModel(id);
}

/**
 * A different provider profile: close, respawn with the new env, resume in place.
 * `model`: what to start on. Omitted on a real profile change = the new profile's / login's default — the old
 * profile's model id rarely exists behind another endpoint; omitted on the same profile = keep the current one.
 */
export function swapProvider(d: SwapDeps, sessionId: string, providerId: string | undefined, providerName: string, model?: string): Promise<SwapResult> {
  // the lock lives here, not in the hub: federation hand-overs, orchestration and IM reach these without the hub
  return withSessionLock(sessionId, () => swapProviderNow(d, sessionId, providerId, providerName, model));
}
async function swapProviderNow(d: Pick<SwapDeps, 'pool' | 'meta' | 'canonical'>, sessionId: string, providerId: string | undefined, providerName: string, model?: string): Promise<SwapResult> {
  const live = d.pool.get(sessionId);
  const before = normProvider(live ? live.info.providerId : d.meta.sessionMeta(sessionId).providerId);
  const changed = before !== normProvider(providerId);
  const prev = await stop(d.pool, sessionId);
  const cwd = prev?.cwd ?? (await d.canonical.head(sessionId))?.cwd ?? process.cwd();

  const params: OpenSessionParams = {
    sessionId,
    cwd,
    model: model || (changed ? undefined : prev?.model ?? undefined),
    effort: prev?.effort ?? undefined,
    permissionMode: prev?.permissionMode,
    features: prev?.features,
    // the account is a choice too: "not given" would let the pool resume on the provider still on record — the window
    // said 「Claude 账号」 while the provider kept answering (and billing; 2026-10-01, real relays)
    providerId: providerId ?? CLAUDE_PROVIDER_ID,
  };
  if (changed) await cleanForAnotherProvider(d, sessionId, params.providerId, params.model);
  let r = d.pool.open(params);
  // something reopened it in the gap on the provider still on record (IM / schedules / goals open through the pool, not
  // under this lock): that process is not the switch — replace it, so the record below is what really runs
  if (normProvider(r.info.providerId) !== normProvider(params.providerId)) {
    await d.pool.close(sessionId).catch(() => { /* already gone */ });
    r = d.pool.open(params);
  }
  announce(d.pool, r);
  // recorded once the new process exists (re-review n-3): an open that throws (a key that no longer decrypts) leaves
  // the old provider on record, which is what the next open should use
  await recordProviderSwitch(d, sessionId, before, providerId, providerName);
  return { sessionId: r.sessionId, info: r.info, history: r.getHistory() };
}

/**
 * Going on HERE with a conversation that lives somewhere else (another machine's, `peers.handover`): always a NEW
 * Claude session — a fresh UUID — seeded with a briefing built from that history, which it resumes from as
 * synthesized entries. The other conversation is not touched; the new one runs in `src.cwd`, never this process's.
 */
export async function handOverToClaude(d: SwapDeps, fromId: string, src: { agent: AgentKind; cwd: string; title?: string }, readAll: () => Promise<any[]>, model: string | undefined, objective?: string): Promise<SwapResult> {
  const native = await readAll(); // no history → no hand-over (don't start an empty session)
  const sessionId = randomUUID();
  const cwd = src.cwd;
  await d.canonical.ensure(sessionId, cwd);
  if (native.length) await seedCanonical(d.canonical, sessionId, native);
  const events = await d.canonical.load(sessionId);
  const briefing = renderBriefing(events, { fromAgent: src.agent, toAgent: 'claude', cwd, objective }).text;
  d.canonical.mark(sessionId, { agent: 'claude', model, note: tr('已从 {agent} 的对话 {fromId} 交接给 {agent2}', { agent: src.agent, fromId, agent2: 'claude' }) });
  const params: OpenSessionParams = { sessionId, cwd, model, resumeEntries: toClaudeEntries(events, { cwd, sessionId, briefing }) };
  const r = d.pool.open(params);
  return { sessionId: r.sessionId, info: r.info, history: r.getHistory() };
}
