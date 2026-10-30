// server/src/bots/policy/classify.ts
import type { ActionClass } from '../../protocol.js';
import type { Target } from './rules.js';

/**
 * The gate runs synchronously on the server's event loop, so every scan here is linear: no regex with nested or
 * overlapping unbounded quantifiers runs over text from a call, and no single string is scanned past CAP. What the
 * gate can't read precisely — a destination, a body, an expansion, a string past CAP — counts as going somewhere: it
 * asks.
 */
const CAP = 8192;
const MAX_DEPTH = 32; // ( $( ` nesting in one command; deeper = can't read it
const MAX_NEST = 3; // command strings inside command strings (bash -c "…", powershell -Command "…")
const MAX_SHIFT = 8; // known command words read past the first word of one simple command

/** Harness / meta tools and plain reads: they never leave the machine on their own (sub-agents' own calls pass the gate). */
const READ_TOOLS = new Set([
  'Read', 'NotebookRead', 'LS', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'SearchExtraTools', 'ToolSearch', 'ExitPlanMode',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'KillShell', 'BashOutput',
]);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** When a call matches several classes, the first one here wins. */
const RANK: ActionClass[] = ['pay', 'delete', 'send', 'install', 'browser', 'write_local', 'read'];

const PAY_HOST = /(^|\.)(stripe|paypal|alipay)\.com$|^(checkout|pay|payments?)\./i;
const PAY_PATH = /(^|\/)(pay|checkout)(\/|$)/i;

const innerName = (toolName: string, input: Record<string, unknown>) => toolName === 'ExecuteExtraTool' && typeof input.tool_name === 'string' ? input.tool_name : toolName;
const innerParams = (toolName: string, input: Record<string, unknown>) => (toolName === 'ExecuteExtraTool' && input.params && typeof input.params === 'object' ? input.params : input) as Record<string, unknown>;
const capped = (s: string) => s.length > CAP ? s.slice(0, CAP) : s;

// ---- URLs ----

const URL_END = new Set([' ', '\t', '\n', '\r', "'", '"', '<', '>', '`']);
const TRAIL = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);
const SCHEME_CH = /[a-z0-9+.-]/i;

/**
 * Every scheme://… in a piece of text (its first CAP chars). http(s) ones are parsed (trailing punctuation stripped);
 * anything we can't read the same way the sending program would — another scheme, a parse failure, userinfo /
 * backslash / percent in the authority — marks the text opaque.
 */
function scanUrls(text0: string): { urls: URL[]; opaque: boolean } {
  const text = capped(text0);
  const urls: URL[] = [];
  let opaque = false;
  let from = 0;
  for (;;) {
    const k = text.indexOf('://', from);
    if (k < 0) break;
    let s = k;
    while (s > 0 && k - s < 32 && SCHEME_CH.test(text[s - 1])) s--;
    while (s < k && !/[a-z]/i.test(text[s])) s++;
    let e = k + 3;
    while (e < text.length && !URL_END.has(text[e])) e++;
    from = e;
    const scheme = text.slice(s, k).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') { opaque = true; continue; }
    let end = e;
    while (end > k + 3 && TRAIL.has(text[end - 1])) end--;
    const url = text.slice(s, end);
    const rest = url.slice(url.indexOf('//') + 2);
    let a = 0;
    while (a < rest.length && rest[a] !== '/' && rest[a] !== '?' && rest[a] !== '#') a++;
    const authority = rest.slice(0, a);
    if (!authority || authority.includes('@') || authority.includes('\\') || authority.includes('%')) opaque = true;
    try { const u = new URL(url); if (u.hostname) urls.push(u); else opaque = true; } catch { opaque = true; }
  }
  return { urls, opaque };
}
const urlsIn = (text: string) => scanUrls(text).urls;
const hostOf = (u: URL) => { let h = u.hostname.toLowerCase(); let e = h.length; while (e > 0 && h[e - 1] === '.') e--; h = h.slice(0, e); return h; };
const isPayUrl = (u: URL) => PAY_HOST.test(hostOf(u)) || PAY_PATH.test(u.pathname);
const isHttp = (s: string) => /^https?:\/\//i.test(s);

// ---- shell: read the command the way the shell does ----

/** A word as the program receives it (quotes removed, escapes applied). dyn: its value isn't in the text — an expansion, a substitution, ANSI-C quoting. */
interface Tok { t: string; dyn: boolean }
/** A simple command with what feeds it: substitution in its words, a pipe into it, a `<` redirect. */
interface PCmd { toks: Tok[]; subst: boolean; piped: boolean; stdin: boolean }

/** `$x`, `${x}`, `$1`, `$@`, PowerShell `$env:x`, `$_`. */
const EXPANDS = /[\w{:?@*#!$-]/;
const SPACE = new Set([' ', '\t', '\r', '\v', '\f']);

/**
 * Parse into simple commands (; & && || | newline, ( ), PowerShell { }), keeping what feeds each one. The commands
 * inside a substitution — bash $(…) / `…` / <(…), PowerShell $(…) / @(…) / (…) as an argument — are entries of their
 * own. Redirections (> f, 2>&1, < f) are dropped from the words. Iterative; nesting past MAX_DEPTH sets overflow.
 * Bash escapes with backslash; PowerShell with backtick (and keeps backslashes: they are path separators).
 */
function parseCommands(src: string, ps: boolean): { cmds: PCmd[]; overflow: boolean } {
  const all: PCmd[] = [];
  const esc = ps ? '`' : '\\';
  let overflow = false;
  interface Frame { stop: string | null; cmd: PCmd; cur: string; has: boolean; dyn: boolean; dq: boolean; drop: boolean }
  const fresh = (piped: boolean): PCmd => { const c = { toks: [], subst: false, piped, stdin: false }; all.push(c); return c; };
  const stack: Frame[] = [{ stop: null, cmd: fresh(false), cur: '', has: false, dyn: false, dq: false, drop: false }];
  let f = stack[0];
  const endTok = () => {
    if (f.has && !f.drop) f.cmd.toks.push({ t: f.cur, dyn: f.dyn || (f.cur.includes('%') && /%[A-Za-z_]\w*%/.test(capped(f.cur))) });
    if (f.has) f.drop = false;
    f.cur = ''; f.has = false; f.dyn = false;
  };
  const endCmd = (piped: boolean) => { endTok(); f.drop = false; if (f.cmd.toks.length) f.cmd = fresh(piped); else f.cmd.piped ||= piped; };
  const open = (stop: string, sub: boolean) => {
    if (sub) { f.cmd.subst = true; f.cur += '$SUB'; f.has = true; f.dyn = true; } else endCmd(false);
    if (stack.length >= MAX_DEPTH) { overflow = true; return; }
    f = { stop, cmd: fresh(false), cur: '', has: false, dyn: false, dq: false, drop: false };
    stack.push(f);
  };
  const close = () => { endCmd(false); stack.pop(); f = stack[stack.length - 1]; };
  // runs of ordinary characters are taken in one step
  const ORD = ps ? /[^\s'"`$@(){}|;&<>]+/y : /[^\s'"\\`$()|;&<>]+/y;
  const DQ_ORD = ps ? /[^"`$]+/y : /[^"\\`$]+/y;
  let i = 0;
  while (i < src.length) {
    const ord = f.dq ? DQ_ORD : ORD;
    ord.lastIndex = i;
    if (ord.test(src)) { const run = src.slice(i, ord.lastIndex); f.cur = f.has ? f.cur + run : run; f.has = true; i = ord.lastIndex; continue; }
    const ch = src[i], nx = src[i + 1];
    if (!f.dq && SPACE.has(ch)) { endTok(); i++; continue; }
    if (f.dq) {
      if (ch === '"') { f.dq = false; i++; continue; }
      if (ch === esc && i + 1 < src.length) { f.cur += nx; i += 2; continue; }
      if (ch === '$' && nx === '(') { i += 2; open(')', true); continue; }
      if (!ps && ch === '`') { i++; open('`', true); continue; }
      if (ch === '$' && nx !== undefined && EXPANDS.test(nx)) f.dyn = true;
      f.cur += ch; i++; continue;
    }
    if (f.stop !== null && ch === f.stop) { i++; close(); continue; }
    if (!ps && ch === '$' && nx === "'") { // ANSI-C $'…': escapes we don't decode
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      f.cur += src.slice(i + 2, Math.min(j, src.length)); f.has = true; f.dyn = true; i = j + 1; continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        const k = src.indexOf("'", j);
        if (k < 0) { f.cur += src.slice(j); j = src.length; break; }
        f.cur += src.slice(j, k);
        if (ps && src[k + 1] === "'") { f.cur += "'"; j = k + 2; continue; }
        j = k; break;
      }
      f.has = true; i = j + 1; continue;
    }
    if (ch === '"') { f.dq = true; f.has = true; i++; continue; }
    if (ch === esc) { if (i + 1 < src.length && nx !== '\n') f.cur += nx; f.has = true; i += 2; continue; }
    if ((ch === '$' || (ps && ch === '@')) && nx === '(') { i += 2; open(')', true); continue; }
    if (ps && ch === '@' && nx === '{') { i += 2; open('}', true); continue; } // a hashtable: its values are expressions
    if (ps && ch === '$' && nx === '{') { const k = src.indexOf('}', i); const e = k < 0 ? src.length : k + 1; f.cur += src.slice(i, e); f.has = true; f.dyn = true; i = e; continue; }
    if (!ps && (ch === '<' || ch === '>') && nx === '(') { i += 2; open(')', true); continue; }
    if (!ps && ch === '`') { i++; open('`', true); continue; }
    if (ch === '>' || (ch === '&' && nx === '>') || (!ps && ch === '<')) { // redirection: drop it and its file word
      if (f.has && /^\d$/.test(f.cur)) { f.cur = ''; f.has = false; f.dyn = false; } else endTok();
      if (ch === '<') { f.cmd.stdin = true; i++; while (src[i] === '<') i++; } else { i += ch === '&' ? 2 : 1; if (src[i] === '>' || src[i] === '|') i++; }
      if (src[i] === '&') { i++; while (i < src.length && /[\d-]/.test(src[i])) i++; continue; }
      f.drop = true; continue;
    }
    if (ch === '$' && nx !== undefined && EXPANDS.test(nx)) f.dyn = true;
    if (ch === '(') { i++; open(')', f.cmd.toks.length > 0 || f.has); continue; }
    if (ch === ')') { i++; endCmd(false); continue; }
    if (ch === '|') { if (nx === '|') { i += 2; endCmd(false); } else { i++; endCmd(true); } continue; }
    if (ch === ';' || ch === '&' || ch === '\n' || (ps && (ch === '{' || ch === '}'))) { i++; endCmd(false); continue; }
    if (SPACE.has(ch)) { endTok(); i++; continue; }
    f.cur += ch; f.has = true; i++;
  }
  while (stack.length > 1) close();
  endTok();
  return { cmds: all.filter((c) => c.toks.length), overflow };
}

/** Words that run the next word as the command (sudo rm …, xargs rm …, env X=1 curl …). */
const PREFIX_WORDS = new Set(['sudo', 'doas', 'exec', 'command', 'builtin', 'env', 'nohup', 'time', 'nice', 'ionice', 'xargs', 'timeout', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', '$', '&', '.']);
/** Options of those prefix words that take a value (so the value isn't mistaken for the command). */
const PREFIX_ARG_OPTS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
};
const base = (t: string) => !/[\\/.]/.test(t) ? t.toLowerCase() : capped(t).replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

interface Cmd { cmd: string; args: Tok[]; env: string[]; at: number }
function commandOf(toks: Tok[]): Cmd | undefined {
  let i = 0;
  const env: string[] = [];
  while (i < toks.length) {
    const t = toks[i].t;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { env.push(t); i++; continue; }
    const w = base(t);
    if (PREFIX_WORDS.has(w)) {
      i++;
      while (i < toks.length && (toks[i].t.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(toks[i].t))) { const o = toks[i++].t; if (PREFIX_ARG_OPTS[w]?.has(o) && i < toks.length) i++; }
      continue;
    }
    break;
  }
  return i < toks.length ? { cmd: base(toks[i].t), args: toks.slice(i + 1), env, at: i } : undefined;
}

/** rm's recursive / force in any spelling: -r, -R, -rf, -r -f, --recursive, --rec, PowerShell -Recurse / -Rec / -Fo. */
function rmFlags(args: string[]): { r: boolean; f: boolean } {
  let r = false, f = false;
  for (const a0 of args) {
    if (a0 === '--') break;
    const a = a0.toLowerCase();
    if (!a.startsWith('-') || a === '-') continue;
    if (a.startsWith('--')) { const n = a.slice(2).split('=')[0]; if (n && 'recursive'.startsWith(n)) r = true; if (n && 'force'.startsWith(n)) f = true; continue; }
    const n = a.slice(1).split(':')[0];
    if (n.length >= 2 && 'recurse'.startsWith(n)) { r = true; continue; }
    if (n.length >= 2 && 'force'.startsWith(n)) { f = true; continue; }
    if (/^[a-z]+$/.test(n)) { if (n.includes('r')) r = true; if (n.includes('f')) f = true; }
  }
  return { r, f };
}
/** Remove-Item and its aliases: -Recurse or any prefix of it (-r, -re, -rec…), cmd's /s. */
const psRecurse = (args: string[]) => args.some((a) => { const l = a.toLowerCase(); if (l === '/s') return true; const n = l.startsWith('-') && !l.startsWith('--') ? l.slice(1).split(':')[0] : ''; return n.length >= 1 && 'recurse'.startsWith(n); });

/** git's subcommand, after global options (-C <path>, -c <k=v>, --git-dir <d>, --no-pager …). */
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
function gitSub(args: Tok[]): { sub?: string; rest: Tok[]; config: string[] } {
  const config: string[] = [];
  let i = 0;
  while (i < args.length && args[i].t.startsWith('-')) {
    const a = args[i].t;
    if (GIT_ARG_OPTS.has(a)) { if (a === '-c' || a === '--config-env') config.push(args[i + 1]?.t ?? ''); i += 2; } else { if (a.startsWith('-c') && a.length > 2) config.push(a.slice(2)); i++; }
  }
  return { sub: args[i]?.t.toLowerCase(), rest: args.slice(i + 1), config };
}
const shortHas = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));

/**
 * An HTTP client's call: method, whether it sends a body, where it goes, its data parts. opaque: it may go somewhere
 * besides dests (a proxy, a config file, a URL list). unread: some body / form / query part isn't a plain literal
 * (a file, an expansion, a value the parser couldn't read) — its amounts can't be known.
 */
interface Http { method?: Tok; body: boolean; readsFile: boolean; dests: Tok[]; opaque: boolean; data: string[]; unread: boolean }
const newHttp = (): Http => ({ body: false, readsFile: false, dests: [], opaque: false, data: [], unread: false });
const addData = (h: Http, v: Tok | undefined, fileRef: boolean) => {
  if (!v || v.dyn || fileRef || v.t.length > CAP) { h.unread = true; if (fileRef) h.readsFile = true; return; }
  h.data.push(v.t);
};

const CURL_SHORT_VALUE = new Set([...'AbcCdDeEFHKmoPQrtTuUwxXyYz']);
const CURL_LONG_VALUE = new Set(['data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'form', 'form-string', 'json', 'header', 'output', 'user', 'user-agent', 'referer',
  'request', 'cookie', 'cookie-jar', 'upload-file', 'write-out', 'config', 'proxy', 'proxy-user', 'preproxy', 'cert', 'key', 'cacert', 'capath', 'max-time', 'connect-timeout', 'range',
  'retry', 'retry-delay', 'retry-max-time', 'resolve', 'connect-to', 'url', 'output-dir', 'limit-rate', 'interface', 'dns-servers', 'doh-url', 'socks4', 'socks4a', 'socks5',
  'socks5-hostname', 'oauth2-bearer', 'aws-sigv4', 'unix-socket', 'abstract-unix-socket', 'request-target', 'variable', 'dump-header', 'continue-at', 'max-filesize', 'expect100-timeout',
  'url-query', 'trace', 'trace-ascii', 'stderr', 'netrc-file', 'hsts', 'alt-svc', 'ciphers', 'pinnedpubkey', 'local-port', 'happy-eyeballs-timeout-ms']);
const CURL_REDIRECT = /^(proxy|preproxy|proxy1\.0|socks.*|resolve|connect-to|unix-socket|abstract-unix-socket|config|doh-url|netrc-file)$/;
function curlParse(args: Tok[]): Http {
  const h = newHttp();
  for (let i = 0; i < args.length; i++) {
    const a = args[i].t;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const n = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      const takes = CURL_LONG_VALUE.has(n) || n.startsWith('expand-');
      const val: Tok | undefined = eq >= 0 ? { t: a.slice(eq + 1), dyn: args[i].dyn } : takes ? args[++i] : undefined;
      if (n === 'request') h.method = val ?? { t: '', dyn: true };
      if (CURL_REDIRECT.test(n)) h.opaque = true;
      if (n === 'url') { if (val) h.dests.push(val); else h.opaque = true; }
      if (n === 'upload-file') { h.body = true; addData(h, val, true); }
      const form = /^(expand-)?form/.test(n);
      if (/^(expand-)?(data|form|json)/.test(n)) { h.body = true; addData(h, val, val !== undefined && (form ? /=[@<]/.test(val.t) || val.t.startsWith('@') : val.t.startsWith('@'))); }
      if (n === 'url-query' || n === 'variable' || n === 'expand-url') addData(h, val, val !== undefined && val.t.includes('@'));
      continue;
    }
    if (/^-[a-zA-Z:]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'x' || ch === 'K') h.opaque = true;
        if (CURL_SHORT_VALUE.has(ch)) {
          const val: Tok | undefined = j + 1 < a.length ? { t: a.slice(j + 1), dyn: args[i].dyn } : args[++i];
          if (ch === 'X') h.method = val ?? { t: '', dyn: true };
          if (ch === 'd') { h.body = true; addData(h, val, val !== undefined && val.t.startsWith('@')); }
          if (ch === 'F') { h.body = true; addData(h, val, val !== undefined && (/=[@<]/.test(val.t) || val.t.startsWith('@'))); }
          if (ch === 'T') { h.body = true; addData(h, val, true); }
          break;
        }
      }
      continue;
    }
    h.dests.push(args[i]);
  }
  return h;
}
const WGET_SHORT_VALUE = new Set([...'oaOePUtTwQiBDIXlAR']);
const WGET_LONG_VALUE = new Set(['header', 'post-data', 'post-file', 'body-data', 'body-file', 'method', 'user', 'password', 'output-document', 'output-file', 'append-output', 'directory-prefix',
  'user-agent', 'tries', 'timeout', 'wait', 'input-file', 'execute', 'base', 'referer', 'load-cookies', 'save-cookies', 'config']);
function wgetParse(args: Tok[]): Http {
  const h = newHttp();
  for (let i = 0; i < args.length; i++) {
    const a = args[i].t;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const n = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      const val: Tok | undefined = eq >= 0 ? { t: a.slice(eq + 1), dyn: args[i].dyn } : WGET_LONG_VALUE.has(n) ? args[++i] : undefined;
      if (n === 'method') h.method = val ?? { t: '', dyn: true };
      if (n === 'post-data' || n === 'body-data') { h.body = true; addData(h, val, false); }
      if (n === 'post-file' || n === 'body-file') { h.body = true; addData(h, val, true); }
      if (/^(input-file|execute|base|config)$/.test(n)) { h.opaque = true; h.readsFile = true; }
      continue;
    }
    if (/^-[a-zA-Z]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if ('ieB'.includes(ch)) { h.opaque = true; h.readsFile = true; }
        if (WGET_SHORT_VALUE.has(ch)) { if (j + 1 >= a.length) i++; break; }
      }
      continue;
    }
    h.dests.push(args[i]);
  }
  return h;
}
/** Invoke-WebRequest / Invoke-RestMethod: parameters may be any unambiguous prefix and take `-Name:value`. */
const PS_WEB = new Set(['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm']);
const PS_SWITCHES = ['usebasicparsing', 'usedefaultcredentials', 'skipcertificatecheck', 'skipheadervalidation', 'skiphttperrorcheck', 'passthru', 'disablekeepalive',
  'allowunencryptedauthentication', 'allowinsecureredirect', 'proxyusedefaultcredentials', 'resume', 'nobody'];
function psWebParse(args: Tok[]): Http {
  const h = newHttp();
  for (let i = 0; i < args.length; i++) {
    const a = args[i].t;
    if (a.startsWith('@')) { h.opaque = true; h.body = true; h.unread = true; continue; } // splatted parameters: can't see them
    if (/^-[a-zA-Z]/.test(a)) {
      const colon = a.indexOf(':');
      const n = (colon < 0 ? a.slice(1) : a.slice(1, colon)).toLowerCase();
      const is = (full: string) => full.startsWith(n);
      const isValue = ['method', 'custommethod', 'body', 'infile', 'form', 'uri', 'proxy'].some(is);
      if (!isValue && PS_SWITCHES.some(is)) continue;
      const val: Tok | undefined = colon >= 0 ? { t: a.slice(colon + 1), dyn: args[i].dyn } : args[++i];
      if (is('method') || is('custommethod')) h.method = val ?? { t: '', dyn: true };
      else if (is('body') || is('form')) { h.body = true; addData(h, val, false); }
      else if (is('infile')) { h.body = true; addData(h, val, true); }
      else if (is('uri')) { if (val) h.dests.push(val); else h.opaque = true; }
      else if (is('proxy')) h.opaque = true;
      continue;
    }
    h.dests.push(args[i]);
  }
  return h;
}
/** httpie / xh: an explicit non-GET method, or request items that make a body (k=v, k:=v, k@file). */
const HTTPIE = new Set(['http', 'https', 'httpie', 'xh', 'xhs']);
function httpieParse(args: Tok[]): Http {
  const h = newHttp();
  const pos = args.filter((a) => !a.t.startsWith('-'));
  let k = 0;
  if (pos[0] && /^[A-Z]+$/.test(pos[0].t)) h.method = pos[k++];
  if (pos[k]) h.dests.push(pos[k++]);
  for (const it of pos.slice(k)) {
    if (/^[^=:@/]*@/.test(it.t) || /:=@|=@/.test(it.t)) { h.body = true; addData(h, it, true); continue; }
    if (/^[^=:@/]+(:=|=(?!=))/.test(it.t)) { h.body = true; addData(h, it, false); continue; }
    if (it.dyn) h.unread = true;
  }
  return h;
}
const methodClass = (m: Tok | undefined): ActionClass | undefined => {
  if (m === undefined) return undefined;
  if (m.dyn) return 'send';
  const u = m.t.toUpperCase();
  if (u === 'DELETE') return 'delete';
  return ['GET', 'HEAD', 'OPTIONS', 'DEFAULT', ''].includes(u) ? undefined : 'send';
};
function httpOf(c: Cmd): Http | undefined {
  if (c.cmd === 'curl') return curlParse(c.args);
  if (c.cmd === 'wget') return wgetParse(c.args);
  if (PS_WEB.has(c.cmd)) return psWebParse(c.args);
  if (HTTPIE.has(c.cmd)) return httpieParse(c.args);
  return undefined;
}

/** Always outward, to a destination we don't extract. */
const SEND_WORDS = new Set(['ssh', 'scp', 'sftp', 'mosh', 'mail', 'mailx', 'sendmail', 'mutt', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'ftp', 'tftp', 'send-mailmessage']);
/** Talk to the network: anything fed into them, or an expansion / substitution in their words (DNS exfil included), is a send. */
const NET_TOOLS = new Set(['curl', 'wget', 'aria2c', ...PS_WEB, ...HTTPIE, 'nslookup', 'dig', 'host', 'drill', 'ping', 'ping6', 'traceroute', 'tracert', 'resolve-dnsname',
  'test-netconnection', 'tnc', 'test-connection', 'start-bitstransfer', 'gh', 'glab']);
const REMOVE_WORDS = new Set(['remove-item', 'ri', 'rd', 'rmdir', 'del', 'erase']);
const GIT_NET = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote', 'remote', 'submodule', 'archive']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'busybox', 'wsl', 'cmd', 'eval', 'su', 'powershell', 'pwsh', 'invoke-expression', 'iex', 'source', 'start-process', 'start']);
/** Text tools whose positional words are data, not subcommands. */
const TEXT_TOOLS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'jq', 'yq', 'cat', 'less', 'more', 'head', 'tail', 'find', 'ls', 'dir', 'cd',
  'pushd', 'popd', 'mkdir', 'touch', 'cp', 'mv', 'which', 'where', 'type', 'man', 'help', 'test', '[', 'select-string', 'sls', 'write-output', 'write-host', 'wc', 'sort', 'uniq',
  'tee', 'diff', 'git', 'gh', 'glab', 'rm', 'set-location', 'get-content', 'gc', 'get-childitem', 'gci', 'new-item', 'ni', 'copy-item', 'move-item', 'code', 'touch', 'tr', 'cut']);
const PUBLISH_WORDS = new Set(['publish', 'push', 'upload', 'deploy', 'release', 'send']);
const GH_LOCAL_NOUNS = new Set(['help', 'version', 'completion', 'config', 'alias', 'auth', 'browse', 'search', 'status']);
const GH_READ_VERBS = new Set(['list', 'ls', 'view', 'status', 'diff', 'checks', 'watch', 'download', 'checkout', 'co', 'clone', 'verify', 'token', 'help']);
const INSTALLERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'python', 'python3', 'py', 'uv', 'pipx', 'cargo', 'go', 'brew', 'winget', 'choco', 'scoop', 'apt', 'apt-get', 'claude', 'npx']);
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'vsce', 'ovsx', 'twine', 'gem', 'docker', 'podman', 'dotnet']);
/** Command words also looked for past the first word of a command — where the first word may not be what runs. */
const KNOWN = new Set(['rm', ...REMOVE_WORDS, 'find', 'git', 'gh', 'glab', 'curl', 'wget', ...PS_WEB, 'rsync', 'send-mailmessage', ...INSTALLERS, ...PUBLISHERS, 'powershell', 'pwsh']);
/** .NET network calls from PowerShell. */
const DOTNET_SEND = /\.upload(file|string|data|values)|net\.webclient|httpclient|net\.sockets|webrequest\]::|\.(post|put|patch|send)async/i;
/** Characters without which a word holds no URL, user@host:, .NET call or command string. */
const INTERESTING = /[:@.\]\s;&|`$(]/;
const remoteArg = (a: string) => /^[^\s/\\:]{2,}:/.test(a) || /^[a-z][a-z0-9+.-]*:\/\//i.test(a); // host:path, user@host:path, rsync://…

/** One command's reading. outward: it leaves the machine; precise: every place it goes was extracted. */
interface Seen { cls: ActionClass[]; outward: boolean; imprecise: boolean; httpPrecise?: boolean; data: string[]; unread: boolean }

/** The classes of one command (cmd + args), from its words. fed: substitution / pipe / `<` into it. */
function commandClasses(c: Cmd, fed: boolean, first: boolean, s: Seen): void {
  const { cmd, args } = c;
  // read lazily: most commands need none of this, and a command may have 100k words
  let a_: string[] | undefined;
  const A = () => (a_ ??= args.map((t) => t.t));
  const dynIn = () => args.some((t) => t.dyn);
  const send = (k: ActionClass = 'send') => { s.cls.push(k); s.outward = true; s.imprecise = true; };
  /** The first two positional words (before `--`), lower case. */
  const pos: string[] = [];
  for (const t of args) { if (t.t === '--' || pos.length === 2) break; if (!t.t.startsWith('-')) pos.push(t.t.toLowerCase()); }
  if (cmd === 'rm' && rmFlags(A()).r) s.cls.push('delete');
  if (REMOVE_WORDS.has(cmd) && psRecurse(A())) s.cls.push('delete');
  if (cmd === 'find') {
    if (A().includes('-delete')) s.cls.push('delete');
    A().forEach((x, i) => { if (/^-(exec|execdir|ok|okdir)$/.test(x) && ['rm', 'rmdir', 'unlink', 'shred', 'remove-item'].includes(base(A()[i + 1] ?? ''))) s.cls.push('delete'); });
  }
  if (cmd === 'git') {
    const { sub, rest, config } = gitSub(args);
    const r = rest.map((t) => t.t);
    if (config.some((v) => /^alias\./i.test(v))) send(); // an inline alias can run anything
    if (sub === 'push') {
      const del = r.includes('--delete') || r.includes('--mirror') || r.includes('--prune') || shortHas(r, 'd') || r.some((x) => /^\+?:/.test(x));
      s.cls.push(del ? 'delete' : 'send'); s.outward = true;
      const repo = rest.find((t) => !t.t.startsWith('-'));
      if (!repo || repo.dyn || !isHttp(repo.t) || r.some((x) => x.startsWith('--repo'))) s.imprecise = true; // a named / implicit remote: its URL isn't in the call
    }
    if (sub === 'send-email' || sub === 'request-pull' || sub === 'imap-send') send();
    if (sub && GIT_NET.has(sub) && (dynIn() || fed)) send();
    if (sub === 'branch' && (shortHas(r, 'D') || ((r.includes('--delete') || shortHas(r, 'd')) && (r.includes('--force') || shortHas(r, 'f'))))) s.cls.push('delete');
    if (sub === 'clean' && (r.includes('--force') || shortHas(r, 'f'))) s.cls.push('delete');
  }
  if (cmd === 'gh' || cmd === 'glab') {
    const [noun, verb] = pos;
    if (noun === 'api') {
      for (let i = 0; i < A().length; i++) {
        const x = A()[i];
        const m = x === '-X' || x === '--method' ? args[i + 1] : /^--method=/.test(x) ? { t: x.slice(9), dyn: args[i].dyn } : /^-X./.test(x) ? { t: x.slice(2), dyn: args[i].dyn } : undefined;
        const k = methodClass(m);
        if (k) send(k);
        if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x)) send();
      }
    } else if (noun !== undefined && verb !== undefined) {
      if (verb === 'delete') send('delete');
      else if (!GH_LOCAL_NOUNS.has(noun) && !GH_READ_VERBS.has(verb)) send();
    }
  }
  const h = httpOf(c);
  if (h) {
    const k = methodClass(h.method);
    if (k) s.cls.push(k);
    if (h.body || h.readsFile) s.cls.push('send');
    if (k || h.body || h.readsFile) s.outward = true;
    const precise = !h.opaque && h.dests.length > 0 && h.dests.every((d) => !d.dyn && isHttp(d.t) && d.t.length <= CAP);
    s.httpPrecise = (s.httpPrecise ?? true) && precise;
    s.data.push(...h.data);
    for (const d of h.dests) if (!d.dyn && d.t.length <= CAP) s.data.push(d.t);
    if (h.unread) s.unread = true;
  }
  if (NET_TOOLS.has(cmd) && (fed || dynIn() || args.some((t) => t.t.length > CAP))) send();
  if (cmd === 'openssl' && pos[0] === 's_client') send();
  if (cmd === 'aria2c' && A().some((x) => /^(-i|--input-file)/.test(x))) send();
  if (cmd === 'start-bitstransfer' && A().some((x) => /^upload/i.test(x))) send();
  if (SEND_WORDS.has(cmd) && first) send();
  if (cmd === 'rsync' && A().some((x) => !x.startsWith('-') && remoteArg(x))) send();
  if ((cmd === 'powershell' || cmd === 'pwsh') && A().some((x) => /^-(e|ec|en|enc\w*)$/i.test(x))) send(); // -EncodedCommand: can't read it
  if (SHELLS.has(cmd) && (fed || dynIn() || args.some((t) => t.t.length > CAP))) send(); // code we can't see
  // a CLI's publish / push / upload / deploy subcommand (npm publish, docker push, twine upload, yarn npm publish…)
  if ((first || PUBLISHERS.has(cmd)) && !TEXT_TOOLS.has(cmd)) {
    const sub = pos.slice(0, 2);
    if (sub.includes('unpublish')) send('delete');
    else if (sub.some((x) => PUBLISH_WORDS.has(x))) send();
  }
  // install
  const [p0, p1] = pos;
  if ((['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && ['i', 'install', 'add'].includes(p0) && A().some((x) => x === '-g' || x === '--global' || x === '--location=global'))
    || (cmd === 'yarn' && p0 === 'global' && p1 === 'add')
    || (['pip', 'pip3', 'pipx', 'cargo', 'go', 'brew', 'winget', 'choco', 'scoop', 'apt', 'apt-get'].includes(cmd) && p0 === 'install')
    || (['python', 'python3', 'py'].includes(cmd) && A()[A().indexOf('-m') + 1] === 'pip' && A().includes('-m') && A().includes('install'))
    || (cmd === 'uv' && p0 === 'tool' && p1 === 'install')
    || (cmd === 'claude' && p0 === 'plugin' && p1 === 'install')
    || (cmd === 'npx' && p0 === 'skills' && p1 === 'add'))
    s.cls.push('install');
}

/** What a whole shell command does and where it goes. */
interface Shell { found: Set<ActionClass>; hosts: string[]; opaque: boolean; data: string[]; unread: boolean; long: boolean }

function walkShell(src: string, ps: boolean, nest: number, acc: Shell): void {
  const { cmds, overflow } = parseCommands(src, ps);
  if (overflow) { acc.found.add('send'); acc.opaque = true; }
  for (const pc of cmds) {
    const fed = pc.subst || pc.piped || pc.stdin;
    const s: Seen = { cls: [], outward: false, imprecise: false, data: [], unread: false };
    const c = commandOf(pc.toks);
    if (c) {
      commandClasses(c, fed, true, s);
      if (c.env.some((e) => /proxy|git_ssh|git_config|curl_home|wgetrc/i.test(e.split('=')[0]))) acc.opaque = true;
      if (c.cmd === 'git' && gitSub(c.args).config.some((v) => /proxy|insteadof|sshcommand|askpass/i.test(v))) acc.opaque = true;
      // the first word may not be what runs (`foo curl -d @x …`): read up to MAX_SHIFT known command words past it
      // (each reads the words up to the next known word, so the whole command is read at most twice)
      const at: number[] = [];
      for (let i = c.at + 1; i < pc.toks.length && at.length <= MAX_SHIFT; i++) if (pc.toks[i].t.length < 300 && KNOWN.has(base(pc.toks[i].t))) at.push(i);
      if (at.length > MAX_SHIFT) { s.cls.push('send'); s.outward = true; s.imprecise = true; at.length = MAX_SHIFT; }
      at.forEach((i, n) => commandClasses({ cmd: base(pc.toks[i].t), args: pc.toks.slice(i + 1, at[n + 1] ?? pc.toks.length), env: [], at: i }, fed, false, s));
    }
    const childPs = c && (c.cmd === 'powershell' || c.cmd === 'pwsh') ? true : c && SHELLS.has(c.cmd) && c.cmd !== 'iex' && c.cmd !== 'invoke-expression' ? false : ps;
    for (const tok of pc.toks) {
      const t = tok.t;
      if (t.length > CAP) acc.long = true;
      if (!INTERESTING.test(t)) continue; // a plain word: no URL, address, .NET call or command string in it
      if (t.includes('://')) {
        const u = scanUrls(t);
        acc.hosts.push(...u.urls.map(hostOf));
        if (u.opaque) acc.opaque = true;
        if (u.urls.some(isPayUrl)) s.cls.push('pay');
      }
      if (t.includes('@') && /^[\w.+-]+@[\w.-]+:/.test(t)) acc.opaque = true;
      if ((t.includes('.') || t.includes(']')) && DOTNET_SEND.test(capped(t))) { s.cls.push('send'); s.outward = true; s.imprecise = true; }
      // a command string inside a word (bash -c "…", powershell -Command "…", a quoted script): read it too
      if (nest < MAX_NEST && t.length <= CAP && /[\s;&|`$(]/.test(t) && tok !== pc.toks[c?.at ?? -1]) walkShell(t, childPs, nest + 1, acc);
    }
    for (const k of s.cls) acc.found.add(k);
    const goes = s.outward || s.cls.includes('send') || s.cls.includes('pay');
    if (goes) {
      // every place it goes must have been read: an http(s) URL literal, or a git push to one
      if (s.imprecise || s.httpPrecise === false || (!s.outward && s.httpPrecise === undefined)) acc.opaque = true;
      acc.data.push(...s.data);
      if (s.unread) acc.unread = true;
    }
  }
}

let memo: { src: string; ps: boolean; out: Shell } | undefined;
function readShell(src: string, ps: boolean): Shell {
  if (memo && memo.src === src && memo.ps === ps) return memo.out;
  const out: Shell = { found: new Set(), hosts: [], opaque: false, data: [], unread: false, long: false };
  walkShell(src, ps, 0, out);
  memo = { src, ps, out };
  return out;
}

function classifyCommand(cmd: string, ps: boolean): ActionClass {
  const found = readShell(cmd, ps).found;
  return RANK.find((k) => found.has(k)) ?? 'write_local';
}

// ---- named tools ----

const DELETE_NAME = /delete|remove|destroy|purge|trash|unpublish|wipe|erase/i;
const PAY_NAME = /checkout|purchase|payment|transfer|refund|charge|(^|_)(pay|order|buy)(s?_|s?$)/i;
const READ_FIRST = new Set(['search', 'list', 'get', 'read', 'fetch', 'find']);
/** Words that join two actions: get_and_email, read_or_create. */
const CONJ = new Set(['and', 'or', 'then', 'plus', 'also', 'n']);
/** Any of these after the first word of an MCP tool's name and it does more than read. */
const ACTION_WORDS = new Set(['send', 'post', 'reply', 'forward', 'create', 'update', 'write', 'publish', 'share', 'invite', 'upload', 'submit', 'set', 'put', 'add', 'edit', 'modify',
  'move', 'merge', 'close', 'approve', 'run', 'exec', 'execute', 'call', 'invoke', 'trigger', 'mark', 'archive', 'unarchive', 'cancel', 'replace', 'kick', 'label', 'unlabel', 'star',
  'unstar', 'remove', 'delete', 'pin', 'unpin', 'react', 'assign', 'unassign', 'ban', 'unban', 'mute', 'unmute', 'block', 'unblock', 'rename', 'copy', 'apply', 'commit', 'push',
  'import', 'sync', 'start', 'stop', 'restart', 'deploy', 'accept', 'reject', 'decline', 'schedule', 'subscribe', 'unsubscribe', 'follow', 'unfollow', 'like', 'vote', 'enable',
  'disable', 'grant', 'revoke', 'lock', 'unlock', 'transfer', 'pay', 'save', 'store', 'insert', 'upsert', 'patch', 'reset', 'clear', 'mutate', 'notify', 'broadcast', 'dispatch',
  'snooze', 'resolve', 'reopen', 'join', 'leave', 'email', 'mail', 'sendmail', 'respond', 'message', 'msg', 'dm', 'text', 'sms', 'tweet', 'retweet', 'toot', 'comment', 'kill',
  'drop', 'destroy', 'purge', 'wipe', 'erase', 'trash', 'spawn', 'launch', 'ping', 'alert', 'page', 'remind', 'nudge', 'tag', 'flag', 'report', 'sign', 'order', 'buy', 'book',
  'charge', 'refund', 'spend', 'bid', 'withdraw', 'deposit', 'order', 'reserve', 'register', 'signup', 'login', 'logout', 'export', 'print', 'fax', 'notify', 'escalate', 'upvote',
  'downvote', 'install', 'uninstall', 'build', 'release', 'rollback', 'revert', 'scale', 'terminate', 'shutdown', 'reboot', 'suspend', 'resume', 'transition', 'convert', 'generate']);
/** camelCase → snake_case, lower: `sendMessage` → `send_message`. */
const words = (s: string) => s.slice(0, 256).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Which class of action a tool call is — the policy is written per class. Unknown tools are 'send': the side that asks. */
export function classify(toolName: string, input: Record<string, unknown>): ActionClass {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write_local';
  if (name === 'Bash' || name === 'PowerShell') return classifyCommand(String(p.command ?? ''), name === 'PowerShell');
  if (/^web\.(search|read)$|^memory\.(search|reflect)$/.test(name)) return 'read';
  if (/^memory\.write$|^sessions\./.test(name)) return 'write_local';
  const w = words(name);
  if (DELETE_NAME.test(w)) return 'delete';
  if (PAY_NAME.test(w) || urlsIn(String(p.url ?? '')).some(isPayUrl)) return 'pay';
  if (/^(ego_browser|browser_|web\.browser|computer[._])/.test(name) || /^mcp__(web|computer)__/.test(name)) return 'browser';
  if (/install/i.test(name)) return 'install';
  if (name.startsWith('mcp__')) {
    // a read only when that's all it does: the tool part starts with a read verb, and no later word is a verb or joins another action
    const parts = w.slice(w.lastIndexOf('__') + 2).split(/[_\-.]+/).filter(Boolean);
    const rest = parts.slice(1);
    if (READ_FIRST.has(parts[0]) && !rest.some((x) => READ_FIRST.has(x) || ACTION_WORDS.has(x) || CONJ.has(x))) return 'read';
  }
  return 'send';
}

const Q = String.raw`(?:'[^'\n]{0,256}'|"[^"\n]{0,256}"|[^\s'"]+)`; // a shell word's value, quoted (spaces and all) or bare
/** Secrets never reach the audit: auth headers, bearer tokens, -u user:pass, URL userinfo, *_KEY / *_TOKEN / *_SECRET values, --token / --password v, mysql -p…, sshpass -p, sk- / ghp_ keys. */
export function redact(s: string): string {
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

export function summarize(toolName: string, input: Record<string, unknown>): string {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  const key = typeof p.command === 'string' ? p.command : typeof p.file_path === 'string' ? p.file_path : typeof p.url === 'string' ? p.url : typeof p.channel === 'string' ? p.channel : JSON.stringify(p);
  return `${name}: ${redact(String(key).slice(0, 4000))}`.replace(/\s+/g, ' ').slice(0, 160);
}

/** Strings from a param that may be a string ("a@x, b@y") or a list. */
function strs(...vals: unknown[]): string[] {
  const out: string[] = [];
  for (const v of vals) {
    const items = Array.isArray(v) ? v : [v];
    for (const it of items) if (typeof it === 'string') out.push(...capped(it).split(/[,;]/).map((x) => x.trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

// ---- amounts ----

const PLAIN = /^\d+(\.\d+)?$/;
const KEY_CH = /[\w.[\]-]/;
const VAL_END = new Set([' ', '\t', '\n', '\r', '&', "'", '"', ',', ';', '}', ']']);
/** `…amount…=v` / `"…amount…": v` in a text (its first CAP chars): a plain non-negative decimal, else unknown. Linear: every step past an `amount` is bounded. */
function scanAmounts(text: string, push: (n: number) => void, bad: () => void): void {
  const l = text.toLowerCase();
  let from = 0;
  for (;;) {
    const k = l.indexOf('amount', from);
    if (k < 0) return;
    from = k + 6;
    let j = k + 6;
    for (let n = 0; j < l.length && n < 64 && KEY_CH.test(l[j]); n++) j++;
    if (l[j] === '"' || l[j] === "'") j++;
    for (let n = 0; n < 16 && (l[j] === ' ' || l[j] === '\t'); n++) j++;
    if (l[j] !== '=' && l[j] !== ':') continue;
    j++;
    for (let n = 0; n < 16 && (l[j] === ' ' || l[j] === '\t'); n++) j++;
    if (l[j] === '"' || l[j] === "'") j++;
    let v = '';
    while (j < l.length && v.length <= 64 && !VAL_END.has(l[j])) v += l[j++];
    if (PLAIN.test(v)) push(Number(v)); else bad();
  }
}
function textVariants(s: string): string[] {
  const out = [s];
  if (s.includes('\\u')) out.push(s.replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))));
  if (s.includes('%')) { try { out.push(decodeURIComponent(s)); } catch { /* not encoded */ } }
  return out;
}

/** Every amount in the call. A value under an amount key that isn't a plain non-negative decimal makes the amount unknown. */
function amountsOf(p: Record<string, unknown> | undefined, texts: string[]): { amounts: number[]; unknown: boolean; long: boolean } {
  const amounts: number[] = [];
  let unknown = false, long = false;
  const scan = (s: string) => {
    if (s.length > CAP) long = true;
    for (const v of textVariants(capped(s))) scanAmounts(v, (n) => amounts.push(n), () => { unknown = true; });
  };
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 8) return;
    if (/amount/i.test(key.slice(0, 256))) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) amounts.push(v);
      else if (typeof v === 'string' && PLAIN.test(v.trim().slice(0, 64))) amounts.push(Number(v.trim()));
      else if (v !== undefined && v !== null) unknown = true;
      return;
    }
    if (typeof v === 'string') scan(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, '', depth + 1));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  if (p) walk(p, '', 0);
  texts.forEach(scan);
  return { amounts, unknown, long };
}

/** What the scope rules match on: EVERY host the call touches, every channel / recipient, the LARGEST amount — and whether any of it couldn't be read. */
export function targetOf(cls: ActionClass, toolName: string, input: Record<string, unknown>): Target {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  if (WRITE_TOOLS.has(name)) return {}; // local file edits: their content is never scanned
  const out: Target = {};
  const hosts: string[] = [];
  let opaque = false, long = false;
  const shell = (name === 'Bash' || name === 'PowerShell') && typeof p.command === 'string';
  let a: { amounts: number[]; unknown: boolean; long: boolean };
  if (shell) {
    const sh = readShell(p.command as string, name === 'PowerShell');
    hosts.push(...sh.hosts);
    opaque = sh.opaque; long = sh.long;
    a = amountsOf(undefined, sh.data); // only the data parts of commands that go out
    if (sh.unread) a.unknown = true;
  } else {
    a = amountsOf(READ_TOOLS.has(name) ? undefined : p, []);
  }
  for (const t of [shell ? undefined : p.command, p.url, p.uri]) {
    if (typeof t !== 'string') continue;
    if (t.length > CAP) long = true;
    const s = scanUrls(t);
    hosts.push(...s.urls.map(hostOf));
    if (s.opaque) opaque = true;
  }
  if ((long || a.long) && (cls === 'send' || cls === 'pay')) { opaque = true; a.unknown = true; } // past what we read: can't say where or how much
  const domains = [...new Set(hosts)];
  if (domains.length) out.domains = domains;
  const channels = strs(p.channel, p.channel_id, p.channels, p.channel_ids);
  if (channels.length) out.channels = channels;
  const recipients = strs(p.to, p.recipient, p.recipients, p.cc, p.bcc);
  if (recipients.length) out.recipients = recipients;
  if (a.unknown) out.amountUnknown = true;
  else if (a.amounts.length) out.amount = Math.max(...a.amounts);
  if (opaque) out.opaque = true;
  return out;
}
