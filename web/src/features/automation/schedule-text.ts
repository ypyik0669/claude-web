// A scheduled task's times and period in words (redesign phase 7, review I6) — shared by the start page's
// 定时任务 list and the automation page. Pure.
import type { Schedule } from '@shared';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When a schedule runs next: 5 分钟后 · 2 小时后 (under 3 hours, rounded down) · 今天 18:00 · 明天 09:00 · 周一 09:00
 * (within a week) · 10/6 09:00. A time already past (the server has not moved it yet) reads 1 分钟后.
 */
export function nextRunText(ts: number, now = Date.now()): string {
  const d = Math.max(0, ts - now);
  if (d < 3600_000) return `${Math.max(1, Math.floor(d / 60_000))} 分钟后`;
  if (d < 3 * 3600_000) return `${Math.floor(d / 3600_000)} 小时后`;
  const t = new Date(ts);
  const days = Math.round((dayStart(t) - dayStart(new Date(now))) / 86400_000);
  if (days <= 0) return `今天 ${hhmm(t)}`;
  if (days === 1) return `明天 ${hhmm(t)}`;
  if (days < 7) return `周${WEEK[t.getDay()]} ${hhmm(t)}`;
  return `${t.getMonth() + 1}/${t.getDate()} ${hhmm(t)}`;
}

const ALIASES: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

const int = (s: string, lo: number, hi: number): number | null => (/^\d+$/.test(s) && Number(s) >= lo && Number(s) <= hi ? Number(s) : null);
/** A day of the week (0–7 or a name) → 0–6. */
const dow = (s: string): number | null => {
  const i = DAY_NAMES.indexOf(s.toLowerCase());
  if (i >= 0) return i;
  const n = int(s, 0, 7);
  return n === null ? null : n % 7;
};
/** The day-of-week field as a list of days, or null when it is something else (steps, odd ranges). */
function dows(f: string): number[] | null {
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const r = /^(\w+)-(\w+)$/.exec(part);
    if (r) {
      const a = dow(r[1]), b = r[2] === '7' ? 7 : dow(r[2]);
      if (a === null || b === null || a > b) return null;
      for (let x = a; x <= b; x++) out.add(x % 7);
    } else {
      const x = dow(part);
      if (x === null) return null;
      out.add(x);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A cron expression in words: 每 30 分钟 · 每小时 · 每小时第 15 分 · 每 2 小时 · 每天 09:00 · 工作日 09:00 · 周末 10:00 ·
 * 每周一 09:00 · 每周一、三、五 09:00 · 每月 1 日 09:00. null = not one of these (the caller shows the expression).
 */
export function cronText(expr: string): string | null {
  const e = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dw] = f;
  if (mon !== '*') return null;
  // minute / hour steps, every day
  if (dom === '*' && dw === '*') {
    if (mi === '*' && h === '*') return '每分钟';
    const step = /^\*\/(\d+)$/.exec(mi);
    if (step && h === '*') return `每 ${Number(step[1])} 分钟`;
    const m = int(mi, 0, 59);
    if (m !== null && h === '*') return m === 0 ? '每小时' : `每小时第 ${m} 分`;
    const hs = /^\*\/(\d+)$/.exec(h);
    if (m !== null && hs) return m === 0 ? `每 ${Number(hs[1])} 小时` : `每 ${Number(hs[1])} 小时（第 ${m} 分）`;
  }
  const m = int(mi, 0, 59), hr = int(h, 0, 23);
  if (m === null || hr === null) return null;
  const at = `${pad(hr)}:${pad(m)}`;
  if (dom === '*' && dw === '*') return `每天 ${at}`;
  if (dw === '*') {
    const d = int(dom, 1, 31);
    return d === null ? null : `每月 ${d} 日 ${at}`;
  }
  if (dom !== '*') return null;
  const days = dows(dw);
  if (!days || !days.length) return null;
  if (days.length === 7) return `每天 ${at}`;
  if (days.join() === '1,2,3,4,5') return `工作日 ${at}`;
  if (days.join() === '0,6') return `周末 ${at}`;
  // Monday first, the way a week is read here
  const order = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `每周${order.map((x) => WEEK[x]).join('、')} ${at}`;
}

/** A schedule's period in words, and the raw expression for a tooltip (none for an interval). */
export function scheduleText(s: Pick<Schedule, 'cron' | 'everyMinutes'>): { text: string; title?: string } {
  if (s.cron) return { text: cronText(s.cron) ?? s.cron, title: `cron：${s.cron}` };
  return { text: `每 ${s.everyMinutes} 分钟` };
}
