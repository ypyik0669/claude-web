// 值班 Bot: what a window may send as a bot (bots.create / bots.update). Only a bot's own fields, each checked;
// what the server owns (id, manager, times, a routine's lastRunAt / nextRunAt / failures, policy.unleashed) is never
// taken from the request, and an edit is merged into the stored bot field by field.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ActionClass, Bot, BotBudget, BotCharter, BotOutput, BotPolicy, BotTier, PolicyLevel, PolicyRule, PolicyScope, Routine } from '../protocol.js';
import { nextCron } from '../schedules/cron.js';
import { MAX_FAILURES } from './pipeline.js';
import { tr } from '../i18n/index.js';

/** what a create / an update decides; the service adds id / manager / times */
export type BotFields = Omit<Bot, 'id' | 'manager' | 'createdAt' | 'updatedAt'>;

const SAFE_ID = /^[\w-]+$/;
const TIERS: BotTier[] = ['cheap', 'balanced', 'best'];
const CLASSES: ActionClass[] = ['read', 'write_local', 'browser', 'send', 'pay', 'delete', 'install'];
const LEVELS: PolicyLevel[] = ['do', 'do_tell', 'ask', 'deny'];
const ON_FAIL: Routine['onFail'][] = ['retry_up', 'resume', 'inbox'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const bad = (field: string): never => { throw new Error(tr('Bot 设置不对：{field}', { field })); };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v: unknown, field: string): string => (typeof v === 'string' ? v : bad(field));
const optStr = (v: unknown, field: string): string | undefined => (v === undefined || v === null || v === '' ? undefined : str(v, field));
const arr = <T>(v: unknown, field: string): T[] => (Array.isArray(v) ? (v as T[]) : bad(field));
const money = (v: unknown, field: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : bad(field);
};
const newRoutineId = () => `r_${randomBytes(3).toString('hex')}`;

/** a key the request has: its checked value; absent: the stored one */
function pick<T>(o: Record<string, unknown>, k: string, prev: T, check: (v: unknown) => T): T { return has(o, k) ? check(o[k]) : prev; }
/** drops undefined values, so an absent field doesn't land as a key in bot.json */
function compact<T extends object>(o: T): T { for (const k of Object.keys(o)) if ((o as any)[k] === undefined) delete (o as any)[k]; return o; }

function charterOf(v: unknown, prev?: BotCharter): BotCharter {
  if (!isObj(v)) return bad('charter');
  const p: Partial<BotCharter> = prev ?? {};
  return compact({
    role: pick(v, 'role', p.role ?? '', (x) => str(x, 'charter.role')),
    audience: pick(v, 'audience', p.audience, (x) => optStr(x, 'charter.audience')),
    sources: pick(v, 'sources', p.sources ?? [], (x) => arr<unknown>(x, 'charter.sources').map((s) => str(s, 'charter.sources'))),
    report: pick(v, 'report', p.report, (x) => optStr(x, 'charter.report')),
    done: pick(v, 'done', p.done, (x) => optStr(x, 'charter.done')),
  });
}

const SCOPE_KEYS = ['recipients', 'domains', 'channels', 'maxAmount', 'perDay', 'until', 'unlimited'];
/**
 * A PolicyScope, checked all the way down (rules, autoPilot, an approve_scope answer): lists of non-empty strings
 * (domains lower-cased), amounts / counts finite and >= 0, `until` a finite timestamp, `unlimited` strictly boolean.
 * Unknown keys are refused too: the gate would silently ignore them.
 */
export function policyScope(v: unknown, field = 'scope'): PolicyScope {
  if (!isObj(v)) return bad(field);
  for (const k of Object.keys(v)) if (!SCOPE_KEYS.includes(k)) bad(`${field}.${k}`);
  const list = (k: string, lower = false) => {
    if (v[k] === undefined) return undefined;
    const a = arr<unknown>(v[k], `${field}.${k}`).map((x) => (typeof x === 'string' && x.trim() ? x.trim() : bad(`${field}.${k}`)));
    return lower ? a.map((x) => x.toLowerCase()) : a;
  };
  const n = (k: string) => (v[k] === undefined ? undefined : typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0 ? (v[k] as number) : bad(`${field}.${k}`));
  return compact({
    recipients: list('recipients'), domains: list('domains', true), channels: list('channels'),
    maxAmount: n('maxAmount'), perDay: n('perDay'), until: n('until'),
    unlimited: v.unlimited === undefined ? undefined : typeof v.unlimited === 'boolean' ? v.unlimited : bad(`${field}.unlimited`),
  });
}
/**
 * A scope that lets more run (a non-deny rule, an approve_scope answer, autopilot, an adopted trust_up) must name
 * WHERE it applies: rules.ts scopeMatches treats a scope with no domains / channels / recipients as every
 * destination, so `{ perDay: 5 }` would mean "anywhere, 5 a day". A payment one also needs maxAmount. Only
 * `unlimited: true` (anywhere, said outright) is exempt. Deny rules take any scope (policyScope).
 */
export function allowScope(v: unknown, field = 'scope', cls?: ActionClass): PolicyScope {
  const s = policyScope(v, field);
  if (s.unlimited === true) return s;
  if (!s.domains?.length && !s.channels?.length && !s.recipients?.length) throw new Error(tr('放宽的范围要写明用在哪里（域名、频道或收件人）：{field}', { field }));
  if (cls === 'pay' && s.maxAmount === undefined) throw new Error(tr('付款的放宽范围要写上限金额：{field}', { field }));
  return s;
}
function scopeOf(v: unknown, field: string, allow: boolean, cls?: ActionClass): PolicyScope | undefined {
  return v === undefined || v === null ? undefined : allow ? allowScope(v, field, cls) : policyScope(v, field);
}
/** one policy rule, checked (a wider rule must name where); exported for the bot-self propose_policy */
export function ruleOf(v: unknown): PolicyRule {
  if (!isObj(v) || !CLASSES.includes(v.cls) || !LEVELS.includes(v.level)) return bad('policy.rules');
  return compact({ cls: v.cls, level: v.level, scope: scopeOf(v.scope, 'policy.rules.scope', v.level !== 'deny', v.cls) });
}
/** `unleashed` is bots.unleash's alone: always the stored value */
function policyOf(v: unknown, prev?: BotPolicy): BotPolicy {
  if (!isObj(v)) return bad('policy');
  const p: Partial<BotPolicy> = prev ?? {};
  return compact({
    rules: pick(v, 'rules', p.rules ?? [], (x) => arr<unknown>(x, 'policy.rules').map(ruleOf)),
    autoPilot: pick(v, 'autoPilot', p.autoPilot, (x) => {
      if (x === undefined || x === null) return undefined;
      if (!isObj(x) || typeof x.on !== 'boolean') return bad('policy.autoPilot');
      const scope = scopeOf(x.scope, 'policy.autoPilot.scope', true);
      // 全自动 with no scope would be everywhere: it has to name where (or say unlimited outright), like any wider scope
      if (x.on && !scope) throw new Error(tr('放宽的范围要写明用在哪里（域名、频道或收件人）：{field}', { field: 'policy.autoPilot.scope' }));
      return compact({ on: x.on, scope });
    }),
    signOff: pick(v, 'signOff', p.signOff, (x) => (x === undefined || x === null ? undefined : typeof x === 'boolean' ? x : bad('policy.signOff'))),
    unleashed: p.unleashed,
  });
}

function budgetOf(v: unknown, prev?: BotBudget): BotBudget {
  if (!isObj(v)) return bad('budget');
  const p: BotBudget = prev ?? {};
  return compact({
    dailyUsd: pick(v, 'dailyUsd', p.dailyUsd, (x) => money(x, 'budget.dailyUsd')),
    weeklyUsd: pick(v, 'weeklyUsd', p.weeklyUsd, (x) => money(x, 'budget.weeklyUsd')),
    explorePct: pick(v, 'explorePct', p.explorePct, (x) => money(x, 'budget.explorePct')),
  });
}

function quietOf(v: unknown, prev?: Bot['quiet']): Bot['quiet'] {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) return bad('quiet');
  const from = has(v, 'from') ? v.from : prev?.from;
  const to = has(v, 'to') ? v.to : prev?.to;
  if (typeof from !== 'string' || !HHMM.test(from) || typeof to !== 'string' || !HHMM.test(to)) return bad('quiet');
  return { from, to };
}

function outputOf(v: unknown): BotOutput {
  if (!isObj(v)) return bad('outputs');
  if (v.kind === 'inbox') return { kind: 'inbox' };
  if (v.kind === 'im') return { kind: 'im', gatewayId: str(v.gatewayId, 'outputs.gatewayId'), chatId: str(v.chatId, 'outputs.chatId') };
  if (v.kind === 'file') {
    const p = str(v.path, 'outputs.path');
    return path.isAbsolute(p) ? { kind: 'file', path: p } : bad('outputs.path');
  }
  return bad('outputs.kind');
}

/**
 * One routine. What the scheduler owns comes from the stored routine of that id: lastRunAt, nextRunAt (dropped when
 * the cadence changed, so the next tick plans it again), failures. A routine the pipeline turned off after
 * MAX_FAILURES stays off unless this request turns it on knowing that: enabled true with failures at least the stored
 * count (it saw the failures; failures then reset to 0). A window that hadn't seen it turned off still holds a lower
 * count (often 0), so its edit can't revive it. `selfMade` is never the client's; onFail omitted keeps the stored one.
 * Exported for adopted routine proposals (scheduler): same checks, no stored routine.
 */
export function routineOf(v: unknown, prevs: Map<string, Routine>): Routine {
  if (!isObj(v)) return bad('routines');
  const id = typeof v.id === 'string' && SAFE_ID.test(v.id) ? v.id : newRoutineId();
  const prev = prevs.get(id);
  const cron = optStr(v.cron, 'routines.cron');
  if (cron) { try { nextCron(cron); } catch { bad('routines.cron'); } }
  const every = v.everyMinutes === undefined || v.everyMinutes === null ? undefined : v.everyMinutes;
  if (every !== undefined && !(typeof every === 'number' && Number.isInteger(every) && every >= 1)) bad('routines.everyMinutes');
  const acc = v.acceptance;
  const acceptance: Routine['acceptance'] = acc === undefined || acc === null || (isObj(acc) && acc.kind === 'none') ? { kind: 'none' }
    : isObj(acc) && acc.kind === 'script' ? { kind: 'script', script: str(acc.script, 'routines.acceptance') } : bad('routines.acceptance');
  const onFail = v.onFail === undefined ? (prev?.onFail ?? 'inbox') : ON_FAIL.includes(v.onFail) ? v.onFail : bad('routines.onFail');
  const timeoutMin = v.timeoutMin === undefined || v.timeoutMin === null ? undefined
    : typeof v.timeoutMin === 'number' && Number.isFinite(v.timeoutMin) && v.timeoutMin > 0 ? v.timeoutMin : bad('routines.timeoutMin');
  let enabled = v.enabled === undefined ? (prev?.enabled ?? true) : typeof v.enabled === 'boolean' ? v.enabled : bad('routines.enabled');
  let failures = prev?.failures;
  if (prev && !prev.enabled && (prev.failures ?? 0) >= MAX_FAILURES && enabled) {
    const seen = typeof v.failures === 'number' ? v.failures : -1;
    if (seen >= (prev.failures ?? 0)) failures = 0;
    else enabled = false;
  }
  const sameCadence = prev && prev.cron === cron && prev.everyMinutes === every;
  return compact({
    id, name: str(v.name ?? prev?.name ?? '', 'routines.name'), prompt: str(v.prompt ?? prev?.prompt ?? '', 'routines.prompt'),
    cron, everyMinutes: every, enabled, precheck: optStr(v.precheck, 'routines.precheck'), acceptance, timeoutMin, onFail,
    failures, nextRunAt: sameCadence ? prev.nextRunAt : undefined, lastRunAt: prev?.lastRunAt,
    selfMade: prev?.selfMade, shadow: typeof v.shadow === 'boolean' ? v.shadow : prev?.shadow,
  });
}

/**
 * A bot from a request: `prev` = the stored bot (an update: missing keys keep it, objects merge field by field,
 * policy.rules replaced only when sent); none = a create (the required fields must be there).
 */
export function botFields(input: unknown, prev?: Bot): BotFields {
  if (!isObj(input)) return bad('bot');
  const v = input;
  const req = <T>(k: string, check: (x: unknown) => T, cur: T | undefined): T => (has(v, k) ? check(v[k]) : cur !== undefined ? cur : bad(k));
  const name = req('name', (x) => { const n = str(x, 'name').trim(); return n || bad('name'); }, prev?.name);
  const cwd = req('cwd', (x) => { const c = str(x, 'cwd'); return path.isAbsolute(c) ? c : bad('cwd'); }, prev?.cwd);
  const tier = req('tier', (x) => (TIERS.includes(x as BotTier) ? (x as BotTier) : bad('tier')), prev?.tier ?? 'balanced');
  const charter = req('charter', (x) => charterOf(x, prev?.charter), prev?.charter);
  const policy = req('policy', (x) => policyOf(x, prev?.policy), prev?.policy ?? { rules: [] });
  const budget = req('budget', (x) => budgetOf(x, prev?.budget), prev?.budget ?? {});
  const prevs = new Map((prev?.routines ?? []).map((r) => [r.id, r]));
  const routines = req('routines', (x) => arr<unknown>(x, 'routines').map((r) => routineOf(r, prevs)), prev?.routines);
  if (new Set(routines.map((r) => r.id)).size !== routines.length) bad('routines.id');
  if (prev?.manager && routines.length) bad('routines'); // phase 1: the manager does no work of its own
  const outputs = req('outputs', (x) => arr<unknown>(x, 'outputs').map(outputOf), prev?.outputs);
  const num = (k: string, cur: number | undefined) => pick(v, k, cur, (x) => money(x, k));
  const flag = (k: string, cur: boolean | undefined) => pick(v, k, cur, (x) => (x === undefined || x === null ? undefined : typeof x === 'boolean' ? x : bad(k)));
  return compact({
    name, cwd, tier, charter, policy, budget, routines, outputs,
    avatar: pick(v, 'avatar', prev?.avatar, (x) => optStr(x, 'avatar')),
    providerId: pick(v, 'providerId', prev?.providerId, (x) => optStr(x, 'providerId')),
    model: pick(v, 'model', prev?.model, (x) => optStr(x, 'model')),
    quiet: pick(v, 'quiet', prev?.quiet, (x) => quietOf(x, prev?.quiet)),
    threshold: num('threshold', prev?.threshold),
    maxRoutines: num('maxRoutines', prev?.maxRoutines),
    paused: flag('paused', prev?.paused),
    title: pick(v, 'title', prev?.title, (x) => optStr(x, 'title')?.trim() || undefined),
    notify: flag('notify', prev?.notify),
    pinned: flag('pinned', prev?.pinned),
    hidden: flag('hidden', prev?.hidden),
    // the server's (the bot's own conversation): kept from the stored bot, never taken from a request
    threadId: prev?.threadId,
  });
}
