// Starts the demo (scripts/lib/demo.cjs) and leaves it running, for looking at the interface by hand or with
// scripts/shot.cjs:  node scripts/demo-up.cjs [--lang en|zh] [--port-file <file>]   → prints the URL, Ctrl+C stops it.
const path = require('node:path');
const fs = require('node:fs');
const demo = require('./lib/demo.cjs');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };

(async () => {
  const lang = arg('--lang', 'en');
  const home = demo.tmpHome('cw-demo-');
  const seed = demo.seedDemo(home, lang);
  const up = await demo.startUpstream(lang);
  const srv = await demo.startServer(home, { lang, shop: seed.shop });
  const c = demo.client(srv.port, srv.token);
  await c.ready;
  await c.req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  const prov = await c.req({ kind: 'providers.upsert', provider: { name: lang === 'zh' ? '中转' : 'Relay', type: 'anthropic', baseUrl: up.url, apiKey: 'sk-demo-not-real', defaultModel: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] } });
  for (const p of [seed.shop, seed.notes, seed.blog]) await c.req({ kind: 'workspaces.add', path: p });
  console.log(JSON.stringify({ url: srv.url, home, sid: seed.sid, provider: prov.id }));
  const file = arg('--port-file', '');
  if (file) fs.writeFileSync(file, JSON.stringify({ url: srv.url, home, sid: seed.sid }));
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error(e); process.exit(1); });
