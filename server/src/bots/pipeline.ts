import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentDriver } from '../agents/types.js';
import type { Bot, BotRun, OpenSessionParams, Routine, RunTrigger } from '../protocol.js';
import type { BotStore } from './store.js';
import type { AuditLog } from './audit.js';
import type { Inbox } from './inbox.js';
import type { RoutineState } from './types.js';
import { makeGate } from './policy/gate.js';
import { fingerprint, runScript } from './precheck.js';
import { summarize } from './policy/classify.js';
import { tr } from '../i18n/index.js';

/** the slice of RunnerPool / services the pipeline needs — tests fake it */
export interface PipelineDeps {
  store: BotStore; audit: AuditLog; inbox: Inbox;
  open(params: OpenSessionParams): AgentDriver;
  /** texts, ≤ 8 (MemoryService.search, scope 'bot') */
  memories(botId: string, q: string): string[];
  /** sum of the ledger's costUsd for the conversation */
  costOf(sessionId: string): Promise<number>;
  /** settings 'bots.defaultProvider' */
  defaultProvider(): string | undefined;
  now?: () => number;
}
export interface RunOutcome { run: BotRun }
export interface RunOptions {
  resume?: { sessionId: string; approved: { toolName: string; input: Record<string, unknown> } };
  /** the hard stop: aborting kills a running pre-check / acceptance script, interrupts and closes the conversation */
  signal?: AbortSignal;
}
export const RUN_TIMEOUT_MIN = 30;
export const MAX_FAILURES = 3;

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
    '- 查不到的标「待核实」，不要猜。',
    '- 结尾固定写：查了什么 / 没能查到什么 / 建议的下一步。',
    `- 要记住的事用 memory.write，scope 填 bot、key 填 ${bot.id}。`,
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
  const stopped = async () => { run.ok = false; run.error = tr('被停下了'); return finish(); };
  if (o.signal?.aborted) return stopped();

  if (trigger !== 'resume' && routine.precheck) {
    const pc = await runScript(routine.precheck, { cwd: bot.cwd, signal: o.signal });
    if (o.signal?.aborted) return stopped();
    if (pc.ok) {
      const fp = fingerprint(pc.stdout);
      if (fp === d.store.stateOf(bot.id, routine.id).fingerprint) { run.skipped = true; run.ok = true; return finish(); }
      await d.store.setState(bot.id, routine.id, { fingerprint: fp });
    } else run.error = `precheck: ${(pc.stderr || pc.stdout).trim().slice(0, 200)}`;
  }

  const checkpointFile = path.join(d.store.dir(bot.id), 'state', `${routine.id.replace(/[^\w-]/g, '_')}.checkpoint.md`);
  await fsp.mkdir(path.dirname(checkpointFile), { recursive: true });
  const params: OpenSessionParams = { sessionId: o.resume?.sessionId, cwd: bot.cwd, permissionMode: 'default', providerId: bot.providerId || d.defaultProvider(), model: bot.model || undefined, drivenBy: 'schedule', gated: true };
  let runner: AgentDriver;
  try { runner = d.open(params); } catch (e) {
    run.ok = false; run.error = e instanceof Error ? e.message : String(e);
    return finish();
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
    run.ok = false; run.error = tr('这个对话不经过 Bot 的策略检查（只有 Claude 的对话可以），没有运行');
    return finish();
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
      g.approveOnce(o.resume.approved.toolName, o.resume.approved.input);
      runner.send(tr('你之前要做的「{summary}」已经批准，现在执行它，然后接着完成例行任务。', { summary: summarize(o.resume.approved.toolName, o.resume.approved.input) }));
    } else {
      runner.send(buildPrompt(bot, routine, d.store.stateOf(bot.id, routine.id), d.memories(bot.id, routine.name).slice(0, 8), checkpointFile));
    }
    res = await waitResult(runner, (routine.timeoutMin ?? RUN_TIMEOUT_MIN) * 60_000, o.signal);
  } catch (e) {
    res = { isError: true, text: '', died: e instanceof Error ? e.message : String(e) };
  }
  if (res.timedOut || res.stopped) await runner.interrupt().catch(() => { /* gone */ });
  await close();
  run.sessionId = runner.sessionId;
  run.toolCalls = g.calls;
  run.costUsd = await d.costOf(runner.sessionId).catch(() => 0);
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
  await d.store.setState(bot.id, routine.id, { lastSummary: run.said.slice(0, 500), checkpoint });

  const fresh = d.store.get(bot.id) ?? bot;
  const idx = fresh.routines.findIndex((r) => r.id === routine.id);
  if (idx >= 0) {
    const r = { ...fresh.routines[idx] };
    r.lastRunAt = started;
    r.failures = run.ok ? 0 : (r.failures ?? 0) + 1;
    const why = run.error ?? run.verified?.note;
    if (!run.ok && r.failures >= MAX_FAILURES) {
      r.enabled = false;
      await d.inbox.add({ kind: 'finding', botId: bot.id, runId: run.id, routineId: routine.id, title: tr('例行「{name}」连续失败 {n} 次，已停用', { name: r.name, n: MAX_FAILURES }), ...(why ? { body: why } : {}) });
    } else if (!run.ok && r.onFail === 'inbox') {
      await d.inbox.add({ kind: 'finding', botId: bot.id, runId: run.id, routineId: routine.id, title: tr('例行「{name}」没通过验收', { name: r.name }), ...(why ? { body: why } : {}) });
    }
    const routines = [...fresh.routines]; routines[idx] = r;
    await d.store.save({ ...fresh, routines });
  }

  for (const out of bot.outputs) {
    if (out.kind === 'inbox') {
      await d.inbox.add({ kind: 'finding', botId: bot.id, runId: run.id, routineId: routine.id, sessionId: runner.sessionId, title: routine.name, body: run.said });
      for (const t of drafts(run.said)) await d.inbox.add({ kind: 'draft', botId: bot.id, runId: run.id, routineId: routine.id, sessionId: runner.sessionId, title: tr('{name} 的草稿', { name: routine.name }), body: t });
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
