// 值班 Bot: secrets in a call, masked before the approval card shows it. The server's audit masks with redact()
// (server/src/bots/policy/classify.ts); this is that same set, verbatim — mask.test.ts checks it against the server's
// on a corpus — plus quoted header values ("Authorization": "Basic …", "Cookie": "…" in a JSON body / MCP params),
// which the server set leaves. Change one, change the other.

const Q = String.raw`(?:'[^'\n]{0,256}'|"[^"\n]{0,256}"|[^\s'"]+)`; // a shell word's value, quoted (spaces and all) or bare

/** The server's redact(), verbatim. */
export function redactLikeServer(s: string): string {
  return s
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

/** A header named in quotes with a quoted value: `"Authorization": "Basic …"`, `'Cookie': '…'`, `\"X-Api-Key\": \"…\"`. */
const QUOTED_HEADER = /(\\?["'])(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\1(\s*[:=]\s*)(\\?["'])((?:(?!\4)[^\n])*)\4/gi;

/** What the approval card shows: the server's masking, and quoted header values too. */
export function maskSecrets(s: string): string {
  return redactLikeServer(s.replace(QUOTED_HEADER, '$1$2$1$3$4[redacted]$4'));
}
