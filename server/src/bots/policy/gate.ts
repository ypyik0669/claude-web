// server/src/bots/policy/gate.ts
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ActionClass, AuditBasis, Bot, PermissionRequestEvent, PolicyLevel, PolicyRule } from '../../protocol.js';
import type { ToolGate } from '../../agents/types.js';
import type { BotStore } from '../store.js';
import type { AuditLog } from '../audit.js';
import type { Inbox } from '../inbox.js';
import { classify, summarize, targetOf } from './classify.js';
import { decide, ruleKey, scopeKey, type Decision, type DayCounts } from './rules.js';
import { selfGuard } from './self-guard.js';
import { tr } from '../../i18n/index.js';

/** A call the gate let through: what it was and the rule that allowed it (demoteRule takes that rule on a correction). */
export interface AllowedCall { toolName: string; input: Record<string, unknown>; cls: ActionClass; key: string; level: PolicyLevel; basis: AuditBasis; rule?: PolicyRule }
export interface GateCtx { bot: Bot; runId: string; routineId: string; store: BotStore; audit: AuditLog; inbox: Inbox; now?: () => number; onTell?: (text: string, call: AllowedCall) => void }
export interface GateHandle {
  gate: ToolGate;
  /** the user approved this call (inbox): the next identical call passes once */
  approveOnce(toolName: string, input: Record<string, unknown>): void;
  /** the last time this call was let through in this run, with the rule that did it */
  allowed(toolName: string, input: Record<string, unknown>): AllowedCall | undefined;
  calls: number;
}

/** ccb hands MCP tools over as ExecuteExtraTool { tool_name, params }: the call is the tool inside. */
function unwrap(toolName: string, input: Record<string, unknown>): [string, Record<string, unknown>] {
  if (toolName === 'ExecuteExtraTool' && typeof input.tool_name === 'string') {
    const p = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? input.params as Record<string, unknown> : {};
    return [input.tool_name, p];
  }
  return [toolName, input];
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
/** sha1 of the (unwrapped) tool name + key-sorted JSON of its input: a wrapped call and the same call made directly are one key */
export function callKey(toolName: string, input: Record<string, unknown>): string {
  const [name, params] = unwrap(toolName, input);
  return createHash('sha1').update(name + '\n' + stable(params)).digest('hex');
}

const DAY = 24 * 3600_000;
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * The policy gate of one run — the safety rules live here, not in the prompt, so they survive compaction.
 * "Ask" does not hang the tool call (the SDK would wait, and the whole turn with it): it is refused with a note,
 * queued in the inbox, and re-run after approval (approveOnce on the resumed run). Any failure in here refuses the
 * call: falling through would put a permission card in front of nobody.
 */
export function makeGate(ctx: GateCtx): GateHandle {
  const now = ctx.now ?? Date.now;
  const approved = new Set<string>();
  const allowedCalls = new Map<string, AllowedCall>();
  /**
   * Today's counts for perDay: per rule (ruleKey of the rule that allowed the call) and what autopilot let through.
   * Other runs of this bot come from their audit rows (read once per local day), this run's from memory — both
   * bucketed by the gate's own clock, so an injected now() and midnight are honoured.
   */
  let day = -1;
  let others = new Map<string, number>();
  const mine = new Map<string, number>();
  const AUTOPILOT = 'autopilot|*';
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const countKeys = (basis: AuditBasis, rule?: PolicyRule) => basis === 'autopilot' ? [AUTOPILOT] : rule ? [ruleKey(rule)] : [];
  const seed = (start: number) => {
    others = new Map();
    for (const r of ctx.store.runs(ctx.bot.id, 2000)) {
      if (r.id === ctx.runId || r.at < start - DAY) continue;
      for (const row of ctx.store.audit(ctx.bot.id, r.id)) {
        if (row.result !== 'allowed' || row.at < start || row.at >= start + DAY) continue;
        for (const k of countKeys(row.basis, row.rule)) bump(others, k);
      }
    }
  };
  const today = (t: number): DayCounts => {
    const start = dayStart(t);
    if (start !== day) { day = start; seed(start); }
    const n = (k: string) => (others.get(k) ?? 0) + (mine.get(`${start}|${k}`) ?? 0);
    return { perRule: (r) => n(ruleKey(r)), autopilot: n(AUTOPILOT) };
  };

  const check = async (ev: PermissionRequestEvent): Promise<PermissionResult> => {
    const t = now();
    const [name, params] = unwrap(ev.toolName, ev.input);
    const cls = classify(ev.toolName, ev.input);
    const summary = summarize(ev.toolName, ev.input);
    const target = targetOf(cls, ev.toolName, ev.input);
    const key = scopeKey(undefined, target);
    const base = { at: t, runId: ctx.runId, botId: ctx.bot.id, toolName: name, cls, summary, scope: key };
    // the bots' own files (policy, audit, inbox) are out of reach whatever the bot's levels — unleashed too
    const guard = selfGuard(path.dirname(ctx.store.dir(ctx.bot.id)), ctx.bot.id, ctx.bot.cwd, name, params);
    const d: Decision = guard ? { level: guard, basis: 'rule' } : decide(ctx.bot.policy, cls, target, t, today(t));
    if (d.level === 'deny') {
      await ctx.audit.add({ ...base, level: 'deny', basis: d.basis, result: 'denied', ...(d.rule ? { rule: d.rule } : {}) });
      return { behavior: 'deny', message: guard ? tr('Bot 不能改自己的策略、审计和收件箱：这一步没有执行') : tr('这个 Bot 的策略禁止这类动作：{cls}', { cls }) };
    }
    const ck = callKey(ev.toolName, ev.input);
    const level = d.level;
    let basis = d.basis, rule = d.rule;
    if (level === 'ask' && approved.has(ck)) { basis = 'user'; rule = undefined; } // the user let this one through, not a rule
    else if (level === 'ask') {
      const item = await ctx.inbox.add({ kind: 'approval', botId: ctx.bot.id, runId: ctx.runId, routineId: ctx.routineId, sessionId: ev.sessionId, title: summary, toolName: ev.toolName, input: ev.input, cls });
      await ctx.audit.add({ ...base, level: 'ask', basis, result: 'queued', ...(rule ? { rule } : {}) });
      return { behavior: 'deny', message: tr('这个动作要先经你批准，已放进收件箱（{title}）。先做别的；批准后会从这里继续。', { title: item.title }) };
    }
    // spend the approval (whatever let the call through — none lingers) and take the perDay slot before the audit
    // write's await, so a concurrent call can't pass the same slot or spend the same approval; both go back if the
    // call doesn't get on record
    const hadApproval = approved.delete(ck);
    const slots = countKeys(basis, rule).map((k) => `${dayStart(t)}|${k}`);
    for (const k of slots) bump(mine, k);
    try {
      await ctx.audit.add({ ...base, level, basis, result: 'allowed', ...(rule ? { rule } : {}) });
    } catch (e) {
      if (hadApproval) approved.add(ck);
      for (const k of slots) mine.set(k, (mine.get(k) ?? 1) - 1);
      throw e;
    }
    const call: AllowedCall = { toolName: ev.toolName, input: ev.input, cls, key, level, basis, ...(rule ? { rule } : {}) };
    allowedCalls.set(ck, call);
    if (level === 'do_tell') ctx.onTell?.(summary, call);
    return { behavior: 'allow', updatedInput: ev.input };
  };

  const h: GateHandle = {
    calls: 0,
    approveOnce: (toolName, input) => { approved.add(callKey(toolName, input)); },
    allowed: (toolName, input) => allowedCalls.get(callKey(toolName, input)),
    gate: async (ev) => {
      h.calls++;
      try { return await check(ev); } catch (e) {
        console.warn(`[bots] gate failed for ${ev.toolName}:`, e);
        return { behavior: 'deny', message: tr('这个 Bot 的策略检查出错了，这一步没有执行：{message}', { message: e instanceof Error ? e.message : String(e) }) };
      }
    },
  };
  return h;
}
