// What the signed-in Claude account has right now, from Anthropic itself instead of a table in our source:
// `GET /v1/models` (the models this account can use — Fable 5.2 showed up here before any release of ours knew it)
// and `GET /api/oauth/profile` (`organization.plan_display_name`, the plan's current name: "Max" became "Ultra").
// Both take the OAuth token Claude Code stored; nothing is written to its files. Refreshed hourly, on demand, and
// remembered in `<data>/claude-live.json` so a restart without network still has the last answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { proxy } from '../net/proxy.js';
import { claudeCodeVersion } from '../claude-version.js';
import { readCredentials } from './limits.js';

export interface LiveModel { id: string; displayName: string }
export interface ClaudeLiveState { models: LiveModel[]; plan?: string; at: number; error?: string }

const file = () => path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'claude-live.json');
const HOUR = 60 * 60_000;

/** Newest first, as the API lists them. The family is the word in the id (`claude-fable-5-2` → fable). */
export function familyOf(id: string): 'fable' | 'opus' | 'sonnet' | 'haiku' | null {
  const m = /(fable|opus|sonnet|haiku)/.exec(id);
  return (m?.[1] as 'fable' | 'opus' | 'sonnet' | 'haiku' | undefined) ?? null;
}

export class ClaudeLive extends EventEmitter {
  private state: ClaudeLiveState | null = null;
  private inflight: Promise<ClaudeLiveState | null> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private fetchImpl: typeof fetch = (...a) => fetch(...a), private token: () => Promise<string | undefined> = defaultToken) {
    super();
  }

  /** The last known answer (loaded from disk on first use), or null when there never was one. */
  get(): ClaudeLiveState | null {
    if (this.state) return this.state;
    try {
      const s = JSON.parse(fs.readFileSync(file(), 'utf8')) as ClaudeLiveState;
      if (Array.isArray(s?.models)) this.state = s;
    } catch { /* never fetched */ }
    return this.state;
  }

  models(): LiveModel[] { return this.get()?.models ?? []; }
  /** The plan's name: ours from the profile, else what Claude Code itself last stored in ~/.claude.json. */
  plan(): string | undefined {
    const p = this.get()?.plan;
    if (p) return p;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))?.oauthAccount?.planDisplayName;
      return typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : undefined;
    } catch { return undefined; }
  }

  /** The newest model of each family — what the official CLI's aliases resolve to (measured on 2.1.322: same). */
  newest(): Partial<Record<'fable' | 'opus' | 'sonnet' | 'haiku', string>> {
    const out: Partial<Record<'fable' | 'opus' | 'sonnet' | 'haiku', string>> = {};
    for (const m of this.models()) { const f = familyOf(m.id); if (f && !out[f]) out[f] = m.id; }
    return out;
  }

  /** Fetch now (shared when one is already running). A failure keeps the previous answer and records the error. */
  refresh(): Promise<ClaudeLiveState | null> {
    this.inflight ??= this.fetchBoth().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Background: once shortly after start, then hourly. Unref'd. */
  start(delayMs = 3000): void {
    if (process.env.CW_NO_MODEL_REFRESH || this.timer) return;
    const t = setTimeout(() => void this.refresh(), delayMs);
    t.unref?.();
    this.timer = setInterval(() => void this.refresh(), HOUR);
    this.timer.unref?.();
  }

  private async fetchBoth(): Promise<ClaudeLiveState | null> {
    const prev = this.get();
    const token = await this.token().catch(() => undefined);
    if (!token) return prev;
    await proxy.refresh().catch(() => {});
    const headers = { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'User-Agent': `claude-cli/${claudeCodeVersion()} (external, cli)` };
    const get = async (url: string) => {
      const r = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<any>;
    };
    const [models, profile] = await Promise.allSettled([get('https://api.anthropic.com/v1/models?limit=1000'), get('https://api.anthropic.com/api/oauth/profile')]);
    const list: LiveModel[] = models.status === 'fulfilled' && Array.isArray(models.value?.data)
      ? models.value.data.filter((m: any) => typeof m?.id === 'string').map((m: any) => ({ id: m.id, displayName: String(m.display_name || m.id).replace(/^Claude\s+/, '') }))
      : [];
    const planRaw = profile.status === 'fulfilled' ? profile.value?.organization?.plan_display_name : undefined;
    // the CLI only accepts a short plain name (letters, digits, spaces, `.+-`); anything else is ignored there too
    const plan = typeof planRaw === 'string' && /^[\p{L}\p{N}](?:[\p{L}\p{N} .+-]{0,38}[\p{L}\p{N}+])?$/u.test(planRaw) ? planRaw : undefined;
    const err = [models, profile].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
    const next: ClaudeLiveState = {
      models: list.length ? list : prev?.models ?? [],
      plan: plan ?? (profile.status === 'fulfilled' ? undefined : prev?.plan),
      at: list.length || plan ? Date.now() : prev?.at ?? 0,
      ...(err ? { error: String((err.reason as Error)?.message ?? err.reason) } : {}),
    };
    const changed = JSON.stringify(next.models) !== JSON.stringify(prev?.models ?? []) || next.plan !== prev?.plan;
    this.state = next;
    try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(next)); } catch { /* read-only */ }
    if (changed) this.emit('change', next);
    return next;
  }
}

async function defaultToken(): Promise<string | undefined> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return JSON.parse(await readCredentials())?.claudeAiOauth?.accessToken;
}

/** The process-wide instance: the catalog, the model menu and the account row all read this one. */
export const claudeLive = new ClaudeLive();
