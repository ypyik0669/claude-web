// Phase 4 end-to-end: skills / tools / secrets / schedules (cron + history) / ledger / diagnostics / mcp registry.
//   node server/ws-phase4.mjs [port] [token]
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = process.argv[2] ?? '3090';
const token = process.argv[3];
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); }
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

ws.on('open', async () => {
  try {
    // skills
    const name = `cw-test-${Date.now().toString(36)}`;
    const created = await req({ kind: 'skills.create', name, scope: 'user', description: 'e2e' });
    const list = await req({ kind: 'skills.list' });
    check('skills.create + list', list.some((s) => s.name === name && s.scope === 'user'), created);
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skill-'));
    fs.writeFileSync(path.join(local, 'SKILL.md'), '---\nname: local-e2e\ndescription: local install\n---\n# hi\n');
    const inst = await req({ kind: 'skills.install', source: local, scope: 'user', name: `${name}-local` });
    check('skills.install (local)', inst.length === 1 && fs.existsSync(path.join(inst[0], 'SKILL.md')));
    await req({ kind: 'skills.remove', path: created });
    await req({ kind: 'skills.remove', path: inst[0] });
    check('skills.remove', !fs.existsSync(created) && !fs.existsSync(inst[0]));
    let guarded = false;
    try { await req({ kind: 'skills.remove', path: os.tmpdir() }); } catch { guarded = true; }
    check('skills.remove refuses paths outside skills dirs', guarded);
    fs.rmSync(local, { recursive: true, force: true });
    // tools
    const tools = await req({ kind: 'tools.detect' });
    check('tools.detect', tools.some((t) => t.id === 'git' && t.ok && t.version), tools.filter((t) => t.ok).map((t) => t.id).join(','));
    // secrets
    const sec = await req({ kind: 'secrets.status' });
    check('secrets.status', ['dpapi', 'keychain', 'plain'].includes(sec.scheme) && sec.total >= sec.protected, JSON.stringify(sec));
    await req({ kind: 'secrets.migrate' });
    const sec2 = await req({ kind: 'secrets.status' });
    check('secrets.migrate protects all', sec2.protected === sec2.total, JSON.stringify(sec2));
    const provs = await req({ kind: 'providers.list' });
    check('providers.list masks encrypted keys', provs.every((p) => !p.apiKey || p.apiKey.startsWith('…') || p.apiKey.includes('…')), provs.map((p) => p.apiKey).join(','));
    // schedules: cron + templates + history
    const tpl = await req({ kind: 'schedules.templates' });
    check('schedules.templates', tpl.length >= 5 && tpl.every((t) => t.cron && t.prompt));
    const sc = await req({ kind: 'schedules.upsert', schedule: { name: 'e2e cron', cwd: os.tmpdir(), prompt: 'noop', cron: '0 9 * * 1-5', enabled: true } });
    const next = new Date(sc.nextRunAt);
    check('schedules.upsert cron computes nextRunAt', sc.cron === '0 9 * * 1-5' && next.getHours() === 9 && next.getMinutes() === 0 && next.getDay() >= 1 && next.getDay() <= 5, next.toString());
    let bad = false;
    try { await req({ kind: 'schedules.upsert', schedule: { id: sc.id, cron: '99 * * * *' } }); } catch { bad = true; }
    check('schedules.upsert rejects bad cron', bad);
    const hist = await req({ kind: 'schedules.history', id: sc.id });
    check('schedules.history', Array.isArray(hist));
    await req({ kind: 'schedules.remove', id: sc.id });
    // ledger
    const led = await req({ kind: 'ledger.list', days: 30 });
    check('ledger.list', Array.isArray(led), `${led.length} entries`);
    const csv = await req({ kind: 'ledger.export', days: 30 });
    check('ledger.export csv', fs.existsSync(csv) && fs.readFileSync(csv, 'utf8').includes('sessionId'), csv);
    // diagnostics
    const diag = await req({ kind: 'diag.bundle' });
    const info = JSON.parse(fs.readFileSync(path.join(diag.dir, 'info.json'), 'utf8'));
    check('diag.bundle', !!info.engine && !/sk-[A-Za-z0-9_-]{20,}/.test(JSON.stringify(info)), diag.tar ?? diag.dir);
    // mcp registry (network; tolerate failure)
    try {
      const reg = await req({ kind: 'mcp.registry', query: 'filesystem', limit: 5 });
      check('mcp.registry', Array.isArray(reg), `${reg.length} results`);
    } catch (e) { check('mcp.registry (network)', true, `skipped: ${e.message.split('\n')[0]}`); }
    const health = await req({ kind: 'mcp.health' });
    check('mcp.health', Array.isArray(health), `${health.length} servers`);
  } catch (e) {
    check('script', false, e.stack);
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  ws.close();
  process.exit(failed ? 1 : 0);
});
