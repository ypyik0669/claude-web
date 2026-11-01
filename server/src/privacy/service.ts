// The privacy pipeline's owner (spec 2026-10-27 §7.6): settings in meta.json (`privacy`), the per-process placeholder
// HMAC key, and the hit counters the privacy center shows. Request paths ask `forRequest()` for a guard.
import type { MetaStore } from '../meta/store.js';
import { tr } from '../i18n/index.js';
import { compile, customDetectors, PROCESS_SECRET, redactText, scrubForLog, TAG, type Compiled } from './detect.js';
import { redactBody, redactValue, restoreResponse } from './pipeline.js';
import path from 'node:path';
import { PrivacyModel } from './model/index.js';
import { maskOutput, outputCompiled } from './output.js';
import { RecordStore } from './records.js';
import { DEFAULT_PRIVACY, PRIVACY_CATEGORIES, type PrivacyCategory, type PrivacyHit, type PrivacyPreview, type PrivacyRecord, type PrivacyRequest, type PrivacySettings, type PrivacyStats, type PrivacyStatus } from './types.js';
import type http from 'node:http';

/** The request was refused by a `block` rule: nothing was sent. */
export class PrivacyBlocked extends Error {
  /** 403: the content is the caller's problem; nothing left the machine. */
  readonly status = 403;
  constructor(readonly categories: PrivacyCategory[]) {
    super(tr('按隐私设置拦截：内容里有 {cats}，请求没有发出', { cats: categories.map(categoryLabel).join('、') }));
  }
}
/** The pipeline itself failed while it is on: the request is refused (fail closed), never sent raw. */
export class PrivacyFailed extends Error {
  /** 503: the protection is unavailable, so the request is not sent (never fall back to plaintext). */
  readonly status = 503;
  constructor(cause: string) { super(tr('隐私保护处理失败，请求没有发出：{cause}', { cause })); }
}

/** The status a refused request gets: 403 for a block rule, 503 for the pipeline failing (fail closed). */
export const privacyErrorStatus = (e: unknown): number => (e instanceof PrivacyBlocked ? 403 : 503);

export function categoryLabel(c: PrivacyCategory): string {
  switch (c) {
    case 'api_key': return tr('API Key');
    case 'private_key': return tr('私钥');
    case 'jwt': return 'JWT';
    case 'password': return tr('密码 / Token');
    case 'email': return tr('邮箱');
    case 'phone': return tr('手机号');
    case 'id_card': return tr('身份证号');
    case 'bank_card': return tr('银行卡号');
    case 'name': return tr('人名');
    case 'address': return tr('地址');
    case 'custom': return tr('自定义内容');
  }
}

/** Records kept for the privacy center: 30 days, capped in memory (types / lengths / prefixes only). */
const RECENT = 500;
const RECORD_TTL = 30 * 24 * 60 * 60_000;

/** Host on this machine or the local network (an upstream that keeps the prompt here). */
export function isLocalUrl(url: string | undefined): boolean {
  let h = '';
  try { h = new URL(url ?? '').hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/**
 * One request's view of the pipeline (one upstream attempt). Its answer only gets back the values THIS request
 * redacted (`own`): a placeholder from another conversation, another agent or a LAN share-key caller that an upstream
 * or a prompt injection makes the model emit stays a placeholder. History is re-sent every turn, so an echo of an
 * earlier turn's secret is still covered — that turn's text is redacted again in this request.
 */
export class PrivacyGuard {
  readonly hits: PrivacyHit[] = [];
  /** placeholder → value, filled only by this request's own bodies */
  private readonly own = new Map<string, string>();
  /** text → the local model's spans in it (filled by prepare) */
  private modelSpans: Map<string, { start: number; end: number; category: PrivacyCategory }[]> | null = null;
  constructor(private svc: PrivacyService, private c: Compiled, readonly source: string) {}
  /**
   * With the local model on: run it over every text this body would send (async; call before body()). Paths that do
   * not call it get the rules only. The model failing while it is on refuses the request (PrivacyFailed).
   */
  async prepare(b: Buffer): Promise<void> {
    if (!b.length || !this.svc.modelOn()) return;
    const texts = new Set<string>();
    const all = Object.fromEntries(PRIVACY_CATEGORIES.map((k) => [k, 'redact'])) as PrivacySettings['actions'];
    const collect: Compiled = { detectors: [], actions: all, allow: new Set(), bad: [], finders: [{ category: 'name', find: (t) => { if (t.trim().length >= 2) texts.add(t); return []; } }] };
    const raw = b.toString('utf8');
    let json: unknown;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    if (json === undefined) texts.add(raw);
    else redactValue(json, collect, this.svc.secret(), new Map(), []);
    if (!texts.size) return;
    const list = [...texts];
    let found: { start: number; end: number; category: PrivacyCategory }[][];
    try { found = await this.svc.model.find(list, this.svc.settings().model.minScore); } catch (e: any) { throw new PrivacyFailed(e?.message ?? String(e)); }
    const spans = (this.modelSpans ??= new Map());
    list.forEach((t, i) => { if (found[i]?.length) spans.set(t, found[i]); });
    this.c = { ...this.c, finders: [...(this.c.finders ?? []), { category: 'name', find: (t) => spans.get(t) ?? [] }] };
  }
  /** A body before it leaves. Throws PrivacyBlocked / PrivacyFailed — the caller refuses the request. */
  body(b: Buffer): Buffer {
    let r: { body: Buffer; hits: PrivacyHit[] };
    try { r = redactBody(b, this.c, this.svc.secret(), this.own); } catch (e: any) { throw new PrivacyFailed(e?.message ?? String(e)); }
    const blocked = [...new Set(r.hits.filter((h) => h.action === 'block').map((h) => h.category))];
    this.hits.push(...r.hits);
    if (blocked.length) throw new PrivacyBlocked(blocked);
    return r.body;
  }
  /** A variant of the same request (a retry without one field): the same placeholders, its hits not counted again. */
  variant(b: Buffer | null): Buffer | null {
    if (!b) return b;
    const before = this.hits.length;
    let r: { body: Buffer; hits: PrivacyHit[] };
    try { r = redactBody(b, this.c, this.svc.secret(), this.own); } catch (e: any) { throw new PrivacyFailed(e?.message ?? String(e)); }
    if (r.hits.some((h) => h.action === 'block')) throw new PrivacyBlocked([...new Set(r.hits.filter((h) => h.action === 'block').map((h) => h.category))]);
    this.hits.length = before;
    return r.body;
  }
  get redacted(): boolean { return this.hits.some((h) => h.action === 'redact'); }
  /** Put this request's own placeholders back in what goes to the client (never another request's). */
  restore(res: http.ServerResponse, stream: boolean) { if (this.redacted) restoreResponse(res, this.own, stream); }
  /** Count it, and the audit line's summary (types, counts, placeholders — never values). */
  done(blocked = false): PrivacyRecord | undefined { return this.svc.note(this.source, this.hits, blocked); }
}

export class PrivacyService {
  // No process-wide placeholder → value map: a placeholder is an HMAC of the value (same value, same placeholder, no
  // cache needed), and the way back is each guard's own map, so one request can never restore another's secrets.
  private compiled: Compiled | null = null;
  private stats: PrivacyStats = { since: Date.now(), requests: 0, redacted: 0, warned: 0, blocked: 0, hits: {}, recent: [] };
  private onChange: (() => void) | null = null;

  private records: RecordStore;
  readonly model: PrivacyModel;
  private armHooks: (() => void)[] = [];
  private outCache: { key: string; c: Compiled | null } | null = null;

  /**
   * `dataDir`: where the records (privacy-records/) and the local model (privacy-model/) live; none (tests) = records
   * in memory only, no model.
   */
  constructor(private meta: MetaStore, opts: { dataDir?: string | null; model?: PrivacyModel } = {}) {
    this.records = new RecordStore(opts.dataDir ? path.join(opts.dataDir, 'privacy-records') : null);
    this.model = opts.model ?? new PrivacyModel(opts.dataDir ? path.join(opts.dataDir, 'privacy-model') : null);
    this.model.listen(() => this.onChange?.());
    try { this.stats.recent = this.records.recent(RECENT); } catch { /* none */ }
  }

  /** Called once privacy is turned on for the first time (立即生效: running conversations should start using the relay). */
  onArm(fn: () => void) { this.armHooks.push(fn); }

  /** Called on every change of settings or counters (the hub broadcasts `privacy.changed`). */
  listen(fn: () => void) { this.onChange = fn; }

  settings(): PrivacySettings {
    // never let an old persisted placeholder secret ride out in `privacy.get` / `privacy.changed`
    const { secret: _secret, armedAt: _armed, ...raw } = (this.meta.privacyConfig() ?? {}) as Partial<PrivacySettings> & { secret?: string; armedAt?: number };
    return {
      ...DEFAULT_PRIVACY,
      ...raw,
      actions: { ...DEFAULT_PRIVACY.actions, ...(raw.actions ?? {}) },
      words: raw.words ?? [],
      patterns: raw.patterns ?? [],
      allow: raw.allow ?? [],
      model: { ...DEFAULT_PRIVACY.model, ...(raw.model ?? {}) },
    };
  }

  /** Privacy has been on at least once in this install (立即生效 keeps routing through the relay from then on). */
  armed(): boolean { return !!(this.meta.privacyConfig() as { armedAt?: number } | undefined)?.armedAt; }

  /** The local model is on (with the pipeline). */
  modelOn(): boolean { const s = this.settings(); return PrivacyService.on(s) && s.model.enabled; }

  /** The HMAC key placeholders are derived with: one random key per process (same value → same placeholder). */
  secret(): Buffer { return PROCESS_SECRET; }

  /** On = the switch is on and at least one type is looked for. */
  static on(s: PrivacySettings): boolean { return s.enabled && Object.values(s.actions).some((a) => a !== 'off'); }
  active(): boolean { return PrivacyService.on(this.settings()); }

  /**
   * Does traffic to `url` go through the relay? On, and not a local upstream skipped by 本机跳过 — or 立即生效 armed
   * (privacy was on once): then always, and the relay decides per request with the settings of that moment, so a
   * switch or a rule changed later reaches conversations already running.
   */
  wants(url: string): boolean {
    const s = this.settings();
    if (s.standby && this.armed()) return true;
    return PrivacyService.on(s) && !(s.skipLocal && isLocalUrl(url));
  }

  /** New conversations go through the relay (whatever their upstream). */
  routed(): boolean { const s = this.settings(); return (s.standby && this.armed()) || PrivacyService.on(s); }

  private compiledNow(): Compiled { return (this.compiled ??= compile(this.settings())); }

  status(): PrivacyStatus {
    const s = this.settings();
    return { settings: s, stats: this.stats, badPatterns: customDetectors(s).bad, routed: this.routed(), model: this.model.status() };
  }

  async set(patch: Extract<PrivacyRequest, { kind: 'privacy.set' }>['patch']): Promise<PrivacyStatus> {
    const cfg = this.meta.privacyConfig();
    const cur = this.settings();
    const clean = (l: unknown) => (Array.isArray(l) ? [...new Set(l.map((x) => String(x)).filter((x) => x.trim()))].slice(0, 500) : undefined);
    const pm = (patch.model ?? {}) as Partial<PrivacySettings['model']>;
    const model = {
      enabled: typeof pm.enabled === 'boolean' ? pm.enabled : cur.model.enabled,
      minScore: typeof pm.minScore === 'number' && Number.isFinite(pm.minScore) ? Math.min(0.99, Math.max(0.5, pm.minScore)) : cur.model.minScore,
    };
    // the model only goes on once it can run: downloaded (checked) and onnxruntime-node installed
    if (model.enabled && !cur.model.enabled && !(this.model.installed() && this.model.runtime())) {
      throw new Error(this.model.runtime() ? tr('先下载本地模型') : tr('先装好 onnxruntime-node（不随应用附带），再打开本地模型'));
    }
    const next: PrivacySettings = {
      enabled: patch.enabled ?? cur.enabled,
      skipLocal: patch.skipLocal ?? cur.skipLocal,
      standby: typeof patch.standby === 'boolean' ? patch.standby : cur.standby,
      output: typeof patch.output === 'boolean' ? patch.output : cur.output,
      model,
      actions: { ...cur.actions },
      words: clean(patch.words) ?? cur.words,
      patterns: clean(patch.patterns) ?? cur.patterns,
      allow: clean(patch.allow) ?? cur.allow,
    };
    for (const [k, v] of Object.entries(patch.actions ?? {})) if ((PRIVACY_CATEGORIES as string[]).includes(k) && ['off', 'redact', 'warn', 'block'].includes(String(v))) next.actions[k as PrivacyCategory] = v as PrivacySettings['actions'][PrivacyCategory];
    Object.assign(cfg, next);
    const armedCfg = cfg as { armedAt?: number };
    const arming = next.enabled && !armedCfg.armedAt;
    if (next.enabled) armedCfg.armedAt ??= Date.now();
    this.compiled = null;
    this.outCache = null;
    await this.meta.savePrivacy();
    if (arming) for (const fn of this.armHooks) { try { fn(); } catch { /* a hook failing changes nothing here */ } }
    this.onChange?.();
    return this.status();
  }

  /**
   * A guard for one request to `url` (null = the pipeline does not apply: off, or a local upstream with 本机跳过).
   * `cloud`: the upstream forwards elsewhere though its address is local (a sidecar) — never skipped.
   */
  forRequest(o: { url?: string; source: string; cloud?: boolean }): PrivacyGuard | null {
    const s = this.settings();
    if (!PrivacyService.on(s)) return null;
    if (s.skipLocal && !o.cloud && isLocalUrl(o.url)) return null;
    let c: Compiled;
    try { c = this.compiledNow(); } catch (e: any) { throw new PrivacyFailed(e?.message ?? String(e)); }
    return new PrivacyGuard(this, c, o.source);
  }

  /** What an upstream would get for this text. Nothing is stored: a throwaway map, no counters. */
  preview(text: string, settings?: PrivacySettings): PrivacyPreview {
    const s = settings ? { ...DEFAULT_PRIVACY, ...settings, actions: { ...DEFAULT_PRIVACY.actions, ...settings.actions } } : this.settings();
    const c = compile(s);
    const r = redactText(String(text ?? '').slice(0, 200_000), c, this.secret(), new Map());
    return { text: r.text, hits: r.hits, blocked: r.hits.some((h) => h.action === 'block'), badPatterns: c.bad };
  }

  /**
   * What claude-web writes out (log lines, diagnostics, exports): secrets always, and with 隐私保护 and 「日志和导出也遮住」
   * on, every type the user turned on — as `[TYPE]` tags (privacy/output.ts).
   */
  maskOutput(text: string): string {
    if (!text) return text;
    try {
      const s = this.settings();
      const key = JSON.stringify(s);
      if (this.outCache?.key !== key) this.outCache = { key, c: outputCompiled(s) };
      return maskOutput(text, this.outCache.c);
    } catch { return scrubForLog(text); }
  }

  /** Logs, errors and diagnostics: secrets (and the user's custom words) masked whatever the settings. */
  scrub(text: string): string {
    if (!text) return text;
    try {
      const s = this.settings();
      return scrubForLog(text, s.enabled ? customDetectors(s).list : []);
    } catch { return scrubForLog(text); }
  }

  note(source: string, hits: PrivacyHit[], blocked: boolean): PrivacyRecord | undefined {
    this.stats.requests++;
    if (!hits.length) return undefined;
    const categories: Partial<Record<PrivacyCategory, number>> = {};
    for (const h of hits) { categories[h.category] = (categories[h.category] ?? 0) + 1; this.stats.hits[h.category] = (this.stats.hits[h.category] ?? 0) + 1; }
    const redacted = hits.filter((h) => h.action === 'redact');
    const warned = hits.filter((h) => h.action === 'warn').length;
    if (redacted.length) this.stats.redacted++;
    if (warned) this.stats.warned++;
    if (blocked) this.stats.blocked++;
    const now = Date.now();
    const rec: PrivacyRecord = {
      ts: now,
      source,
      count: hits.length,
      categories,
      placeholders: [...new Set(redacted.map((h) => h.placeholder!))].slice(0, 20),
      // records keep type / length / prefix — never the value, and never a reversible form of it
      entries: hits.slice(0, 100).map((h) => ({ category: h.category, length: h.length, ...(h.prefix ? { prefix: h.prefix } : {}) })),
      ...(blocked ? { blocked } : {}),
      ...(warned ? { warned } : {}),
    };
    this.stats.recent.unshift(rec);
    void this.records.add(rec);
    const cutoff = now - RECORD_TTL;
    while (this.stats.recent.length && this.stats.recent[this.stats.recent.length - 1].ts < cutoff) this.stats.recent.pop();
    if (this.stats.recent.length > RECENT) this.stats.recent.length = RECENT;
    this.onChange?.();
    return rec;
  }

  clearStats() { this.stats = { since: Date.now(), requests: 0, redacted: 0, warned: 0, blocked: 0, hits: {}, recent: [] }; this.onChange?.(); }

  /** Resolves once every record noted so far is on disk. */
  recordsWritten(): Promise<void> { return this.records.idle(); }

  /** Forget the records: the counters, memory and the day files. */
  async clearRecords(): Promise<PrivacyStatus> {
    this.clearStats();
    await this.records.clear();
    return this.status();
  }
}

export { TAG };

/** Hub dispatch for `privacy.*`. */
export const isPrivacyRequest = (req: { kind: string }): req is PrivacyRequest => req.kind.startsWith('privacy.');
export async function handlePrivacyRequest(p: PrivacyService, req: PrivacyRequest): Promise<unknown> {
  switch (req.kind) {
    case 'privacy.get': return p.status();
    case 'privacy.set': return p.set(req.patch ?? {});
    case 'privacy.preview': return p.preview(req.text, req.settings);
    case 'privacy.model.download': void p.model.download(); return p.status();
    case 'privacy.model.cancel': p.model.cancel(); return p.status();
    case 'privacy.model.remove': {
      // the model goes off with its files
      if (p.settings().model.enabled) await p.set({ model: { ...p.settings().model, enabled: false } });
      await p.model.remove();
      return p.status();
    }
    case 'privacy.records.clear': return p.clearRecords();
  }
  throw new Error(`unknown request ${(req as { kind: string }).kind}`);
}
