// 值班 Bot: secrets in a call, masked before the approval card shows it. The server's audit masks with redact()
// (server/src/bots/policy/classify.ts); this is that same set, verbatim (quoted header values included) — mask.test.ts
// checks it against the server's on a corpus. Change one, change the other.

const Q = String.raw`(?:'[^'\n]{0,256}'|"[^"\n]{0,256}"|[^\s'"]+)`; // a shell word's value, quoted (spaces and all) or bare

/** A header named in quotes with a quoted value: `"Authorization": "Basic …"`, `'Cookie': '…'`, `\"X-Api-Key\": \"…\"`, a bare `"auth"` key. */
const QUOTED_HEADER = /(\\?["'])(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie|auth)\1(\s*[:=]\s*)(\\?["'])((?:(?!\4)[^\n])*)\4/gi;

/** The server's redact(), verbatim. */
export function redactLikeServer(s: string): string {
  return s
    .replace(QUOTED_HEADER, '$1$2$1$3$4[redacted]$4')
    .replace(/\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)(\s*[:=]\s*)[^'"\n]+/gi, '$1$2[redacted]')
    .replace(/\bbearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(new RegExp(String.raw`(\s(?:-u|--user|--proxy-user)(?:\s+|=))${Q}`, 'g'), '$1[redacted]')
    .replace(/(\/\/)[^\s/@'":]+:[^\s/@'"]+@/g, '$1[redacted]@')
    .replace(new RegExp(String.raw`(\bmysql(?:dump|admin|sh)?\b[^;&|\n]{0,200}?\s)-p(?=[^\s-])${Q}`, 'g'), '$1-p[redacted]')
    .replace(new RegExp(String.raw`(\bsshpass\b[^;&|\n]{0,64}?\s-p)(\s*)${Q}`, 'g'), '$1$2[redacted]')
    .replace(new RegExp(String.raw`(^|\s)(--?[\w-]{0,32}?(?:token|password|passwd|secret|api-?key|credential)[\w-]{0,32})(\s+)(?!-)${Q}`, 'gi'), '$1$2$3[redacted]')
    .replace(/([?&;:\s"'{,$]|^)([\w-]*(?:token|secret|password|passwd|pwd|key|signature|credential)[\w-]*)(["']?\s*[=:]\s*)("[^"]{0,256}"|'[^']{0,256}'|[^&\s'",}]+)/gi, '$1$2$3[redacted]')
    .replace(/\b(sk|rk|pk)-[\w-]{8,}/g, '$1-[redacted]')
    .replace(/\b(ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abprs])[-_][\w-]{8,}/g, '$1_[redacted]');
}

/** What the approval card shows: exactly the server's masking. */
export const maskSecrets = redactLikeServer;
