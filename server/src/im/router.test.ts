import { describe, expect, it, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ImRouter } from './router.js';
import { chunk } from './types.js';
import type { ImGatewayConfig } from '../protocol.js';

class FakeAdapter extends EventEmitter {
  kind = 'telegram' as const; maxLen = 4000; inbound = true; state: any = 'running'; error = ''; botName = '@fake';
  sent: { chatId: string; text: string; buttons?: any[] }[] = [];
  async start() {} async stop() {}
  async send(chatId: string, text: string, o: any = {}) { this.sent.push({ chatId, text, buttons: o.buttons }); }
  inbound_(m: any) { this.emit('message', { chatId: 'c1', userId: 'u1', userName: 'Ann', text: '', ...m }); }
}
class FakeRunner extends EventEmitter {
  state = 'idle'; info: any = { model: 'm' }; sent: string[] = []; pending: any[] = []; interrupted = false;
  constructor(public sessionId: string) { super(); }
  send(t: string) { this.sent.push(t); }
  async interrupt() { this.interrupted = true; }
  getPendingPermissions() { return this.pending; }
  respondPermission(id: string, r: any) { const i = this.pending.findIndex((p) => p.requestId === id); if (i < 0) return false; this.pending.splice(i, 1); this.responses.push([id, r]); return true; }
  responses: any[] = [];
  async setPermissionMode() {} async setModel(m: string) { this.info.model = m; }
}
class FakePool extends EventEmitter {
  runners = new Map<string, FakeRunner>(); opened: any[] = [];
  get(id: string) { return this.runners.get(id); }
  list() { return [...this.runners.values()]; }
  open(p: any) { const id = p.sessionId ?? `s${this.runners.size + 1}`; const r = new FakeRunner(id); this.runners.set(id, r); this.opened.push(p); return r; }
  findPermission(id: string) { return this.list().find((r) => r.pending.some((p: any) => p.requestId === id)); }
}
class FakeMeta {
  gws: ImGatewayConfig[] = []; binds: any[] = []; ws = [{ path: 'C:/proj' }];
  workspaces() { return this.ws; }
  imGateways() { return this.gws; } async setImGateway(g: any) { const i = this.gws.findIndex((x) => x.id === g.id); if (i >= 0) this.gws[i] = g; else this.gws.push(g); }
  imBindings() { return this.binds; } async setImBinding(b: any) { this.binds = [...this.binds.filter((x) => !(x.gatewayId === b.gatewayId && x.chatId === b.chatId)), b]; }
  async removeImBinding() {}
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('ImRouter', () => {
  let pool: FakePool, meta: FakeMeta, a: FakeAdapter, router: ImRouter, cfg: ImGatewayConfig;
  beforeEach(() => {
    pool = new FakePool(); meta = new FakeMeta(); a = new FakeAdapter();
    router = new ImRouter({ pool: pool as any, meta: meta as any, sessions: { list: async () => [{ sessionId: 's1', title: 'first', cwd: 'C:/proj' }, { sessionId: 'zz9', title: 'other', cwd: 'C:/other' }] } as any });
    cfg = { id: 'g1', kind: 'telegram', name: 'tg', enabled: true, config: {}, allowUsers: [], allowNames: {}, openAccess: false, defaultCwd: '', permissionMode: 'default', verbose: false };
    meta.gws.push(cfg);
    router.attach(cfg, a as any);
  });

  it('rejects unknown users once per hour and pairs with /pair <code>', async () => {
    a.inbound_({ text: 'hello' }); await tick();
    expect(a.sent[0].text).toContain('未授权');
    a.inbound_({ text: 'hello again' }); await tick();
    expect(a.sent.length).toBe(1); // throttled
    const { code } = router.newPairCode('g1');
    a.inbound_({ text: `/pair ${code}` }); await tick();
    expect(a.sent[1].text).toContain('已授权');
    expect(meta.gws[0].allowUsers).toEqual(['u1']);
    expect(meta.gws[0].allowNames.u1).toBe('Ann');
  });

  it('plain text opens a session in the first workspace and forwards; result comes back with timing', async () => {
    cfg.allowUsers = ['u1']; router.updateConfig(cfg);
    a.inbound_({ text: 'do the thing' }); await tick();
    expect(pool.opened[0].cwd).toBe('C:/proj');
    const r = pool.runners.get('s1')!;
    expect(r.sent).toEqual(['do the thing']);
    expect(meta.binds[0]).toMatchObject({ gatewayId: 'g1', chatId: 'c1', sessionId: 's1' });
    pool.emit('message', 's1', { type: 'assistant', message: { content: [{ type: 'text', text: 'Done: 42' }] } });
    pool.emit('message', 's1', { type: 'result', is_error: false, result: 'Done: 42', duration_ms: 3200, total_cost_usd: 0.0123 });
    await tick();
    expect(a.sent.at(-1)!.text).toBe('Done: 42\n\n— 3s · $0.012');
  });

  it('permission requests become button messages; callbacks and /allow resolve them', async () => {
    cfg.allowUsers = ['u1']; router.updateConfig(cfg);
    a.inbound_({ text: 'go' }); await tick();
    const r = pool.runners.get('s1')!;
    r.pending.push({ requestId: 'p1', sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf build' } });
    pool.emit('permission', { requestId: 'p1', sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf build' } });
    await tick();
    const msg = a.sent.at(-1)!;
    expect(msg.text).toContain('Bash 请求权限');
    expect(msg.text).toContain('rm -rf build');
    expect(msg.buttons!.map((b: any) => b.id)).toEqual(['perm:p1:allow', 'perm:p1:deny']);
    a.inbound_({ callback: 'perm:p1:deny' }); await tick();
    expect(r.responses[0]).toEqual(['p1', { behavior: 'deny', message: '用户在 IM 上拒绝' }]);
    expect(a.sent.at(-1)!.text).toBe('⛔ 已拒绝');
    // second request answered by /allow
    r.pending.push({ requestId: 'p2', sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.ts' } });
    pool.emit('permission', { requestId: 'p2', sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.ts' } });
    await tick();
    a.inbound_({ text: '/allow' }); await tick();
    expect(r.responses[1]).toEqual(['p2', { behavior: 'allow' }]);
    // AskUserQuestion → numbered options + ask: buttons
    r.pending.push({ requestId: 'p3', sessionId: 's1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } });
    pool.emit('permission', { requestId: 'p3', sessionId: 's1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } });
    await tick();
    expect(a.sent.at(-1)!.buttons!.map((b: any) => b.id)).toEqual(['ask:p3:0', 'ask:p3:1']);
    a.inbound_({ callback: 'ask:p3:1' }); await tick();
    expect(r.responses[2][1].updatedInput.answers).toEqual({ 'Which?': 'B' });
  });

  it('commands: /sessions /use /status /stop /model /verbose /help', async () => {
    cfg.allowUsers = ['u1']; router.updateConfig(cfg);
    a.inbound_({ text: '/help' }); await tick();
    expect(a.sent.at(-1)!.text).toContain('/new');
    a.inbound_({ text: '/sessions' }); await tick();
    expect(a.sent.at(-1)!.text).toContain('1. ○ first');
    a.inbound_({ text: '/use 2' }); await tick();
    expect(a.sent.at(-1)!.text).toContain('已切换到 other');
    expect(pool.opened.at(-1)).toMatchObject({ sessionId: 'zz9', cwd: 'C:/other' });
    a.inbound_({ text: '/status' }); await tick();
    expect(a.sent.at(-1)!.text).toContain('zz9');
    a.inbound_({ text: '/stop' }); await tick();
    expect(pool.runners.get('zz9')!.interrupted).toBe(true);
    a.inbound_({ text: '/model opus' }); await tick();
    expect(pool.runners.get('zz9')!.info.model).toBe('opus');
    a.inbound_({ text: '/verbose on' }); await tick();
    expect(meta.gws[0].verbose).toBe(true);
    pool.emit('message', 'zz9', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
    await tick();
    expect(a.sent.at(-1)!.text).toBe('🔧 Bash ls');
    // unknown slash command goes to the session (Claude's own commands)
    a.inbound_({ text: '/compact' }); await tick();
    expect(pool.runners.get('zz9')!.sent).toContain('/compact');
  });
});

describe('chunk', () => {
  it('splits on paragraph boundaries within the limit', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}\n\n${'c'.repeat(30)}`;
    const parts = chunk(text, 70);
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe(`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`);
    expect(parts[1]).toBe('c'.repeat(30));
    expect(chunk('x'.repeat(100), 40).map((p) => p.length)).toEqual([40, 40, 20]);
  });
});

describe('ImRouter: provider of the sessions a bot opens', () => {
  let pool: FakePool, meta: FakeMeta, a: FakeAdapter, router: ImRouter, cfg: ImGatewayConfig;
  const list = [{ sessionId: 'cx1', title: 'one', cwd: 'C:/proj' }, { sessionId: 's9', title: 'two', cwd: 'C:/proj' }];
  beforeEach(() => {
    pool = new FakePool(); meta = new FakeMeta(); a = new FakeAdapter();
    router = new ImRouter({ pool: pool as any, meta: meta as any, sessions: { list: async () => list } as any });
    cfg = { id: 'g1', kind: 'dingtalk', name: 'dd', enabled: true, config: {}, allowUsers: ['u1'], allowNames: {}, openAccess: false, defaultCwd: '', permissionMode: 'default', verbose: false };
    meta.gws.push(cfg);
    router.attach(cfg, a as any);
  });

  it('the provider picked for the bot (a relay) is what its new sessions run on; none = the pool\'s default', async () => {
    router.updateConfig({ ...cfg, providerId: 'relay' });
    a.inbound_({ text: 'hi' }); await tick();
    expect(pool.opened[0]).toMatchObject({ cwd: 'C:/proj', providerId: 'relay' });
    router.updateConfig({ ...cfg, providerId: '' });
    a.inbound_({ text: '/new C:/p2' }); await tick();
    expect(pool.opened[1].providerId).toBeUndefined(); // RunnerPool.open then applies the new-conversation default
    router.updateConfig({ ...cfg, providerId: 'claude' });
    a.inbound_({ text: '/new C:/p3' }); await tick();
    expect(pool.opened[2].providerId).toBe('claude'); // explicitly the account
  });

  it('replies name the provider (so people can check which channel the bot uses)', async () => {
    router.updateConfig({ ...cfg, providerId: 'relay' });
    const open = pool.open.bind(pool);
    pool.open = (p: any) => { const r = open(p); r.info = { model: 'deepseek-chat', providerId: 'relay', providerName: '我的中转' }; return r; };
    a.inbound_({ text: '/new C:/p' }); await tick();
    expect(a.sent.at(-1)!.text).toContain('供应商 我的中转');
    a.inbound_({ text: '/status' }); await tick();
    expect(a.sent.at(-1)!.text).toContain('供应商 我的中转');
  });

  it('a bound session reaped while idle is reopened on its id, on the provider on record', async () => {
    a.inbound_({ text: 'first' }); await tick();
    const sid = meta.binds[0].sessionId;
    pool.runners.delete(sid);
    a.inbound_({ text: 'second' }); await tick();
    expect(pool.opened.at(-1)).toMatchObject({ sessionId: sid });
    expect(pool.opened.at(-1).providerId).toBeUndefined(); // the pool keeps the recorded one
  });

  it('/use binds the picked conversation and opens it', async () => {
    a.inbound_({ text: '/use 1' }); await tick();
    expect(pool.opened.at(-1)).toMatchObject({ sessionId: 'cx1' });
    expect(meta.binds[0]).toMatchObject({ sessionId: 'cx1' });
    a.inbound_({ text: '/use 2' }); await tick();
    expect(pool.opened.at(-1)).toMatchObject({ sessionId: 's9' });
  });

  it('/dispatch (派活, stage F3): a new conversation in the named project with its mode, bound here, the task sent, marked', async () => {
    router.updateConfig({ ...cfg, allowUsers: ['u1'] });
    meta.ws = [{ path: 'C:/proj' }, { id: 'w2', name: 'Site', path: 'C:/site', permissionMode: 'acceptEdits' }] as any;
    const metas: Record<string, any> = {};
    (meta as any).setSessionMeta = async (id: string, p: any) => { metas[id] = p; };
    a.inbound_({ text: '/dispatch site: 更新首页' }); await tick();
    expect(pool.opened[0]).toMatchObject({ cwd: 'C:/site', permissionMode: 'acceptEdits' });
    const r = pool.runners.get('s1')!;
    expect(r.sent).toEqual(['更新首页']);
    expect(metas.s1).toEqual({ origin: 'dispatch', dispatchFrom: 'im', workspaceId: 'w2' });
    expect(meta.binds[0]).toMatchObject({ chatId: 'c1', sessionId: 's1' });
    expect(a.sent.at(-1)!.text).toContain('已派出');
    a.inbound_({ text: '/派活' }); await tick();
    expect(a.sent.at(-1)!.text).toContain('/dispatch');
  });
});
