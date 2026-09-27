// Minimal 5-field cron (minute hour day-of-month month day-of-week) with lists, ranges, steps and names.
// Local time. Good enough for "every weekday at 9", "*/30 * * * *", "0 18 * * 1-5".

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(f: string, min: number, max: number, names: string[] = []): Set<number> {
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const m = /^(\*|[\w]+)(?:-([\w]+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`cron 字段无效：${part}`);
    const val = (s: string) => { const i = names.indexOf(s.toLowerCase()); if (i >= 0) return i + (names === DAYS ? 0 : 1); const n = Number(s); if (!Number.isInteger(n)) throw new Error(`cron 值无效：${s}`); return n; };
    let lo = m[1] === '*' ? min : val(m[1]);
    let hi = m[1] === '*' ? max : m[2] ? val(m[2]) : lo;
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) throw new Error(`cron 步长无效：${part}`); // "*/0" would loop forever below and hang the server
    if (m[1] !== '*' && !m[2] && m[3]) hi = max; // "5/10" → from 5 step 10
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 范围越界：${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  // day-of-week 7 is Sunday too; normalising after expansion keeps ranges like "5-7" / "sat-7" valid
  if (names === DAYS && out.delete(7)) out.add(0);
  return out;
}

export interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const ALIASES: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

export function parseCron(expr: string): CronSpec {
  const e = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error('cron 需要 5 个字段：分 时 日 月 周');
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12, MONTHS),
    dow: parseField(f[4], 0, 7, DAYS),
    domStar: f[2] === '*',
    dowStar: f[4] === '*',
  };
}

/** Next run strictly after `from` (local time). Searches up to ~2 years. */
export function nextCron(expr: string | CronSpec, from: Date = new Date()): Date {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 2 * 366 * 86400_000;
  while (t.getTime() < limit) {
    if (!c.month.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
    // standard cron: when both day fields are restricted, either matching counts
    const domOk = c.dom.has(t.getDate()), dowOk = c.dow.has(t.getDay());
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk;
    if (!dayOk) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
    return t;
  }
  throw new Error('cron 表达式在两年内没有匹配的时间');
}

/** Human description for the UI (rough, Chinese). */
export function describeCron(expr: string): string {
  try {
    const e = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
    const [mi, h, dom, mon, dow] = e.split(/\s+/);
    const pad = (s: string) => s.padStart(2, '0');
    const when = h === '*' ? (mi.startsWith('*/') ? `每 ${mi.slice(2)} 分钟` : `每小时第 ${mi} 分`) : h.startsWith('*/') ? `每 ${h.slice(2)} 小时` : `${h.split(',').map((x) => `${pad(x)}:${pad(mi)}`).join('、')}`;
    const days = dow === '*' ? (dom === '*' ? '每天' : `每月 ${dom} 日`) : dow === '1-5' ? '工作日' : dow === '0,6' || dow === '6,0' ? '周末' : `周${dow.replace(/0/g, '日').replace(/[1-6]/g, (d) => '一二三四五六'[Number(d) - 1])}`;
    const months = mon === '*' ? '' : `${mon} 月 `;
    return `${months}${days} ${when}`.trim();
  } catch {
    return expr;
  }
}
