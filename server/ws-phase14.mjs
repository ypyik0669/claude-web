// Phase 14 end-to-end: multi-agent orchestration over the hub with two mock ACP agents (no model calls).
// A scratch git repo gets a workflow "step1 → approval → step2 → compare(A, B)": checks that every task is a
// real session, the approval blocks until answered, templates carry upstream output + the approval comment,
// the compare fans out into two worktrees, picking the winner merges it with --no-ff and the worktrees /
// losing branch are cleaned up; plus a rejected approval failing the run and cycle validation on save.
//   node server/ws-phase14.mjs [port] [token]   (meant for scripts/e2e.mjs: temp HOME + CLAUDE_WEB_DIR)
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const port = args[0] ?? '3090';
const token = args[1];
const here = path.dirname(fileURLToPath(import.meta.url));
const mock = path.join(here, 'src', 'agents', '__mocks__', 'acp-agent.mjs');
const webDir = process.env.CLAUDE_WEB_DIR || path.join(os.homedir(), '.claude-web');
const A = 'acp:orch-a';
const B = 'acp:orch-b';

// scratch repo on branch main with one commit
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase14-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@example.com');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
const events = [];
const waiters = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (process.env.CW_DEBUG) console.error('<<', String(raw).slice(0, 300));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') { events.push(m.event); for (const w of [...waiters]) if (safe(w.fn, m.event)) { waiters.splice(waiters.indexOf(w), 1); w.res(m.event); } }
});
const safe = (fn, e) => { try { return fn(e); } catch { return false; } };
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const waitEvent = (fn, ms = 60000) => new Promise((res, rej) => { const hit = events.find((e) => safe(fn, e)); if (hit) return res(hit); const w = { fn, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout waiting for event')); }, ms); });
/** the latest run snapshot matching `fn` (from orchestra.changed events, or a fresh get) */
const waitRun = async (runId, fn, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const run = await req({ kind: 'orchestra.run.get', runId });
    if (safe(fn, run)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for run ${runId}`);
};
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on('open', async () => {
  const sessions = new Set();
  const wfIds = [];
  const runIds = [];
  try {
    await req({ kind: 'agents.set', agent: A, patch: { name: 'Orch A', command: process.execPath, args: [mock], env: { MOCK_ACP_TAG: 'from-A' }, protocol: 'acp' } });
    await req({ kind: 'agents.set', agent: B, patch: { name: 'Orch B', command: process.execPath, args: [mock], env: { MOCK_ACP_TAG: 'from-B' }, protocol: 'acp' } });
    await req({ kind: 'agents.list', refresh: true });

    const tpls = await req({ kind: 'orchestra.templates' });
    check('three built-in templates', tpls.length === 3 && tpls.some((t) => t.nodes.some((n) => n.kind === 'compare')), tpls.map((t) => t.name).join(' / '));

    const cyc = await req({ kind: 'orchestra.workflows.save', workflow: { name: 'cyclic', cwd: repo, nodes: [
      { id: 'x', kind: 'task', title: 'x', agent: A, prompt: 'x', dependsOn: ['y'], workspace: 'shared' },
      { id: 'y', kind: 'task', title: 'y', agent: A, prompt: 'y', dependsOn: ['x'], workspace: 'shared' },
    ] } }).then(() => null, (e) => e.message);
    check('saving a cycle is rejected', !!cyc && cyc.includes('环'), cyc ?? 'saved!');

    const wf = await req({ kind: 'orchestra.workflows.save', workflow: { name: 'e2e flow', cwd: repo, nodes: [
      { id: 'step1', kind: 'task', title: 'Step one', agent: A, prompt: 'first pass on {{input}}', dependsOn: [], workspace: 'shared' },
      { id: 'gate', kind: 'approval', title: 'Gate', note: 'look at step one', dependsOn: ['step1'] },
      { id: 'step2', kind: 'task', title: 'Step two', agent: B, prompt: 'second pass; upstream said [{{nodes.step1.output}}]; reviewer said [{{nodes.gate.approval}}]', dependsOn: ['gate'], workspace: 'shared' },
      { id: 'cmp', kind: 'compare', title: 'Compare', agents: [A, B], prompt: 'implement WRITE:result.txt', dependsOn: ['step2'] },
    ] } });
    wfIds.push(wf.id);
    const listed = await req({ kind: 'orchestra.workflows.list' });
    check('workflow saved and listed', listed.some((w) => w.id === wf.id && w.nodes.length === 4));

    const run = await req({ kind: 'orchestra.run.start', workflowId: wf.id, input: 'hello-e2e' });
    runIds.push(run.id);
    check('run started on base branch main', run.state === 'running' && run.baseBranch === 'main', `${run.state} ${run.baseBranch}`);

    const r1 = await waitRun(run.id, (r) => r.nodes.step1.state === 'done');
    const s1 = r1.nodes.step1.sessionIds[0];
    sessions.add(s1);
    check('task node ran as a real session', !!s1 && events.some((e) => e.kind === 'session.event' && e.sessionId === s1), s1);
    check('task output = the agent reply (with the rendered input)', /Echo: .*first pass on hello-e2e/s.test(r1.nodes.step1.output ?? ''), (r1.nodes.step1.output ?? '').slice(0, 80));
    const listedSessions = await req({ kind: 'sessions.list' });
    check('orchestrated session shows up in sessions.list', listedSessions.some((x) => x.sessionId === s1), `${listedSessions.length} sessions`);

    const r2 = await waitRun(run.id, (r) => r.nodes.gate.state === 'waiting');
    check('approval node waits, run is waiting', r2.state === 'waiting' && r2.nodes.step2.state === 'pending', r2.state);
    await sleep(1500);
    const r2b = await req({ kind: 'orchestra.run.get', runId: run.id });
    check('approval blocks downstream', r2b.nodes.step2.state === 'pending' && r2b.nodes.step2.sessionIds.length === 0);

    await req({ kind: 'orchestra.node.approve', runId: run.id, nodeId: 'gate', decision: 'approve', comment: 'ship-it' });
    const r3 = await waitRun(run.id, (r) => r.nodes.step2.state === 'done');
    for (const sid of r3.nodes.step2.sessionIds) sessions.add(sid);
    const out2 = r3.nodes.step2.output ?? '';
    check('downstream prompt carries upstream output + approval comment', out2.includes('first pass on hello-e2e') && out2.includes('通过：ship-it'), out2.slice(0, 160));

    const r4 = await waitRun(run.id, (r) => r.nodes.cmp.state === 'waiting' && r.state === 'waiting' && r.nodes.cmp.candidates.every((c) => c.diffStat !== undefined || c.state === 'failed'));
    const cands = r4.nodes.cmp.candidates;
    for (const c of cands) if (c.sessionId) sessions.add(c.sessionId);
    check('compare fanned out to two worktree sessions', cands.length === 2 && cands.every((c) => c.state === 'done' && c.worktree && fs.existsSync(c.worktree.path)), cands.map((c) => `${c.agent}:${c.state}`).join(' '));
    check('worktrees live under <dataDir>/worktrees, named per run / node / agent', cands.every((c) => path.resolve(c.worktree.path).toLowerCase().startsWith(path.resolve(webDir, 'worktrees').toLowerCase()) && path.basename(c.worktree.path).startsWith(`${run.id}-cmp-`) && c.worktree.branch.startsWith(`cw/${run.id}/cmp-`)), cands.map((c) => c.worktree.branch).join(' '));
    check('each candidate has a diff --stat with its file', cands.every((c) => c.diffStat?.includes('result.txt') && c.files === 1), cands.map((c) => c.diffStat).join(' | '));
    const diffB = await req({ kind: 'orchestra.node.diff', runId: run.id, nodeId: 'cmp', agent: B });
    check('full diff of a candidate', diffB.includes('+from-B'), diffB.split('\n').slice(0, 3).join(' '));
    check('base worktree untouched before the pick', !fs.existsSync(path.join(repo, 'result.txt')));
    check('the user repo itself stays clean (worktrees are outside it)', git('status', '--porcelain') === '', git('status', '--porcelain'));

    // the user starts their own conflicting merge in the base repo: the pick must refuse and leave it alone
    git('checkout', '-q', '-b', 'user-side');
    fs.writeFileSync(path.join(repo, 'README.md'), 'user side\n');
    git('commit', '-q', '-am', 'user side');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'main side\n');
    git('commit', '-q', '-am', 'main side');
    let userMerge = false;
    try { git('merge', 'user-side'); } catch { userMerge = true; }
    await req({ kind: 'orchestra.node.pick', runId: run.id, nodeId: 'cmp', winner: B });
    const refused = await req({ kind: 'orchestra.run.get', runId: run.id });
    const mergeHead = fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'));
    check('pick refused during the user\'s own merge; their merge untouched, node back to waiting', userMerge && mergeHead && refused.nodes.cmp.state === 'waiting' && /进行中的 merge/.test(refused.nodes.cmp.error ?? '') && cands.every((c) => fs.existsSync(c.worktree.path)), refused.nodes.cmp.error ?? refused.nodes.cmp.state);
    git('merge', '--abort');
    git('reset', '-q', '--hard', 'HEAD~1');
    git('branch', '-q', '-D', 'user-side');
    await req({ kind: 'orchestra.node.pick', runId: run.id, nodeId: 'cmp', winner: B });
    const r5 = await waitRun(run.id, (r) => r.state === 'done' || r.state === 'failed');
    check('run done after the pick', r5.state === 'done' && r5.nodes.cmp.winner === B, `${r5.state} ${r5.error ?? ''}`);
    const merged = fs.existsSync(path.join(repo, 'result.txt')) ? fs.readFileSync(path.join(repo, 'result.txt'), 'utf8').trim() : '';
    check('winner merged into main', merged === 'from-B' && git('rev-parse', '--abbrev-ref', 'HEAD') === 'main', merged);
    check('merge is --no-ff (a merge commit)', git('log', '--merges', '--oneline').split('\n').filter(Boolean).length === 1);
    const wtList = git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
    check('all candidate worktrees removed', wtList.length === 1 && cands.every((c) => !fs.existsSync(c.worktree.path)), `${wtList.length} worktrees`);
    const branches = git('branch', '--format=%(refname:short)').split('\n');
    const loser = cands.find((c) => c.agent === A).worktree.branch;
    const winner = cands.find((c) => c.agent === B).worktree.branch;
    check('losing branch deleted, winner branch kept', !branches.includes(loser) && branches.includes(winner), branches.join(' '));
    check('run record written to <dataDir>/orchestra', fs.existsSync(path.join(webDir, 'orchestra', `${run.id}.json`)));
    const runs = await req({ kind: 'orchestra.runs.list' });
    check('runs.list summary', runs.some((x) => x.id === run.id && x.state === 'done' && x.done === 4 && x.total === 4));
    const removal = waitEvent((e) => e.kind === 'orchestra.changed' && e.removed && e.run.id === run.id, 10000).catch(() => null);
    const cleaned = await req({ kind: 'orchestra.run.remove', runId: run.id, cleanup: true });
    runIds.splice(runIds.indexOf(run.id), 1);
    check('remove with cleanup deletes the merged winner branch, broadcasts the removal', cleaned.removed.includes(winner) && !git('branch', '--format=%(refname:short)').split('\n').includes(winner) && !!(await removal), JSON.stringify(cleaned));
    const orphans = await req({ kind: 'orchestra.orphans.list' });
    check('no orphan worktrees left after cleanup', !orphans.some((o) => path.basename(o.path).startsWith(run.id)), JSON.stringify(orphans));
    const metas = await req({ kind: 'sessions.meta' });
    check('worktree sessions are grouped under the repo in the sidebar (groupCwd)', cands.every((c) => metas[c.sessionId]?.groupCwd === repo), JSON.stringify(cands.map((c) => metas[c.sessionId])));
    check('orchestra.changed events were broadcast', events.some((e) => e.kind === 'orchestra.changed' && e.run.id === run.id && e.run.nodes.gate.state === 'waiting'));

    // rejection path: the run fails, downstream is skipped, the comment is kept
    const wf2 = await req({ kind: 'orchestra.workflows.save', workflow: { name: 'e2e reject', cwd: repo, nodes: [
      { id: 'gate', kind: 'approval', title: 'Gate', dependsOn: [] },
      { id: 'after', kind: 'task', title: 'After', agent: A, prompt: 'never', dependsOn: ['gate'], workspace: 'shared' },
    ] } });
    wfIds.push(wf2.id);
    const run2 = await req({ kind: 'orchestra.run.start', workflowId: wf2.id, input: '' });
    runIds.push(run2.id);
    await waitRun(run2.id, (r) => r.nodes.gate.state === 'waiting');
    await req({ kind: 'orchestra.node.approve', runId: run2.id, nodeId: 'gate', decision: 'reject', comment: 'too-risky' });
    const rr = await waitRun(run2.id, (r) => r.state === 'failed');
    check('reject fails the run and skips downstream', rr.nodes.after.state === 'skipped' && rr.nodes.gate.approval?.comment === 'too-risky' && rr.error?.includes('too-risky'), rr.error);
  } catch (e) {
    check('script error', false, e.stack ?? String(e));
  }
  for (const sid of sessions) await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
  for (const id of runIds) await req({ kind: 'orchestra.run.remove', runId: id }).catch(() => {});
  for (const id of wfIds) await req({ kind: 'orchestra.workflows.remove', id }).catch(() => {});
  await req({ kind: 'agents.set', agent: A, patch: null }).catch(() => {});
  await req({ kind: 'agents.set', agent: B, patch: null }).catch(() => {});
  await sleep(300);
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
});
