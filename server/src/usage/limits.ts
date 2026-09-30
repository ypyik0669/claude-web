import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { claudeDir } from '../sessions/service.js';
import { proxy } from '../net/proxy.js';

export interface LimitWindow {
  label: string; // "5h", "7d", "7d Fable"
  percent: number;
  resetsAt: string | null;
  active: boolean;
  severity?: string;
}
export interface Limits {
  ok: boolean;
  capturedAt: string;
  windows: LimitWindow[];
  subscriptionType?: string;
  rateLimitTier?: string;
  error?: string;
}

/**
 * Claude subscription rate-limit windows, read from the same OAuth endpoint the CLI's /usage
 * command uses. Uses the token Claude Code already stored locally; nothing is written.
 */
export class LimitsService {
  private cache: Limits | null = null;
  private at = 0;

  private backoffUntil = 0;
  private inflight: Promise<Limits> | null = null;

  /** Cached for 4 minutes; a 429 backs off for 15 minutes. The endpoint rate-limits eagerly. */
  async get(force = false): Promise<Limits> {
    const ttl = force ? 30_000 : 4 * 60_000;
    if (this.cache && (Date.now() - this.at < ttl || Date.now() < this.backoffUntil)) return this.cache;
    // the idle push, the 5-minute push and a client's limits.get can all miss the cache together;
    // share one request instead of firing several at an endpoint that 429s eagerly
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async refresh(): Promise<Limits> {
    const next = await this.fetch();
    if (next.error === 'HTTP 429') this.backoffUntil = Date.now() + 15 * 60_000;
    // keep the last good reading on transient failures so the UI does not flicker to "–"
    this.cache = next.ok || !this.cache?.ok ? next : { ...this.cache, error: next.error };
    this.at = Date.now();
    return this.cache;
  }

  private async fetch(): Promise<Limits> {
    const now = new Date().toISOString();
    try {
      const cred = JSON.parse(await readCredentials());
      const o = cred.claudeAiOauth;
      if (!o?.accessToken) return { ok: false, capturedAt: now, windows: [], error: 'no OAuth token (API-key login?)' };
      await proxy.refresh(); // api.anthropic.com: behind the ladder in mainland China
      const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-web' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { ok: false, capturedAt: now, windows: [], error: `HTTP ${r.status}`, subscriptionType: o.subscriptionType };
      const d: any = await r.json();
      const windows: LimitWindow[] = [];
      for (const l of d.limits ?? []) {
        const label = l.kind === 'session' ? '5h' : l.kind === 'weekly_all' ? '7d' : l.kind === 'weekly_scoped' ? `7d ${l.scope?.model?.display_name ?? l.scope?.surface ?? ''}`.trim() : l.kind;
        windows.push({ label, percent: Math.round(l.percent ?? 0), resetsAt: l.resets_at ?? null, active: !!l.is_active, severity: l.severity });
      }
      if (!windows.length) {
        if (d.five_hour) windows.push({ label: '5h', percent: Math.round(d.five_hour.utilization), resetsAt: d.five_hour.resets_at, active: true });
        if (d.seven_day) windows.push({ label: '7d', percent: Math.round(d.seven_day.utilization), resetsAt: d.seven_day.resets_at, active: false });
      }
      return { ok: true, capturedAt: now, windows, subscriptionType: o.subscriptionType, rateLimitTier: o.rateLimitTier };
    } catch (e: any) {
      return { ok: false, capturedAt: now, windows: [], error: e?.message ?? String(e) };
    }
  }
}

/**
 * Claude Code's OAuth credentials: `~/.claude/.credentials.json` on Windows / Linux; on macOS the CLI keeps
 * them in the login Keychain instead, so the file is usually absent there.
 */
async function readCredentials(): Promise<string> {
  try {
    return await fs.readFile(path.join(claudeDir, '.credentials.json'), 'utf8');
  } catch (e) {
    if (process.platform !== 'darwin') throw e;
    return new Promise((res, rej) =>
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { windowsHide: true, timeout: 10_000 }, (err, out) => (err ? rej(e) : res(String(out).trim()))),
    );
  }
}
