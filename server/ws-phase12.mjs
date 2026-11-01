// Phase 12 end-to-end: the shared memory store, and the MCP server Claude talks to.
//   node server/ws-phase12.mjs [port] [token]
import WebSocket from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const port = args[0] ?? '3090';
const token = args[1];
const here = path.dirname(fileURLToPath(import.meta.url));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
const events = [];
const waiters = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') { events.push(m.event); for (const w of [...waiters]) { let hit = false; try { hit = w.fn(m.event); } catch { /* ignore */ } if (hit) { waiters.splice(waiters.indexOf(w), 1); w.res(m.event); } } }
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const waitEvent = (fn, ms = 60000) => new Promise((res, rej) => { const hit = events.find((e) => { try { return fn(e); } catch { return false; } }); if (hit) return res(hit); const w = { fn, res }; waiters.push(w); setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

/** Drive the memory MCP server the way an agent would: raw JSON-RPC over stdio. */
function mcpCall(entry, cwd, calls) {
  return new Promise((resolve, reject) => {
    const useTsx = entry.endsWith('.ts');
    const p = spawn(process.execPath, useTsx ? ['--import', 'tsx', entry, '--cwd', cwd, '--agent', 'e2e'] : [entry, '--cwd', cwd, '--agent', 'e2e'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += String(d); });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* ignore */ }
        if (out.length === calls.length) { p.stdin.end(); }
      }
    });
    p.on('error', reject);
    p.on('close', () => (out.length ? resolve(out) : reject(new Error(`mcp produced nothing: ${stderr.slice(0, 300)}`))));
    setTimeout(() => { p.kill(); }, 20000).unref?.();
    for (const c of calls) p.stdin.write(`${JSON.stringify(c)}\n`);
  });
}

ws.on('open', async () => {
  const cwd = path.dirname(here);
  const created = [];
  try {
    // ---- 1. write + search over the hub -------------------------------------
    const m1 = await req({ kind: 'memory.write', text: 'e2e-记忆：这个仓库的端口固定 3090，因为桌面壳用 PORT=0 另开一个', kind_: 'constraint', scope: 'project', cwd });
    created.push(m1.id);
    check('memory.write stores a project memory', !!m1.id && m1.kind === 'constraint', m1.scope);

    const found = await req({ kind: 'memory.search', query: 'e2e-记忆', cwd });
    check('memory.search finds it', found.some((m) => m.id === m1.id), `${found.length} 条`);

    const dupe = await req({ kind: 'memory.write', text: 'e2e-记忆：这个仓库的端口固定 3090，因为桌面壳用 PORT=0 另开一个', scope: 'project', cwd });
    check('restating a fact does not duplicate it', dupe.id === m1.id);

    // ---- 2. the same store through the MCP surface an agent uses -------------
    const entry = ['dist/memory/mcp.js', 'src/memory/mcp.ts'].map((p) => path.join(here, p)).find((p) => fs.existsSync(p));
    if (!entry) {
      console.log('SKIP mcp: neither dist/memory/mcp.js nor src/memory/mcp.ts exists');
    } else {
      const rpc = await mcpCall(entry, cwd, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'e2e-记忆' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_write', arguments: { text: 'e2e-记忆：另一个 agent 写的一条', kind: 'fact' } } },
      ]);
      const byId = Object.fromEntries(rpc.map((r) => [r.id, r]));
      check('mcp initialize handshakes', !!byId[1]?.result?.serverInfo, byId[1]?.result?.serverInfo?.name);
      check('mcp exposes the three memory tools', (byId[2]?.result?.tools ?? []).map((t) => t.name).join(',') === 'memory_search,memory_write,memory_list');
      const text = byId[3]?.result?.content?.[0]?.text ?? '';
      check('an agent reads what the UI wrote', text.includes('端口固定 3090'), text.slice(0, 80));
      check('an agent can write back', (byId[4]?.result?.content?.[0]?.text ?? '').includes('已记住'));

      const fromUi = await req({ kind: 'memory.search', query: '另一个 agent', cwd });
      check('the UI reads what the agent wrote', fromUi.length > 0, fromUi[0]?.text?.slice(0, 60));
      created.push(...fromUi.map((m) => m.id));
    }

    // ---- 3. cleanup ----------------------------------------------------------
    for (const id of [...new Set(created)]) await req({ kind: 'memory.remove', id }).catch(() => {});
    const left = await req({ kind: 'memory.search', query: 'e2e-记忆', cwd });
    check('cleanup removed the e2e memories', left.length === 0, `${left.length} left`);
  } catch (e) {
    check(`unexpected error: ${e.message}`, false);
  }
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  ws.close();
  process.exit(bad ? 1 : 0);
});
