// Detectors and text redaction for the privacy pipeline (spec 2026-10-27 §7.6). Pure apart from the process-wide
// HMAC key: no I/O and no per-call state. Placeholders are `{{CATEGORY_xxxxxxxx}}` — an HMAC of the value with the
// process's random key, so the same value always gets the same placeholder (the prompt prefix stays byte-identical
// and prompt caching survives).
import crypto from 'node:crypto';
import type { PrivacyAction, PrivacyCategory, PrivacyHit, PrivacySettings } from './types.js';
import { zhNameSpans } from './zhname.js';

export const TAG: Record<PrivacyCategory, string> = {
  api_key: 'API_KEY', private_key: 'PRIVATE_KEY', jwt: 'JWT', password: 'SECRET', email: 'EMAIL', phone: 'PHONE', id_card: 'ID_CARD', bank_card: 'BANK_CARD', name: 'NAME', address: 'ADDRESS', custom: 'CUSTOM',
};

/** The HMAC key for placeholders: random per process, never written to disk and never on the wire. */
export const PROCESS_SECRET = crypto.randomBytes(32);

/** A complete placeholder anywhere in a text. */
export const PLACEHOLDER = /\{\{([A-Z][A-Z_]*?)_([a-f0-9]{8})\}\}/g;
/** A text ending in what may be the start of a placeholder (a stream chunk cut in the middle of one). */
const PARTIAL = /\{(?:\{(?:[A-Z][A-Z_]*(?:[a-f0-9]{1,8}\}?)?)?)?$/;

/** Index where a trailing partial placeholder starts, or -1. */
export function partialTail(s: string): number {
  const from = Math.max(0, s.length - 32);
  for (let i = s.indexOf('{', from); i >= 0; i = s.indexOf('{', i + 1)) if (PARTIAL.test(s.slice(i)) && !/^\{\{[A-Z][A-Z_]*_[a-f0-9]{8}\}\}$/.test(s.slice(i))) return i;
  return -1;
}

export interface Match { start: number; end: number; category: PrivacyCategory }
interface Picked { value: string; start: number }
interface Detector {
  category: PrivacyCategory;
  re: RegExp;
  /** capture group holding the value (when it is not the whole match) */
  group?: number;
  /** or: exact value and its offset inside the match (for `.env` lines, URLs, …) */
  pick?: (m: RegExpExecArray) => Picked | null;
  check?: (v: string, m: RegExpExecArray) => boolean;
}

// common key shapes: Anthropic / OpenAI / AWS / GitHub / GitLab / Slack / Google / Stripe / Hugging Face / npm / PyPI /
// xAI / Groq / DigitalOcean / SendGrid / OpenCode …
const API_KEY_PARTS = [
  String.raw`sk-ant-(?:api|oat|admin)\d{2}-[A-Za-z0-9_-]{20,}`,
  String.raw`sk-(?:proj-|svcacct-|or-v1-)?[A-Za-z0-9_-]{20,}`,
  String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`,
  String.raw`gh[pousr]_[A-Za-z0-9]{30,}`,
  String.raw`github_pat_[A-Za-z0-9_]{40,}`,
  String.raw`glpat-[A-Za-z0-9_-]{20,}`,
  String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`AIza[0-9A-Za-z_-]{35}`,
  String.raw`ya29\.[0-9A-Za-z_-]{20,}`,
  String.raw`(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}`,
  String.raw`hf_[A-Za-z0-9]{30,}`,
  String.raw`npm_[A-Za-z0-9]{36}`,
  String.raw`pypi-[A-Za-z0-9_-]{40,}`,
  String.raw`xai-[A-Za-z0-9]{40,}`,
  String.raw`gsk_[A-Za-z0-9]{40,}`,
  String.raw`r8_[A-Za-z0-9]{30,}`,
  String.raw`dop_v1_[a-f0-9]{64}`,
  String.raw`SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{30,64}`,
  String.raw`oc_sk_[A-Za-z0-9_-]{16,}`,
  String.raw`cws-[a-f0-9]{64}`,
];
const API_KEY = new RegExp(API_KEY_PARTS.map((s) => `(?<![A-Za-z0-9_-])${s}`).join('|'), 'g');
const API_KEY_ONE = new RegExp(`^(?:${API_KEY_PARTS.join('|')})$`);
const JWT_ONE = /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** Placeholder-looking / template values that must not be treated as a secret. */
const PLACEHOLDER_VALUE = /^(?:true|false|null|none|undefined|\*+|x+|changeme|change[-_]me|example|placeholder|redacted|secret|your[-_].*|\.\.\.|\$\{.*\}|\$[A-Za-z_].*|<[^>]*>|process\.env.*|os\.environ.*)$/i;

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
const cnId = (v: string) => {
  const y = Number(v.slice(6, 10));
  const mo = Number(v.slice(10, 12));
  const d = Number(v.slice(12, 14));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let s = 0;
  for (let i = 0; i < 17; i++) s += Number(v[i]) * w[i];
  return '10X98765432'[s % 11] === v[17].toUpperCase();
};

// An unquoted secret value ends where Chinese text starts (2026-11-21: 「口令：BLUE-WHALE-42。不要调用任何工具，只回复 OK1」 hid
// everything up to the space, so the model never saw 「不要调用任何工具」): CJK ideographs, CJK / full-width punctuation
// (。，：；、) and curly quotes stop it (the \u ranges in the two value classes below); accented Latin letters do not.
// `.env` / shell assignment lines: `KEY=value`, `export KEY="value with spaces"`.
const ENV_LINE = /(?:^|[\r\n])[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]{2,})[ \t]*=[ \t]*(?:"([^"\r\n]{4,})"|'([^'\r\n]{4,})'|([^\s"'`;\u2018-\u201F\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]{4,}))/gm;
const ENV_SECRET_KEY = /(?:^|_)(?:API_?KEY|KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASS|PASSWD|PASSWORD|PWD|CRED|CREDS|CREDENTIAL|CREDENTIALS|AUTH|PRIVATE|CERT|SALT|SIGNATURE|SIGNING|SESSION|COOKIE|WEBHOOK|DATABASE_URL|DB_URL|MONGO_URI|MYSQL_URL|POSTGRES_URL|REDIS_URL)(?:_|$)/i;
// `user:pass@host` and `scheme://user:pass@host` (the password is the secret; user and host stay readable).
const URL_CREDS = new RegExp(String.raw`(?<![A-Za-z0-9+.-])(?:[a-z][a-z0-9+.-]{0,15}:\/\/)?([A-Za-z0-9._%+-]{0,64}):([^\s/@]{4,128})@(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9][A-Za-z0-9._-]*(?:\.[A-Za-z0-9._-]+)*|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?`, 'gi');
const ASCII = /[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|\\:;"'<>,.?/~`]/;

const DETECTORS: Detector[] = [
  { category: 'private_key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { category: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { category: 'api_key', re: API_KEY },
  {
    category: 'password', re: URL_CREDS, group: 2,
    check: (v, m) => {
      if (PLACEHOLDER_VALUE.test(v)) return false;
      const url = m[0].includes('://');
      if (url) return true;
      // without a scheme, a `12:34@host` run is not a credential (the user part must have a letter), and
      // `mailto:user@host` is a mail address, not a password
      return /[A-Za-z]/.test(m[1]) && !/^(?:mailto|e-?mail)$/i.test(m[1]);
    },
  },
  // `.env` secrets: only the value, and only for key names that mean a credential (NODE_ENV / PORT stay readable).
  // A whole URL / DSN is left to the `user:pass@host` detector above, which hides only the password.
  {
    category: 'password', re: ENV_LINE,
    pick: (m) => {
      for (const g of [2, 3, 4]) {
        if (m[g] === undefined) continue;
        const keyAt = m[0].indexOf(m[1]);
        let at = m[0].indexOf('=', keyAt + m[1].length) + 1;
        while (m[0][at] === ' ' || m[0][at] === '\t') at++;
        if (m[0][at] === '"' || m[0][at] === "'") at++;
        return { value: m[g], start: at };
      }
      return null;
    },
    check: (v, m) => ENV_SECRET_KEY.test(m[1]) && !PLACEHOLDER_VALUE.test(v) && !v.includes('://') && !/^[^\s:@]+:[^\s/@]+@/.test(v) && !API_KEY_ONE.test(v) && !JWT_ONE.test(v),
  },
  // config-like `password = …`, `"api_key": "…"`, `TOKEN=…`: only the value
  // (ASCII lookarounds, not \b: \b never matches next to 密码 / 口令, so those keys were never found; ： is accepted too)
  {
    category: 'password',
    re: /(?<![A-Za-z0-9_])(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|密码|口令)(?![A-Za-z0-9_])["']?\s*[:=：]\s*["']?([^\s"'`,;\\<>{}\u2018-\u201F\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]{4,})/gi,
    group: 1,
    // A key / JWT value is left to its own detector (so the placeholder says API_KEY / JWT). All-CJK prose after
    // 密码： is text, not a password ("密码：请勿外传" must stay readable).
    check: (v) => !PLACEHOLDER_VALUE.test(v) && !API_KEY_ONE.test(v) && !JWT_ONE.test(v) && ASCII.test(v),
  },
  // `mailto:` addresses (the regular email detector below skips anything right after a colon)
  { category: 'email', re: /(?<![A-Za-z0-9._%+-])mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/gi, group: 1 },
  // `(?<!:)`: the `pass@host` tail of `user:pass@host` is a password, not an email (the URL detector owns it)
  { category: 'email', re: /(?<![A-Za-z0-9._%+:-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  // Chinese mobile (optionally +86), and international numbers written with their + country code
  { category: 'phone', re: /(?<![\d+])(?:(?:\+|00)86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)|(?<![\w+])\+[1-9]\d{0,2}[- ]?(?:\(\d{1,4}\)[- ]?)?\d{2,4}[- ]?\d{3,4}[- ]?\d{3,4}(?!\d)/g },
  { category: 'id_card', re: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g, check: cnId },
  // 13–19 digits with optional spaces / hyphens (Amex's 4-6-5 grouping included), Luhn-checked
  { category: 'bank_card', re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, check: (v) => { const d = v.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); } },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiled custom detectors, and the patterns that do not compile (the center shows those). */
export function customDetectors(s: Pick<PrivacySettings, 'words' | 'patterns'>): { list: Detector[]; bad: string[] } {
  const list: Detector[] = [];
  const bad: string[] = [];
  const words = s.words.map((w) => w.trim()).filter((w) => w.length >= 2);
  if (words.length) list.push({ category: 'custom', re: new RegExp(words.sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'gi') });
  for (const p of s.patterns) {
    if (!p.trim()) continue;
    try {
      const re = new RegExp(p, 'g');
      if (re.test('')) { bad.push(p); continue; } // matches the empty string: would loop / redact nothing useful
      list.push({ category: 'custom', re });
    } catch { bad.push(p); }
  }
  return { list, bad };
}

/** A finder that is not a regular expression (Chinese names by rule, the local model's spans): ranges in the text. */
export interface Finder { category: PrivacyCategory; find: (text: string) => { start: number; end: number; category?: PrivacyCategory }[] }

export interface Compiled { detectors: Detector[]; actions: PrivacySettings['actions']; allow: Set<string>; bad: string[]; finders?: Finder[] }

/** Chinese names by rule (privacy/zhname.ts). */
export const ZH_NAME_FINDER: Finder = { category: 'name', find: (t) => zhNameSpans(t) };

export function compile(s: PrivacySettings): Compiled {
  const custom = customDetectors(s);
  const detectors = [...DETECTORS, ...custom.list].filter((d) => (s.actions[d.category] ?? 'off') !== 'off');
  const finders: Finder[] = (s.actions.name ?? 'off') !== 'off' ? [ZH_NAME_FINDER] : [];
  return { detectors, actions: s.actions, allow: new Set(s.allow.map((a) => a.trim()).filter(Boolean)), bad: custom.bad, finders };
}

export function find(text: string, c: Compiled): Match[] {
  const all: Match[] = [];
  // placeholders already in the text (an earlier hop redacted it; the model echoed one): nothing inside them is matched
  const held: [number, number][] = [];
  if (text.includes('{{')) for (const m of text.matchAll(PLACEHOLDER)) held.push([m.index!, m.index! + m[0].length]);
  const inHeld = (s: number, e: number) => held.some(([a, b]) => s < b && e > a);
  for (const d of c.detectors) {
    d.re.lastIndex = 0;
    for (let m = d.re.exec(text); m; m = d.re.exec(text)) {
      if (m[0] === '') { d.re.lastIndex++; continue; }
      let v = '';
      let start = 0;
      if (d.pick) {
        const p = d.pick(m);
        if (!p || !p.value) continue;
        v = p.value;
        start = m.index + p.start;
      } else if (d.group) {
        v = m[d.group];
        if (!v) continue;
        start = m.index + m[0].lastIndexOf(v);
      } else {
        v = m[0];
        start = m.index;
      }
      if (c.allow.has(v.trim())) continue;
      if (held.length && inHeld(start, start + v.length)) continue;
      if (d.check && !d.check(v, m)) continue;
      // already a placeholder (an earlier pass, or the model echoing one)
      if (/^\{\{[A-Z][A-Z_]*_[a-f0-9]{8}\}\}$/.test(v)) continue;
      all.push({ start, end: start + v.length, category: d.category });
    }
  }
  for (const f of c.finders ?? []) {
    for (const r of f.find(text)) {
      const category = r.category ?? f.category;
      if ((c.actions[category] ?? 'off') === 'off') continue;
      if (r.end <= r.start || r.start < 0 || r.end > text.length) continue;
      const v = text.slice(r.start, r.end);
      if (c.allow.has(v.trim())) continue;
      if (held.length && inHeld(r.start, r.end)) continue;
      all.push({ start: r.start, end: r.end, category });
    }
  }
  // earlier first, then longer; overlaps go to the first (detector order puts private keys and JWTs ahead of the rest)
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Match[] = [];
  let at = -1;
  for (const m of all) if (m.start >= at) { out.push(m); at = m.end; }
  return out;
}

export const placeholderFor = (secret: Buffer, category: PrivacyCategory, value: string) =>
  `{{${TAG[category]}_${crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 8)}}}`;

/**
 * The only parts of a value a record may keep: type, length and a short prefix. Structural prefixes (key markers,
 * PEM header, JWT header) help a person tell which key was hit; PII keeps only its public leading digits; passwords
 * and custom words keep none.
 */
export function recordPrefix(category: PrivacyCategory, value: string): string {
  switch (category) {
    case 'api_key': return value.slice(0, Math.min(6, value.length));
    case 'private_key': return '-----';
    case 'jwt': return 'eyJ';
    case 'id_card': return value.slice(0, 6);
    case 'bank_card': return value.slice(0, Math.min(4, value.replace(/\D/g, '').length));
    case 'phone': return value.slice(0, Math.min(3, value.length));
    default: return '';
  }
}

export interface TextResult { text: string; hits: PrivacyHit[] }

/**
 * One text through the detectors: `redact` hits become placeholders (and land in `map`), `warn` hits stay, `block`
 * hits are only reported — the caller refuses the request.
 */
export function redactText(text: string, c: Compiled, secret: Buffer, map: Map<string, string>): TextResult {
  if (!text || (!c.detectors.length && !c.finders?.length)) return { text, hits: [] };
  const ms = find(text, c);
  if (!ms.length) return { text, hits: [] };
  const hits: PrivacyHit[] = [];
  let out = '';
  let at = 0;
  for (const m of ms) {
    const action = c.actions[m.category] as Exclude<PrivacyAction, 'off'>;
    const value = text.slice(m.start, m.end);
    const prefix = recordPrefix(m.category, value);
    const base: PrivacyHit = { category: m.category, action, length: value.length, ...(prefix ? { prefix } : {}) };
    if (action === 'redact') {
      const ph = placeholderFor(secret, m.category, value);
      map.set(ph, value);
      out += text.slice(at, m.start) + ph;
      at = m.end;
      hits.push({ ...base, placeholder: ph });
    } else hits.push(base);
  }
  return { text: out + text.slice(at), hits };
}

/** Placeholders back to their values (`json`: the text is inside a JSON string, so the value goes in escaped). */
export function restoreText(text: string, map: ReadonlyMap<string, string>, json = false): string {
  if (!text.includes('{{')) return text;
  return text.replace(PLACEHOLDER, (ph) => {
    const v = map.get(ph);
    if (v === undefined) return ph;
    return json ? JSON.stringify(v).slice(1, -1) : v;
  });
}

/** For logs, errors and diagnostics: secrets masked by type whatever the settings say (no placeholder, no map). */
const LOG_CATS = new Set<PrivacyCategory>(['api_key', 'private_key', 'jwt', 'password']);
const LOG_DETECTORS = DETECTORS.filter((d) => LOG_CATS.has(d.category));
export function scrubForLog(text: string, extra: Detector[] = []): string {
  if (!text) return text;
  const c: Compiled = { detectors: [...LOG_DETECTORS, ...extra], actions: { api_key: 'redact', private_key: 'redact', jwt: 'redact', password: 'redact', email: 'off', phone: 'off', id_card: 'off', bank_card: 'off', name: 'off', address: 'off', custom: 'redact' }, allow: new Set(), bad: [] };
  const ms = find(text, c);
  if (!ms.length) return text;
  let out = '';
  let at = 0;
  for (const m of ms) { out += `${text.slice(at, m.start)}[${TAG[m.category]}]`; at = m.end; }
  return out + text.slice(at);
}
