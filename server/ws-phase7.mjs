// Phase 7 end-to-end: issue / PR board (GitHub via gh token, read-only against a public repo), goals (create / edit / note / remove; running one needs a model), android status.
//   node server/ws-phase7.mjs [port] [token]
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = process.argv[2] ?? '3090';
const token = process.argv[3];
const here = path.dirname(fileURLToPath(import.meta.url));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); } else if (m.type === 'event') events.push(m.event); });
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };

ws.on('open', async () => {
  try {
    // ---- board (read-only, public repo) ----
    const repo = await req({ kind: 'vcs.repo', cwd: here, repo: 'anthropics/claude-code' });
    check('vcs.repo resolves an explicit public repo', repo.provider === 'github' && repo.owner === 'anthropics' && repo.repo === 'claude-code', repo.error || `@${repo.user}`);
    if (repo.authOk) {
      const issues = await req({ kind: 'vcs.issues', cwd: here, repo: 'anthropics/claude-code', state: 'open' });
      check('vcs.issues lists open issues', Array.isArray(issues) && issues.length > 0 && issues.every((i) => !i.isPr && i.number && i.title), `${issues.length} issues`);
      const searched = await req({ kind: 'vcs.issues', cwd: here, repo: 'anthropics/claude-code', state: 'all', q: 'windows' });
      check('vcs.issues search', Array.isArray(searched), `${searched.length} hits`);
      const pulls = await req({ kind: 'vcs.pulls', cwd: here, repo: 'anthropics/claude-code', state: 'all' });
      check('vcs.pulls (graphql) lists PRs with review/check fields', Array.isArray(pulls) && pulls.length > 0 && pulls.every((p) => p.isPr && p.head && p.base && 'reviewDecision' in p), `${pulls.length} PRs`);
      const first = issues[0];
      const d = await req({ kind: 'vcs.item', cwd: here, repo: 'anthropics/claude-code', number: first.number, isPr: false });
      check('vcs.item detail', d.number === first.number && typeof d.body === 'string' && Array.isArray(d.comments));
      const pr = pulls.find((p) => p.state === 'merged') ?? pulls[0];
      const pd = await req({ kind: 'vcs.item', cwd: here, repo: 'anthropics/claude-code', number: pr.number, isPr: true });
      check('vcs.item PR detail has files/reviews/checks', pd.isPr && Array.isArray(pd.files) && Array.isArray(pd.reviews) && Array.isArray(pd.checkRuns), `${pd.files.length} files`);
    } else console.log('SKIP board lists (gh not logged in)');
    let bad = false;
    try { await req({ kind: 'vcs.repo', cwd: 'C:/', repo: '' }); } catch { bad = true; }
    check('vcs.repo without a remote errors cleanly', bad);
    const gl = await req({ kind: 'vcs.repo', cwd: here, repo: 'https://gitlab.com/gitlab-org/gitlab' });
    check('vcs.repo gitlab target parses (auth may be missing)', gl.provider === 'gitlab' && gl.owner === 'gitlab-org', gl.error.slice(0, 50));

    // ---- goals (running one needs a model: not here) ----
    const g = await req({ kind: 'goals.create', objective: 'use a tool and make a plan for the thing', spec: '- must echo', cwd: here, maxTurns: 3, permissionMode: 'bypassPermissions' });
    check('goals.create', g.status === 'draft' && g.maxTurns === 3);
    const g2 = await req({ kind: 'goals.update', id: g.id, patch: { spec: '- must echo\n- twice' } });
    check('goals.update', g2.spec.includes('twice'));
    check('goals.changed events were broadcast', events.some((e) => e.kind === 'goals.changed'));
    await req({ kind: 'goals.note', id: g.id, text: 'human note' });
    const g3 = (await req({ kind: 'goals.list' })).find((y) => y.id === g.id);
    check('goals.note', g3.evidence.at(-1).summary === 'human note');
    await req({ kind: 'goals.remove', id: g.id });
    check('goals.remove', !(await req({ kind: 'goals.list' })).some((y) => y.id === g.id));

    // ---- android ----
    const a = await req({ kind: 'android.status' });
    check('android.status answers (adb optional)', typeof a.adb === 'string' && Array.isArray(a.devices) && Array.isArray(a.avds), a.adb ? `adb ${a.adb}` : 'adb not installed');
    if (!a.adb) { let err = ''; try { await req({ kind: 'android.screenshot', serial: 'x' }); } catch (e) { err = e.message; } check('android.screenshot without adb errors with a hint', /adb/.test(err)); }
  } catch (e) {
    check('script error', false, e.stack ?? String(e));
  }
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
});
