// Create / probe a provider profile over WS: node server/ws-provider.mjs [port] <name> <type> <baseUrl> [token]
// The API key is read from env PROVIDER_KEY so it never lands in shell history or files.
import WebSocket from 'ws';
const [port = '3090', name = 'super-nb', type = 'anthropic', baseUrl = '', token] = process.argv.slice(2);
const apiKey = process.env.PROVIDER_KEY ?? '';
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let n = 0;
const pending = new Map();
const req = (r) => new Promise((res, rej) => { const id = String(++n); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
ws.on('message', (raw) => { const d = JSON.parse(String(raw)); if (d.type === 'reply') { const p = pending.get(d.reply.id); pending.delete(d.reply.id); d.reply.ok ? p.res(d.reply.data) : p.rej(new Error(d.reply.error)); } });
ws.on('open', async () => {
  try {
    const existing = (await req({ kind: 'providers.list' })).find((p) => p.name === name);
    const saved = await req({ kind: 'providers.upsert', provider: { id: existing?.id, name, type, baseUrl, apiKey: apiKey || undefined } });
    console.log('saved:', saved.id, saved.name, saved.type, saved.baseUrl, 'key', saved.apiKey);
    const probe = await req({ kind: 'providers.probe', id: saved.id });
    console.log('probe:', probe.ok ? `ok ${probe.models.length} models ${probe.ms}ms` : `FAIL ${probe.status ?? ''} ${probe.error}`);
    if (probe.ok) console.log('models:', probe.models.join(', '));
    const list = await req({ kind: 'providers.list' });
    console.log('list keys masked:', list.every((p) => !p.apiKey || p.apiKey.includes('…')));
  } catch (e) { console.error('ERR', e.message); }
  ws.close();
});
