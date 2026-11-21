// The ways into a new conversation outside the start page (sidebar ＋ / menus, worktree, Git view, board, task chip)
// start where the start page would. Store, socket and the 「接一个模型」 dialog are stand-ins: what is checked is what
// session.open would be asked for, and when the dialog opens.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAst } from 'vite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '@shared';

const m = vi.hoisted(() => {
  const initial: unknown[] = [];
  const state = {
    providers: initial as unknown[],
    agents: [] as { kind: string }[],
    auth: null as { loggedIn: boolean } | null,
    engine: null,
    settings: {} as Record<string, unknown>,
    opened: [] as Record<string, unknown>[],
    loadProviders: vi.fn(async () => {}),
    loadAgents: vi.fn(async () => {}),
    async openSession(p: Record<string, unknown>) { state.opened.push(p); return 'new1'; },
  };
  return { initial, state, connect: vi.fn(async (_o: { reason?: string }): Promise<unknown> => null), storage: new Map<string, string>() };
});
vi.mock('@/store', () => ({ useStore: { getState: () => m.state } }));
vi.mock('@/ws/client', () => ({ ws: { request: async () => ({ enabled: true, groups: [], poolModels: {} }), on: () => () => {} } }));
vi.mock('@/features/providers/ConnectModel', () => ({ connectModel: m.connect }));

import { newConversationPick, openNewConversation, withUsableModel } from './new-conversation';

const prov = (id: string, type: Provider['type'] = 'anthropic'): Provider => ({ id, name: id, type, baseUrl: 'https://x', apiKey: '…', createdAt: 0 });
const remember = (provider: string, model: string, agent = 'claude') => { m.storage.set('cw.lastProvider', provider); m.storage.set('cw.lastModel', model); m.storage.set('cw.lastAgent', agent); };

beforeAll(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => m.storage.get(k) ?? null, setItem: (k: string, v: string) => void m.storage.set(k, v), removeItem: (k: string) => void m.storage.delete(k) });
});

beforeEach(() => {
  m.storage.clear();
  m.state.providers = [prov('p1'), prov('p2')]; // a list of its own: loaded
  m.state.agents = [{ kind: 'claude' }, { kind: 'codex' }];
  m.state.auth = { loggedIn: false };
  m.state.settings = {};
  m.state.opened = [];
  m.state.loadProviders.mockReset().mockImplementation(async () => {});
  m.state.loadAgents.mockReset().mockImplementation(async () => {});
  m.connect.mockReset().mockResolvedValue(null);
});

describe('openNewConversation (在这里新建对话 and the other ways in)', () => {
  it('relays only, the account logged out: on the relay used last, with its model (2026-11-21)', async () => {
    remember('p2', 'm2');
    expect(await openNewConversation({ cwd: '/w' })).toBe('new1');
    expect(m.state.opened).toEqual([{ cwd: '/w', providerId: 'p2', model: 'm2' }]);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it('nothing remembered (the desktop app starts with empty storage): the default, else the first usable relay', async () => {
    await openNewConversation({ cwd: '/w' });
    m.state.settings = { defaultProviderId: 'p2' };
    await openNewConversation({ cwd: '/w', worktree: 'feature' });
    expect(m.state.opened).toEqual([{ cwd: '/w', providerId: 'p1' }, { cwd: '/w', worktree: 'feature', providerId: 'p2' }]);
  });
  it('logged in with the account picked last: the account, with its model', async () => {
    m.state.auth = { loggedIn: true };
    m.state.settings = { defaultProviderId: 'p1' };
    remember('claude', 'opus');
    await openNewConversation({ cwd: '/w' });
    expect(m.state.opened).toEqual([{ cwd: '/w', providerId: 'claude', model: 'opus' }]);
  });
  it('another agent started last: that agent on its provider — its own login needs no Claude model', async () => {
    m.state.providers = [prov('p1'), prov('cx', 'openai')];
    remember('cx', 'gpt-x', 'codex');
    await openNewConversation({ cwd: '/w' });
    remember('claude', '', 'codex');
    await openNewConversation({ cwd: '/w' });
    expect(m.state.opened).toEqual([{ cwd: '/w', providerId: 'cx', model: 'gpt-x', agent: 'codex' }, { cwd: '/w', providerId: 'claude', agent: 'codex' }]);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it('nothing usable while logged out: 先接一个模型 first — closed, nothing opens; connected, it opens on that one', async () => {
    m.state.providers = [];
    remember('claude', 'opus');
    expect(await openNewConversation({ cwd: '/w' })).toBeNull();
    expect(m.state.opened).toEqual([]);
    expect(m.connect).toHaveBeenLastCalledWith({ reason: 'new' });
    m.connect.mockResolvedValue(prov('fresh'));
    expect(await openNewConversation({ cwd: '/w' }, 'send')).toBe('new1');
    expect(m.connect).toHaveBeenLastCalledWith({ reason: 'send' });
    expect(m.state.opened).toHaveLength(1);
    expect(m.state.opened[0]).toMatchObject({ cwd: '/w', providerId: 'fresh' });
    expect(m.state.opened[0].model).toBeUndefined(); // the account's model is not that provider's
  });
  it('a click before the lists arrived loads them first instead of reading 「no provider」 / 「no such agent」', async () => {
    m.state.providers = m.initial;
    m.state.agents = [];
    m.state.loadProviders.mockImplementation(async () => { m.state.providers = [prov('p1'), prov('cx', 'openai')]; });
    m.state.loadAgents.mockImplementation(async () => { m.state.agents = [{ kind: 'claude' }, { kind: 'codex' }]; });
    remember('p1', 'm1');
    expect(await newConversationPick()).toEqual({ providerId: 'p1', model: 'm1' });
    expect(m.state.loadProviders).toHaveBeenCalledTimes(1);
    expect(m.state.loadAgents).not.toHaveBeenCalled(); // asked for only when the agent remembered is another one
    remember('cx', 'gpt-x', 'codex');
    expect(await newConversationPick()).toEqual({ providerId: 'cx', model: 'gpt-x', agent: 'codex' });
    expect(m.state.loadProviders).toHaveBeenCalledTimes(1);
    expect(m.state.loadAgents).toHaveBeenCalledTimes(1);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it('the start page\'s send asks through the same step: only for the account while it is known to be logged out', async () => {
    m.state.auth = null; // not known yet: let it go
    expect(await withUsableModel({ providerId: 'claude', model: 'opus' }, 'send')).toEqual({ providerId: 'claude', model: 'opus' });
    m.state.auth = { loggedIn: false };
    expect(await withUsableModel({ providerId: 'p1', model: 'm1' }, 'send')).toEqual({ providerId: 'p1', model: 'm1' });
    expect(await withUsableModel({ providerId: 'claude', agent: 'codex' }, 'send')).toEqual({ providerId: 'claude', agent: 'codex' });
    expect(m.connect).not.toHaveBeenCalled();
    expect(await withUsableModel({ providerId: 'claude', model: 'opus' }, 'send')).toBeNull();
    expect(m.connect).toHaveBeenCalledWith({ reason: 'send' });
  });
});

// a new way in that calls openSession with only a folder would go out on the server's account default again
describe('every new conversation in a folder chooses its provider here', () => {
  const SRC = path.resolve(__dirname, '..', '..');
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
  it('no openSession({ cwd, … }) without a provider of its own (a resume / fork, another machine, WSL and spreads are fine)', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('openSession(')) continue;
      const visit = (n: any): void => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) visit(x); return; }
        if (n.type === 'CallExpression') {
          const c = n.callee;
          const name = c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' && !c.computed ? c.property?.name : '';
          const a = n.arguments?.[0];
          if (name === 'openSession' && a?.type === 'ObjectExpression') {
            const keys: string[] = a.properties.map((p: any) => (p.type === 'SpreadElement' ? '...' : p.key?.name ?? '?'));
            if (!keys.some((k) => ['...', 'sessionId', 'providerId', 'peer', 'env'].includes(k))) bad.push(`${path.relative(SRC, f)}: openSession({ ${keys.join(', ')} })`);
          }
        }
        for (const k of Object.keys(n)) visit(n[k]);
      };
      visit(parseAst(src, { lang: f.endsWith('.tsx') ? 'tsx' : 'ts' }));
    }
    expect(bad).toEqual([]);
  });
});
