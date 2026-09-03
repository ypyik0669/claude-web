// Phase 3 end-to-end: file ops / editor round-trip / search+replace / git read-only against this repo.
//   node server/ws-phase3.mjs [port] [token]
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const port = process.argv[2] ?? '3090';
const token = process.argv[3];
const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); }
  else if (m.type === 'event') events.push(m.event);
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on('open', async () => {
  try {
    // ---- files
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-p3-'));
    const f = path.join(tmp, 'a.txt');
    await req({ kind: 'fs.watch', path: tmp });
    await req({ kind: 'fs.create', path: f, text: 'hello world\nfoo bar\nhello again\n' });
    const opened = await req({ kind: 'fs.open', path: f });
    check('fs.create + fs.open', opened.text.startsWith('hello world') && opened.mtime > 0 && opened.binary === false);
    const w = await req({ kind: 'fs.write', path: f, text: 'hello world\nfoo bar\nhello again\nline4\n', expectMtime: opened.mtime });
    check('fs.write with matching mtime', w.mtime >= opened.mtime);
    let conflict = false;
    try { await req({ kind: 'fs.write', path: f, text: 'x', expectMtime: opened.mtime - 5000 }); } catch (e) { conflict = /磁盘上已被修改/.test(e.message); }
    check('fs.write conflict detection', conflict);
    const st = await req({ kind: 'fs.stat', path: f });
    check('fs.stat', st.size > 0 && st.dir === false && st.binary === false);
    await req({ kind: 'fs.mkdir', path: path.join(tmp, 'sub') });
    await req({ kind: 'fs.copy', from: f, to: path.join(tmp, 'sub', 'b.txt') });
    await req({ kind: 'fs.rename', from: path.join(tmp, 'sub', 'b.txt'), to: path.join(tmp, 'sub', 'c.txt') });
    const list = await req({ kind: 'fs.list', path: path.join(tmp, 'sub') });
    check('fs.mkdir/copy/rename/list', list.length === 1 && list[0].name === 'c.txt' && typeof list[0].size === 'number');
    await sleep(600);
    check('fs.changed events', events.some((e) => e.kind === 'fs.changed'), `${events.filter((e) => e.kind === 'fs.changed').length} events`);
    // ---- search / replace
    const s1 = await req({ kind: 'search.run', root: tmp, query: 'hello' });
    check('search.run', s1.total === 4 && s1.files.length === 2, `total ${s1.total} files ${s1.files.length}`);
    const s2 = await req({ kind: 'search.run', root: tmp, query: 'HELLO', options: { caseSensitive: true } });
    check('search.run case-sensitive', s2.total === 0);
    const s3 = await req({ kind: 'search.run', root: tmp, query: 'h\\w+o', options: { regex: true, include: ['*.txt'] } });
    check('search.run regex + include', s3.total === 4);
    const rp = await req({ kind: 'search.replace', root: tmp, query: 'hello', replacement: 'bye', targets: [{ path: f, lines: [1] }] });
    const after = await req({ kind: 'fs.open', path: f });
    check('search.replace targeted line', rp.replacements === 1 && after.text.startsWith('bye world') && after.text.includes('hello again'));
    const rp2 = await req({ kind: 'search.replace', root: tmp, query: 'hello', replacement: 'hi' });
    check('search.replace all', rp2.replacements === 3 && rp2.files === 2, JSON.stringify(rp2));
    // ---- trash
    await req({ kind: 'fs.trash', paths: [path.join(tmp, 'sub')] });
    check('fs.trash', !fs.existsSync(path.join(tmp, 'sub')));
    await req({ kind: 'fs.unwatch', path: tmp });
    fs.rmSync(tmp, { recursive: true, force: true });
    // ---- git (read-only on this repo)
    const gs = await req({ kind: 'git.status', cwd: REPO });
    check('git.status', !!gs.root && typeof gs.branch === 'string' && Array.isArray(gs.files), `${gs.branch} ${gs.files.length} files ahead ${gs.ahead} behind ${gs.behind}`);
    const lg = await req({ kind: 'git.log', cwd: REPO, n: 5 });
    check('git.log', lg.length === 5 && lg[0].hash.length === 40 && lg[0].subject.length > 0);
    const br = await req({ kind: 'git.branches', cwd: REPO });
    check('git.branches', br.some((b) => b.current));
    const wt = await req({ kind: 'git.worktrees', cwd: REPO });
    check('git.worktrees', wt.length >= 1 && wt[0].main);
    const sh = await req({ kind: 'git.show', cwd: REPO, rev: lg[0].hash });
    check('git.show', sh.stat.includes(lg[0].hash) && typeof sh.text === 'string');
    const modified = gs.files.find((x) => x.status === 'modified' && x.unstaged);
    if (modified) {
      const d = await req({ kind: 'git.diff', cwd: REPO, path: modified.path, staged: false });
      check('git.diff unstaged', d.kind === 'diff' && d.text.includes('@@'));
    }
    const notRepo = await req({ kind: 'git.status', cwd: os.tmpdir() });
    check('git.status outside repo', notRepo.root === null);
    let classified = '';
    try { await req({ kind: 'git.checkout', cwd: REPO, name: 'definitely-not-a-branch-xyz' }); } catch (e) { classified = e.message; }
    check('git error classified', /\[(unknown_rev|dirty|unknown)\]/.test(classified), classified.split('\n').pop());
    await req({ kind: 'git.watch', cwd: REPO });
    check('git.watch', true);
  } catch (e) {
    check('script', false, e.stack);
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  ws.close();
  process.exit(failed ? 1 : 0);
});
