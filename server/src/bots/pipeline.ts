import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentDriver } from '../agents/types.js';
import type { ActionClass, Bot, BotPolicy, BotRun, LedgerEntry, OpenSessionParams, PolicyLevel, Routine, RunTrigger } from '../protocol.js';
import type { BotStore } from './store.js';
import type { AuditLog } from './audit.js';
import type { Inbox } from './inbox.js';
import type { ApprovedCall, RoutineState } from './types.js';
import { makeGate } from './policy/gate.js';
import { fingerprint, runScript } from './precheck.js';
import { summarize } from './policy/classify.js';
import { DEFAULT_RULES } from './policy/rules.js';
import { tr } from '../i18n/index.js';
import { claudePrice } from '../usage/pricing.js';

/** the slice of RunnerPool / services the pipeline needs — tests fake it */
export interface PipelineDeps {
  store: BotStore; audit: AuditLog; inbox: Inbox;
  open(params: OpenSessionParams): AgentDriver;
  /** texts, ≤ 8 (MemoryService.search, scope 'bot') */
  memories(botId: string, q: string): string[];
  /** the conversation's cost so far (ledgerCost of its ledger rows) */
  costOf(sessionId: string): Promise<{ usd: number; estimated?: boolean }>;
  /** settings 'bots.defaultProvider' */
  defaultProvider(): string | undefined;
  now?: () => number;
}
export interface RunOutcome { run: BotRun }
export interface RunOptions {
  /** the conversation to go on with and the calls the user approved for it (each passes once) */
  resume?: { sessionId: string; approved: ApprovedCall[] };
  /** the hard stop: aborting kills a running pre-check / acceptance script, interrupts and closes the conversation */
  signal?: AbortSignal;
}
export const RUN_TIMEOUT_MIN = 30;
export const MAX_FAILURES = 3;

/**
 * One line for the model (spec §3.3): what the gate does with outward / money / irreversible actions, from the bot's
 * own levels. Informational only — the gate enforces it whatever the model makes of it.
 */
const OUTWARD: [ActionClass, string][] = [['send', '对外发送'], ['pay', '付款'], ['delete', '删除']];
const LEVEL_SAYS: Record<PolicyLevel, string> = { ask: '会先问人', deny: '不允许', do: '可以直接做', do_tell: '可以直接做（做完告诉人）' };
export function policyLine(policy: BotPolicy): string {
  const groups = new Map<string, string[]>();
  for (const [cls, name] of OUTWARD) {
    const level = policy.unleashed ? 'do' : (policy.rules.find((r) => r.cls === cls && !r.scope)?.level ?? DEFAULT_RULES.find((r) => r.cls === cls)!.level);
    const scoped = !policy.unleashed && level !== 'do' && policy.rules.some((r) => r.cls === cls && r.scope && r.level !== 'deny');
    const says = LEVEL_SAYS[level] + (scoped ? '（放行范围内的直接做）' : '');
    groups.set(says, [...(groups.get(says) ?? []), name]);
  }
  return `- 只是告知（由系统把关，不用你自己拦）：${[...groups].map(([says, names]) => names.join('/') + says).join('；')}。`;
}

/**
 * A conversation's cost from its ledger rows. A row without a known price (costUnknown: another vendor's model on a
 * relay — the ledger records it as 0) is estimated from its tokens at a Sonnet-class price, so a bot's budget still
 * holds on such a source; `estimated` says the number is a guess (费用未知 elsewhere in the app).
 */
export function ledgerCost(rows: Pick<LedgerEntry, 'costUsd' | 'costUnknown' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'>[]): { usd: number; estimated: boolean } {
  let usd = 0, estimated = false;
  for (const r of rows) {
    if (!r.costUnknown) { usd += r.costUsd ?? 0; continue; }
    const guess = claudePrice('sonnet', { input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cacheRead ?? 0, cacheWrite: r.cacheWrite ?? 0 });
    if (guess > 0) { usd += guess; estimated = true; }
  }
  return { usd, estimated };
}

export function buildPrompt(bot: Bot, routine: Routine, state: RoutineState, memories: string[], checkpointFile: string): string {
  const c = bot.charter;
  return [
    `你是「${bot.name}」。${c.role}`,
    c.audience ? `服务对象：${c.audience}` : '',
    c.sources.length ? `只用这些来源：${c.sources.join('、')}` : '',
    c.report ? `报告格式：${c.report}` : '',
    c.done ? `完成条件：${c.done}` : '',
    '', `## 这次要做的（例行「${routine.name}」）`, routine.prompt,
    '', '## 上次的结论', state.lastSummary || '无',
    '', '## 检查点（上次没做完的从这里接着）', state.checkpoint || '无',
    '', '## 你记住的', ...(memories.length ? memories.map((m) => `- ${m}`) : ['- 无']),
    '', '## 规则',
    `- 长任务每完成一步就把进度写进 ${checkpointFile}（覆盖写），做完后删掉它。`,
    '- 要发出去的内容不要直接发，写在 <draft>…</draft> 里，由我来发。',
    policyLine(bot.policy),
    '- 查不到的标「待核实」，不要猜。',
    '- 结尾固定写：查了什么 / 没能查到什么 / 建议的下一步。',
    '- 要记住的事用 mcp__claude-web-memory__memory_write（scope 默认就是你自己的 bot，下次运行会出现在「你记住的」里）。',
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const waitStarted = async (r: AgentDriver, signal?: AbortSignal) => {
  for (let i = 0; i < 60 && r.state === 'starting' && !signal?.aborted; i++) await sleep(500);
};

type Outcome = { isError: boolean; text: string; timedOut?: boolean; stopped?: boolean; died?: string };
/** the turn's result; or the timeout / the stop / the process dying, whichever comes first */
function waitResult(r: AgentDriver, timeoutMs: number, signal?: AbortSignal): Promise<Outcome> {
  return new Promise((resolve) => {
    let done = false;
    const end = (o: Outcome) => {
      if (done) return;
      done = true;
      clearTimeout(t); r.off('message', onMsg); r.off('state', onState); signal?.removeEventListener('abort', onAbort);
      resolve(o);
    };
    const t = setTimeout(() => end({ isError: true, text: '', timedOut: true }), timeoutMs);
    const onMsg = (m: any) => { if (m?.type === 'result') end({ isError: !!m.is_error, text: typeof m.result === 'string' ? m.result : '' }); };
    const onState = (s: string, error?: string) => { if (s === 'closed' || s === 'error') end({ isError: true, text: '', died: error || s }); };
    const onAbort = () => end({ isError: true, text: '', stopped: true });
    r.on('message', onMsg);
    r.on('state', onState);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const drafts = (text: string) => [...text.matchAll(/<draft>([\s\S]*?)<\/draft>/g)].map((m) => m[1].trim()).filter(Boolean);
/** only a Claude SessionRunner opened with `gated` answers every tool call through `gate` (Codex / ACP drivers ignore it) */
const honoursGate = (r: AgentDriver) => r.info?.agent === 'claude' && (r as AgentDriver & { gated?: boolean }).gated === true;

/** why a run failed, for the inbox title */
type Cause = 'open' | 'ungated' | 'timeout' | 'died' | 'error' | 'verify';
const causeTitle = (c: Cause, name: string) => ({
  open: () => tr('例行「{name}」没能开始：对话打不开', { name }),
  ungated: () => tr('例行「{name}」没能开始：对话不经过策略检查', { name }),
  timeout: () => tr('例行「{name}」超时了', { name }),
  died: () => tr('例行「{name}」的进程退出了', { name }),
  error: () => tr('例行「{name}」出错了', { name }),
  verify: () => tr('例行「{name}」没通过验收', { name }),
}[c])();

/**
 * Every finished run that was not stopped: the routine's lastRunAt / failures (and enabled, at MAX_FAILURES) written
 * back inside the store's lock — whatever else changed bot.json meanwhile stays — then the notices.
 */
async function settleRoutine(d: PipelineDeps, botId: string, routineId: string, run: BotRun, cause: Cause | null) {
  let after: Routine | undefined;
  await d.store.update(botId, (b) => {
    const i = b.routines.findIndex((r) => r.id === routineId);
    if (i < 0) return undefined;
    const r = { ...b.routines[i], lastRunAt: run.at };
    r.failures = cause ? (r.failures ?? 0) + 1 : 0;
    if (cause && r.failures >= MAX_FAILURES) r.enabled = false;
    after = r;
    const routines = [...b.routines]; routines[i] = r;
    return { ...b, routines };
  });
  if (!cause || !after) return;
  const why = run.error ?? run.verified?.note;
  const base = { kind: 'finding' as const, botId, runId: run.id, routineId, ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(why ? { body: why } : {}) };
  if (after.failures! >= MAX_FAILURES) await d.inbox.add({ ...base, title: tr('例行「{name}」连续失败 {n} 次，已停用', { name: after.name, n: MAX_FAILURES }) });
  else if (after.onFail === 'inbox') await d.inbox.add({ ...base, title: causeTitle(cause, after.name) });
}

/** the abort reason of a server quitting mid-run (scheduler.stopAll without hard): the run is handed to the next holder */
export const HANDOFF = 'handoff';

/**
 * One run of a routine (spec §3): pre-check → a new conversation (or the one being resumed), gated before anything
 * is sent → wait for the result → acceptance → record → deliver. `o.signal` is the hard stop.
 */
export async function runRoutine(d: PipelineDeps, bot: Bot, routine: Routine, trigger: RunTrigger, o: RunOptions = {}): Promise<RunOutcome> {
  const now = d.now ?? Date.now;
  const started = now();
  const run: BotRun = { id: `${routine.id}-${started.toString(36)}`, botId: bot.id, routineId: routine.id, at: started, trigger };
  await d.store.addRun(run);
  const finish = async () => { run.endedAt = now(); run.durationMs = run.endedAt - started; await d.store.addRun(run); return { run }; };
  const stopped = async () => {
    run.ok = false;
    // the server quitting (not the user's stop): the run stays open for the next holder, which closes it and runs it again
    if (o.signal?.reason === HANDOFF) { run.error = tr('中断（让给另一个 claude-web）'); run.handoff = true; await d.store.addRun(run); return { run }; }
    run.error = tr('被停下了'); return finish();
  };
  if (o.signal?.aborted) return stopped();

  // the precheck's fingerprint is kept once the run ends ok: a failed, stopped or handed-over run isn't "unchanged" next time
  let fp: string | undefined;
  if (trigger !== 'resume' && routine.precheck) {
    const pc = await runScript(routine.precheck, { cwd: bot.cwd, signal: o.signal });
    if (o.signal?.aborted) return stopped();
    if (pc.ok) {
      fp = fingerprint(pc.stdout);
      if (fp === d.store.stateOf(bot.id, routine.id).fingerprint) { run.skipped = true; run.ok = true; return finish(); }
    } else run.error = tr('预检查出错：{error}', { error: (pc.stderr || pc.stdout).trim().slice(0, 200) });
  }

  const checkpointFile = path.join(d.store.dir(bot.id), 'state', `${routine.id.replace(/[^\w-]/g, '_')}.checkpoint.md`);
  await fsp.mkdir(path.dirname(checkpointFile), { recursive: true });
  const params: OpenSessionParams = { sessionId: o.resume?.sessionId, cwd: bot.cwd, permissionMode: 'default', providerId: bot.providerId || d.defaultProvider(), model: bot.model || undefined, drivenBy: 'schedule', gated: true, botId: bot.id };
  let runner: AgentDriver;
  const failed = async (cause: Cause, error: string) => {
    run.ok = false; run.error = error;
    await settleRoutine(d, bot.id, routine.id, run, cause);
    return finish();
  };
  try { runner = d.open(params); } catch (e) {
    return failed('open', e instanceof Error ? e.message : String(e));
  }
  const close = () => runner.close().catch(() => { /* already gone */ });
  // the pool hands back a resumed conversation still running from before — ungated: once more, as a fresh process
  if (!honoursGate(runner) && o.resume && runner.info?.agent === 'claude') {
    await close();
    try { runner = d.open(params); } catch { /* checked below */ }
  }
  run.sessionId = runner.sessionId;
  if (!honoursGate(runner)) {
    await close();
    return failed('ungated', tr('这个对话不经过 Bot 的策略检查（只有 Claude 的对话可以），没有运行'));
  }
  const g = makeGate({ bot, runId: run.id, routineId: routine.id, store: d.store, audit: d.audit, inbox: d.inbox, now, onTell: (t) => void d.inbox.add({ kind: 'finding', botId: bot.id, runId: run.id, routineId: routine.id, title: tr('做了：{t}', { t }) }) });
  // before anything is sent: no tool of this conversation runs ungated
  runner.gate = g.gate;
  await d.store.addRun(run);
  await waitStarted(runner, o.signal);
  if (o.signal?.aborted) { await close(); return stopped(); }

  let res: Outcome;
  try {
    if (o.resume) {
      for (const a of o.resume.approved) g.approveOnce(a.toolName, a.input);
      runner.send(tr('你之前要做的「{summary}」已经批准，现在执行它，然后接着完成例行任务。', { summary: o.resume.approved.map((a) => summarize(a.toolName, a.input)).join('」「') }));
    } else {
      runner.send(buildPrompt(bot, routine, d.store.stateOf(bot.id, routine.id), d.memories(bot.id, routine.name).slice(0, 8), checkpointFile));
    }
    res = await waitResult(runner, (routine.timeoutMin ?? RUN_TIMEOUT_MIN) * 60_000, o.signal);
  } catch (e) {
    res = { isError: true, text: '', died: e instanceof Error ? e.message : String(e) };
  }
  if (res.timedOut || res.stopped) await runner.interrupt({ closing: true }).catch(() => { /* gone */ });
  await close();
  run.sessionId = runner.sessionId;
  run.toolCalls = g.calls;
  const cost: { usd: number; estimated?: boolean } = await d.costOf(runner.sessionId).catch(() => ({ usd: 0 }));
  run.costUsd = cost.usd;
  if (cost.estimated) run.costEstimated = true;
  if (res.stopped) return stopped();

  run.said = res.text.slice(0, 2000);
  if (res.timedOut) run.error = tr('超时');
  else if (res.died) run.error = res.died;
  if (routine.acceptance.kind === 'script') {
    const a = await runScript(routine.acceptance.script, { cwd: bot.cwd, signal: o.signal });
    if (o.signal?.aborted) return stopped();
    run.verified = { ok: a.ok, note: (a.stdout || a.stderr).trim().slice(0, 300) };
  }
  run.ok = !res.isError && (run.verified?.ok ?? true);
  const checkpoint = fs.existsSync(checkpointFile) ? fs.readFileSync(checkpointFile, 'utf8').slice(0, 4000) : undefined;
  await d.store.setState(bot.id, routine.id, { lastSummary: run.said.slice(0, 500), checkpoint, ...(run.ok && fp ? { fingerprint: fp } : {}) });

  const cause: Cause | null = run.ok ? null : res.timedOut ? 'timeout' : res.died ? 'died' : res.isError ? 'error' : 'verify';
  await settleRoutine(d, bot.id, routine.id, run, cause);

  // the outputs as they are now (edited while the run went), the drafts from the whole answer (said is cut at 2000)
  for (const out of (d.store.get(bot.id) ?? bot).outputs) {
    if (out.kind === 'inbox') {
      await d.inbox.add({ kind: 'finding', botId: bot.id, runId: run.id, routineId: routine.id, sessionId: runner.sessionId, title: routine.name, body: run.said });
      for (const t of drafts(res.text)) await d.inbox.add({ kind: 'draft', botId: bot.id, runId: run.id, routineId: routine.id, sessionId: runner.sessionId, title: tr('{name} 的草稿', { name: routine.name }), body: t });
    } else if (out.kind === 'file') {
      try {
        await fsp.mkdir(path.dirname(out.path), { recursive: true });
        await fsp.appendFile(out.path, `\n\n## ${new Date(started).toISOString()} ${routine.name}\n\n${run.said}\n`, 'utf8');
      } catch (e) { console.warn(`[bots] cannot append ${bot.id}'s run to ${out.path}:`, e); }
    }
    // 'im' is delivered by the service from the returned run
  }
  return finish();
}
