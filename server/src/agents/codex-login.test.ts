import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CodexLogin, accountOf } from './codex-login.js';

/** A stand-in for `codex app-server`: answers the account/* requests and lets the test send the completed notification. */
function fakeRpc(o: { account?: any; start?: any } = {}) {
  const ee = new EventEmitter();
  const calls: { method: string; params: any }[] = [];
  let account = o.account ?? { account: null };
  const rpc = {
    exited: false,
    killed: false,
    on: (e: string, f: (...a: any[]) => void) => { ee.on(e, f); return rpc; },
    notify: vi.fn(),
    kill: () => { rpc.killed = true; },
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'initialize') return {};
      if (method === 'account/read') return account;
      if (method === 'account/login/start') return o.start ?? (params.type === 'chatgptDeviceCode'
        ? { type: 'chatgptDeviceCode', loginId: 'L2', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' }
        : { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?x=1' });
      if (method === 'account/logout') { account = { account: null }; return {}; }
      if (method === 'account/login/cancel') return {};
      throw new Error(`unexpected ${method}`);
    },
    complete: (p: any) => ee.emit('notification', 'account/login/completed', p),
    setAccount: (a: any) => { account = a; },
  };
  return { rpc, calls };
}

const launch = () => ({ command: 'codex', args: ['app-server'], env: {} });

describe('CodexLogin (Codex app-server account/*)', () => {
  it('reads who is signed in', async () => {
    const { rpc } = fakeRpc({ account: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' } } });
    const s = new CodexLogin(launch, () => {}, () => rpc as any);
    expect(await s.account()).toEqual({ signedIn: true, email: 'a@b.c', plan: 'plus' });
    expect(rpc.killed).toBe(true);
    expect(accountOf({ account: null })).toEqual({ signedIn: false });
    expect(accountOf({ account: { type: 'apiKey' } })).toEqual({ signedIn: true, apiKey: true });
  });

  it('browser sign-in: the URL to open, then done with the account; the model list is asked again', async () => {
    const { rpc, calls } = fakeRpc();
    const signedIn = vi.fn();
    const s = new CodexLogin(launch, signedIn, () => rpc as any);
    const v = await s.begin(false);
    expect(v).toMatchObject({ state: 'pending', authUrl: 'https://auth.openai.com/oauth/authorize?x=1' });
    expect(calls.find((c) => c.method === 'account/login/start')?.params).toEqual({ type: 'chatgpt' });
    expect(rpc.killed).toBe(false);
    rpc.setAccount({ account: { type: 'chatgpt', email: 'me@x.io', planType: 'pro' } });
    rpc.complete({ loginId: 'L1', success: true });
    await vi.waitFor(() => expect(s.status(v.id).state).toBe('done'));
    expect(s.status(v.id).account).toEqual({ signedIn: true, email: 'me@x.io', plan: 'pro' });
    expect(signedIn).toHaveBeenCalledOnce();
    expect(rpc.killed).toBe(true);
  });

  it('device code; a failed or another login\'s notification', async () => {
    const { rpc } = fakeRpc();
    const s = new CodexLogin(launch, () => {}, () => rpc as any);
    const v = await s.begin(true);
    expect(v).toMatchObject({ userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' });
    rpc.complete({ loginId: 'other', success: true });
    expect(s.status(v.id).state).toBe('pending');
    rpc.complete({ loginId: 'L2', success: false, error: 'denied' });
    expect(s.status(v.id)).toMatchObject({ state: 'failed', error: 'denied' });
  });

  it('cancel tells Codex and ends the session; logout reads the account after', async () => {
    const { rpc, calls } = fakeRpc({ account: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' } } });
    const s = new CodexLogin(launch, () => {}, () => rpc as any);
    const v = await s.begin(false);
    await s.cancel(v.id);
    expect(calls.some((c) => c.method === 'account/login/cancel' && c.params.loginId === 'L1')).toBe(true);
    expect(s.status(v.id).state).toBe('cancelled');
    expect(await s.logout()).toEqual({ signedIn: false });
  });

  it('a Codex whose initialize fails is killed on every path (account / begin / logout)', async () => {
    for (const call of ['account', 'begin', 'logout'] as const) {
      const { rpc } = fakeRpc();
      const real = rpc.request;
      rpc.request = async (method: string, params: any) => { if (method === 'initialize') throw new Error('initialize timed out'); return real(method, params); };
      const s = new CodexLogin(launch, () => {}, () => rpc as any);
      await expect(call === 'begin' ? s.begin(false) : s[call]()).rejects.toThrow('initialize');
      expect(rpc.killed).toBe(true);
    }
  });

  it('a start without any address is an error, not a session', async () => {
    const { rpc } = fakeRpc({ start: { type: 'chatgpt', loginId: 'L1' } });
    const s = new CodexLogin(launch, () => {}, () => rpc as any);
    await expect(s.begin(false)).rejects.toThrow();
    expect(rpc.killed).toBe(true);
  });
});
