// WorkBuddy / CodeBuddy sidecar (linguo2625469/workbuddy2api-panel, MIT): it owns OAuth refresh, the account
// pool, check-in and the growth tasks. The gateway talks to its OpenAI-compatible /v1.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SidecarManager } from './sidecar.js';
import type { SidecarDriver, SidecarReadOptions } from './drivers.js';
import type { MaintenanceKind, QuotaSnapshot, SidecarAccount, SidecarAccountInput, SidecarAccountPatch, SidecarId, TaskResult } from './types.js';
import { tr } from '../i18n/index.js';

interface WbAccount {
  uid: string;
  nickname?: string;
  disabled?: boolean;
  paused?: boolean;
  cooling?: boolean;
  until?: number;
  reason?: string;
  disabled_reason?: string;
  credits?: number;
  credits_total?: number;
  last_error?: string;
}

interface CockpitAccount { uid: string; accessToken: string; refreshToken: string; nickname?: string; domain?: string; realm?: string }

const accountsOf = (raw: unknown): CockpitAccount[] => {
  const one = (x: any): CockpitAccount | null => {
    const uid = String(x?.uid ?? x?.account?.uid ?? '').trim();
    const accessToken = String(x?.accessToken ?? x?.access_token ?? x?.auth?.accessToken ?? '').trim();
    const refreshToken = String(x?.refreshToken ?? x?.refresh_token ?? x?.auth?.refreshToken ?? '').trim();
    if (!uid || !accessToken || !refreshToken) return null;
    return { uid, accessToken, refreshToken, nickname: x?.nickname ?? x?.account?.nickname, domain: x?.domain ?? x?.auth?.domain, realm: x?.realm ?? x?.auth?.realm };
  };
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return []; }
  }
  if (Array.isArray(v)) return v.map(one).filter((x): x is CockpitAccount => !!x);
  const j = v as any;
  const list = j?.accounts ?? j?.data ?? j;
  if (Array.isArray(list)) return list.map(one).filter((x): x is CockpitAccount => !!x);
  const single = one(j);
  return single ? [single] : [];
};

export class WorkBuddyAdapter implements SidecarDriver {
  readonly id: SidecarId = 'workbuddy';
  readonly apiKey = `wbk-${crypto.randomBytes(24).toString('hex')}`;

  private fixed?: string;

  constructor(private manager: SidecarManager | null, private doFetch: typeof fetch = fetch, opts: { baseUrl?: string } = {}) {
    this.fixed = opts.baseUrl?.replace(/\/+$/, '');
  }

  private base(): string {
    if (this.fixed) return this.fixed;
    const port = this.manager?.status('workbuddy').port;
    if (!port) throw new Error(tr('WorkBuddy 组件没有在运行'));
    return `http://127.0.0.1:${port}`;
  }

  private async api<T>(pathName: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, ...(init.headers as any) };
    if (init.body && typeof init.body === 'string') headers['content-type'] = 'application/json';
    const res = await this.doFetch(`${this.base()}${pathName}`, { ...init, headers, signal: AbortSignal.timeout(6 * 60_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`WorkBuddy sidecar ${pathName}: HTTP ${res.status} ${text.slice(0, 200)}`.trim());
    return (text ? JSON.parse(text) : {}) as T;
  }

  async ensureReady(): Promise<void> {
    if (this.fixed) return;
    await this.manager!.start('workbuddy', {
      args: ({ dir }) => ['--config', path.join(dir, 'wb2api.json')],
      prepare: async ({ port, dir }) => {
        const cfg = {
          listen: `127.0.0.1:${port}`,
          api_key: this.apiKey,
          auth_dir: path.join(dir, 'auths'),
          state_file: path.join(dir, 'state.json'),
          server: { read_timeout: '300s' },
          // claude-web's task center is the scheduler; the sidecar's own timers stay off
          schedule: {
            checkin_enabled: false, growth_enabled: false, travel_enabled: false,
            activity_enabled: false, keepalive_enabled: false, blackcat_enabled: false,
            balance_refresh_enabled: false,
          },
        };
        await fs.mkdir(path.join(dir, 'auths'), { recursive: true });
        const file = path.join(dir, 'wb2api.json');
        await fs.writeFile(file, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(file, 0o600).catch(() => {});
      },
      health: async (port) => {
        try {
          const r = await this.doFetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
          // an empty pool answers 503 {"healthy":0,...}: the process is up, there is just nothing logged in yet
          return r.ok || r.status === 503;
        } catch { return false; }
      },
    });
  }

  private async prepareRead(options?: SidecarReadOptions): Promise<void> {
    if (options?.start !== false) return this.ensureReady();
    if (!this.fixed && this.manager?.status('workbuddy').health !== 'ok') throw new Error(tr('组件未运行，请先启动'));
  }

  async health(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      await this.ensureReady();
      const o = await this.api<{ version?: string; healthy?: number; total?: number }>('/panel/api/overview');
      return { ok: true, version: o.version, detail: `${o.healthy ?? 0}/${o.total ?? 0} accounts` };
    } catch (e: any) {
      return { ok: false, detail: e?.message ?? String(e) };
    }
  }

  async models(options?: SidecarReadOptions): Promise<string[]> {
    await this.prepareRead(options);
    const r = await this.api<{ data?: { id: string }[] }>('/v1/models');
    return (r.data ?? []).map((m) => m.id);
  }

  private quota(a: WbAccount): QuotaSnapshot | undefined {
    if (a.credits === undefined && a.credits_total === undefined) return undefined;
    return {
      checkedAt: Date.now(),
      windows: [],
      credits: { remaining: a.credits, total: a.credits_total, unit: 'credits' },
    };
  }

  async listAccounts(options?: SidecarReadOptions): Promise<SidecarAccount[]> {
    await this.prepareRead(options);
    const o = await this.api<{ accounts?: WbAccount[] }>('/panel/api/overview');
    return (o.accounts ?? []).map((a) => {
      // 「banned by upstream … re-login required」: the login is dead, not paused — the row says 要重新登录
      const relogin = a.disabled && /re-?login|banned|11140|11128/i.test(`${a.disabled_reason ?? ''} ${a.reason ?? ''}`);
      const health: SidecarAccount['health'] = relogin ? 'expired' : a.disabled ? 'disabled' : a.cooling || a.paused ? 'cooling' : 'ok';
      return {
        remoteId: a.uid,
        name: a.nickname?.trim() || a.uid,
        enabled: !a.disabled,
        health,
        lastError: relogin ? tr('WorkBuddy 拒绝了这个账号的请求（{reason}），要重新扫码登录', { reason: (a.disabled_reason || a.reason || '').replace(/^account banned by upstream \(|\), re-login required$/g, '') }) : a.last_error || a.disabled_reason || a.reason || undefined,
        quota: this.quota(a),
        identity: a.nickname ? { email: a.nickname } : undefined,
      };
    });
  }

  async addAccount(input: SidecarAccountInput): Promise<SidecarAccount> {
    const accounts = accountsOf(input.credential);
    if (!accounts.length) throw new Error(tr('WorkBuddy 凭据需要包含 uid / accessToken / refreshToken 的 JSON'));
    await this.ensureReady();
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(accounts)], { type: 'application/json' }), 'accounts.json');
    await this.api('/panel/api/import/cockpit', { method: 'POST', body: form as any });
    const list = await this.listAccounts();
    const hit = accounts.map((a) => list.find((x) => x.remoteId === a.uid)).find(Boolean);
    return hit ?? { remoteId: accounts[0].uid, name: accounts[0].nickname || accounts[0].uid, enabled: true, health: 'unknown' };
  }

  async updateAccount(remoteId: string, patch: SidecarAccountPatch): Promise<SidecarAccount> {
    await this.ensureReady();
    const uid = encodeURIComponent(remoteId);
    if (patch.enabled === false) await this.api(`/panel/api/accounts/${uid}/disable`, { method: 'POST' });
    if (patch.enabled === true) await this.api(`/panel/api/accounts/${uid}/revive`, { method: 'POST' });
    const a = (await this.listAccounts()).find((x) => x.remoteId === remoteId);
    if (!a) throw new Error(tr('组件里没有这个账号'));
    return a;
  }

  async removeAccount(remoteId: string): Promise<void> {
    await this.ensureReady();
    await this.api(`/panel/api/accounts/${encodeURIComponent(remoteId)}/remove`, { method: 'POST' });
  }

  async checkAccount(remoteId: string): Promise<SidecarAccount> {
    await this.ensureReady();
    const uid = encodeURIComponent(remoteId);
    try {
      await this.api(`/panel/api/accounts/${uid}/balance`, { method: 'POST' });
    } catch { /* the pool's own view is still useful */ }
    const a = (await this.listAccounts()).find((x) => x.remoteId === remoteId);
    if (!a) throw new Error(tr('组件里没有这个账号'));
    return a;
  }

  async runTask(remoteId: string, task: MaintenanceKind): Promise<TaskResult> {
    await this.ensureReady();
    const uid = encodeURIComponent(remoteId);
    switch (task) {
      case 'checkin':
        return this.api(`/panel/api/accounts/${uid}/checkin`, { method: 'POST' });
      case 'growth':
        return this.api(`/panel/api/accounts/${uid}/tasks/auto_all`, { method: 'POST' });
      case 'keepalive':
        return this.api('/panel/api/keepalive_all', { method: 'POST' });
      case 'travel':
        return this.api('/panel/api/travel_all', { method: 'POST' });
      case 'activity':
        return this.api('/panel/api/activity_all', { method: 'POST' });
      case 'lottery':
        // the sidecar's streak guardian runs the lottery right after a check-in
        return this.api('/panel/api/checkin_all', { method: 'POST' });
      case 'quota-refresh': {
        // the panel's balance answer is its own shape; read the account back so the row gets a QuotaSnapshot
        const a = await this.checkAccount(remoteId);
        return { ok: a.health !== 'error' && a.health !== 'expired', detail: a.lastError, quota: a.quota };
      }
      case 'account-check': {
        const a = await this.checkAccount(remoteId);
        return { ok: a.health !== 'error' && a.health !== 'expired', detail: a.lastError, quota: a.quota };
      }
    }
  }

  async endpoint(): Promise<{ baseUrl: string; apiKey: string } | null> {
    try {
      await this.ensureReady();
      return { baseUrl: `${this.base()}/v1`, apiKey: this.apiKey };
    } catch { return null; }
  }

  async startLogin(realm: 'cn' | 'global' = 'cn'): Promise<{ url: string; state: string }> {
    await this.ensureReady();
    return this.api('/panel/api/login/start', { method: 'POST', body: JSON.stringify({ realm }) });
  }

  async pollLogin(state: string): Promise<{ done: boolean; message?: string; uid?: string }> {
    await this.ensureReady();
    return this.api(`/panel/api/login/poll?state=${encodeURIComponent(state)}`);
  }

  async logs(lines: number): Promise<string> { return this.manager?.logs('workbuddy', lines) ?? ''; }
}
