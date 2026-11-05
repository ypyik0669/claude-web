// Signing Codex in from the page (2026-11-05, user request: the 登录 button only typed `codex login` into a terminal).
// Codex's own app-server does the whole ChatGPT login: `account/login/start` answers the URL to open (it listens on its
// own loopback callback) or a device code, `account/login/completed` says how it went, `account/read` who is signed
// in. Tokens stay in Codex's ~/.codex/auth.json, as with `codex login` — nothing is copied into claude-web.
import os from 'node:os';
import { JsonRpcProcess } from './jsonrpc.js';
import { tr } from '../i18n/index.js';

export interface CodexAccount { signedIn: boolean; email?: string; plan?: string; apiKey?: boolean }

export interface CodexLoginView {
  id: string;
  state: 'pending' | 'done' | 'failed' | 'cancelled';
  /** browser login: open this */
  authUrl?: string;
  /** device login (another computer, no browser here): open this and type the code */
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  account?: CodexAccount;
}

type Launch = { command: string; args: string[]; env: Record<string, string> };
type Rpc = Pick<JsonRpcProcess, 'request' | 'notify' | 'kill' | 'on'> & { exited?: boolean };

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const RPC_TIMEOUT_MS = 45_000;

export function accountOf(r: any): CodexAccount {
  const a = r?.account;
  if (!a || typeof a !== 'object') return { signedIn: false };
  if (a.type === 'apiKey') return { signedIn: true, apiKey: true };
  return { signedIn: true, ...(typeof a.email === 'string' && a.email ? { email: a.email } : {}), ...(typeof a.planType === 'string' && a.planType !== 'unknown' ? { plan: a.planType } : {}) };
}

export class CodexLogin {
  private sessions = new Map<string, { view: CodexLoginView; rpc: Rpc; timer: NodeJS.Timeout; loginId?: string }>();
  private seq = 0;

  constructor(
    private launch: () => Launch,
    /** after a sign-in: ask the new account's model list again */
    private onSignedIn: () => void,
    private spawnRpc: (l: Launch) => Rpc = (l) => new JsonRpcProcess(l.command, l.args, { cwd: os.homedir(), env: l.env }),
  ) {}

  private async open(): Promise<Rpc> {
    const rpc = this.spawnRpc(this.launch());
    try {
      await rpc.request('initialize', { clientInfo: { name: 'claude-web', title: 'Claude Web', version: '0.1.0' }, capabilities: null }, RPC_TIMEOUT_MS);
    } catch (e) { rpc.kill(); throw e; }
    rpc.notify('initialized', {});
    return rpc;
  }

  /** Who Codex is signed in as (a short app-server: initialize → account/read → close). */
  async account(): Promise<CodexAccount> {
    const rpc = await this.open();
    try { return accountOf(await rpc.request('account/read', {}, RPC_TIMEOUT_MS)); } finally { rpc.kill(); }
  }

  async begin(device = false): Promise<CodexLoginView> {
    const rpc = await this.open();
    const id = `cxl_${++this.seq}_${Date.now().toString(36)}`;
    const view: CodexLoginView = { id, state: 'pending' };
    let r: any;
    try {
      r = await rpc.request('account/login/start', device ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' }, RPC_TIMEOUT_MS);
    } catch (e) { rpc.kill(); throw e; }
    if (typeof r?.authUrl === 'string') view.authUrl = r.authUrl;
    if (typeof r?.verificationUrl === 'string') view.verificationUrl = r.verificationUrl;
    if (typeof r?.userCode === 'string') view.userCode = r.userCode;
    if (!view.authUrl && !view.verificationUrl) { rpc.kill(); throw new Error(tr('Codex 没有给出登录地址')); }
    const timer = setTimeout(() => this.finish(id, 'failed', tr('登录超时（10 分钟），请重试')), LOGIN_TIMEOUT_MS);
    timer.unref?.();
    this.sessions.set(id, { view, rpc, timer, loginId: typeof r?.loginId === 'string' ? r.loginId : undefined });
    rpc.on('notification', (method: string, params: any) => {
      if (method !== 'account/login/completed') return;
      const s = this.sessions.get(id);
      if (!s || (params?.loginId && s.loginId && params.loginId !== s.loginId)) return;
      if (params?.success) void this.succeed(id);
      else this.finish(id, 'failed', typeof params?.error === 'string' && params.error ? params.error : tr('登录没有完成'));
    });
    rpc.on('exit', () => { if (this.sessions.get(id)?.view.state === 'pending') this.finish(id, 'failed', tr('Codex 进程退出了')); });
    return { ...view };
  }

  private async succeed(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    let account: CodexAccount | undefined;
    try { account = accountOf(await s.rpc.request('account/read', {}, RPC_TIMEOUT_MS)); } catch { /* signed in; who is unknown */ }
    s.view.account = account ?? { signedIn: true };
    this.finish(id, 'done');
    this.onSignedIn();
  }

  private finish(id: string, state: CodexLoginView['state'], error?: string) {
    const s = this.sessions.get(id);
    if (!s || s.view.state !== 'pending') return;
    s.view.state = state;
    if (error) s.view.error = error;
    clearTimeout(s.timer);
    s.rpc.kill();
    // the view stays readable for a while (the page polls status), then goes
    setTimeout(() => this.sessions.delete(id), 5 * 60_000).unref?.();
  }

  status(id: string): CodexLoginView {
    const s = this.sessions.get(id);
    if (!s) throw new Error(tr('登录已过期，请重新开始'));
    return { ...s.view };
  }

  async cancel(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.view.state !== 'pending') return;
    if (s.loginId) await s.rpc.request('account/login/cancel', { loginId: s.loginId }, 5_000).catch(() => {});
    this.finish(id, 'cancelled');
  }

  async logout(): Promise<CodexAccount> {
    const rpc = await this.open();
    try {
      await rpc.request('account/logout', {}, RPC_TIMEOUT_MS);
      return accountOf(await rpc.request('account/read', {}, RPC_TIMEOUT_MS));
    } finally { rpc.kill(); }
  }

  dispose() { for (const id of [...this.sessions.keys()]) this.finish(id, 'cancelled'); }
}
