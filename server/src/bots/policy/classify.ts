// server/src/bots/policy/classify.ts
import type { ActionClass } from '../../protocol.js';
import type { Target } from './rules.js';

/** Harness / meta tools and plain reads: they never leave the machine on their own (sub-agents' own calls pass the gate). */
const READ_TOOLS = new Set([
  'Read', 'NotebookRead', 'LS', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'SearchExtraTools', 'ToolSearch', 'ExitPlanMode',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'KillShell', 'BashOutput',
]);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** When a call matches several classes, the first one here wins. */
const RANK: ActionClass[] = ['pay', 'delete', 'send', 'install', 'browser', 'write_local', 'read'];

const PAY_HOST = /(^|\.)(stripe|paypal|alipay)\.com$|^(checkout|pay|payments?)\./i;
const PAY_PATH = /(^|\/)(pay|checkout)(\/|$)/i;

const innerName = (toolName: string, input: Record<string, unknown>) => toolName === 'ExecuteExtraTool' && typeof input.tool_name === 'string' ? input.tool_name : toolName;
const innerParams = (toolName: string, input: Record<string, unknown>) => (toolName === 'ExecuteExtraTool' && input.params && typeof input.params === 'object' ? input.params : input) as Record<string, unknown>;

// ---- URLs ----

/**
 * Every scheme://… in a piece of text. http(s) ones are parsed (trailing punctuation stripped); anything we can't
 * read the same way the sending program would — another scheme, a parse failure, userinfo / backslash / percent in
 * the authority — marks the text opaque.
 */
function scanUrls(text: string): { urls: URL[]; opaque: boolean } {
  const urls: URL[] = [];
  let opaque = false;
  for (const m of text.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/[^\s'"<>`]*/gi)) {
    if (!/^https?$/i.test(m[1])) { opaque = true; continue; }
    const s = m[0].replace(/[.,;:!?)\]}]+$/, '');
    const authority = s.slice(s.indexOf('//') + 2).split(/[/?#]/)[0];
    if (/[@\\%]/.test(authority) || !authority) opaque = true;
    try { const u = new URL(s); if (u.hostname) urls.push(u); else opaque = true; } catch { opaque = true; }
  }
  return { urls, opaque };
}
const urlsIn = (text: string) => scanUrls(text).urls;
const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/\.+$/, '');
const isPayUrl = (u: URL) => PAY_HOST.test(hostOf(u)) || PAY_PATH.test(u.pathname);
const isHttp = (s: string) => /^https?:\/\//i.test(s);

// ---- shell: read the command the way the shell does ----

/**
 * Split a command into segments (; & | newline ( ) and, in bash, backticks) and tokens, with quotes removed and
 * escapes applied — `\rm`, `r\m`, `'-rf'`, `"my repo"` come out as the shell hands them to the program.
 * Bash escapes with backslash; PowerShell with backtick (and keeps backslashes: they are path separators).
 */
function segments(cmd: string, ps: boolean): string[][] {
  const segs: string[][] = [];
  let toks: string[] = [], cur = '', has = false;
  const endTok = () => { if (has) toks.push(cur); cur = ''; has = false; };
  const endSeg = () => { endTok(); if (toks.length) segs.push(toks); toks = []; };
  const esc = ps ? '`' : '\\';
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'") { const j = cmd.indexOf("'", i + 1); const e = j < 0 ? cmd.length : j; cur += cmd.slice(i + 1, e); has = true; i = e; continue; }
    if (ch === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) { if (cmd[j] === esc && j + 1 < cmd.length) j++; cur += cmd[j]; }
      has = true; i = j; continue;
    }
    if (ch === esc) { if (i + 1 < cmd.length && cmd[i + 1] !== '\n') cur += cmd[i + 1]; i++; has = true; continue; }
    if (ch === '\n' || ';&|()'.includes(ch) || (ch === '`' && !ps)) { endSeg(); continue; }
    if (/\s/.test(ch)) { endTok(); continue; }
    cur += ch; has = true;
  }
  endSeg();
  return segs;
}

/** Words that run the next word as the command (sudo rm …, xargs rm …, env X=1 curl …). */
const PREFIX_WORDS = new Set(['sudo', 'doas', 'exec', 'command', 'builtin', 'env', 'nohup', 'time', 'nice', 'ionice', 'xargs', 'timeout', 'eval', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', '$']);
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
const base = (t: string) => t.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

interface Cmd { cmd: string; args: string[]; env: string[] }
function commandOf(seg: string[]): Cmd | undefined {
  let i = 0;
  const env: string[] = [];
  while (i < seg.length) {
    const t = seg[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { env.push(t); i++; continue; }
    const w = base(t);
    if (PREFIX_WORDS.has(w)) {
      i++;
      while (i < seg.length && (seg[i].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(seg[i]))) { const o = seg[i++]; if (PREFIX_ARG_OPTS[w]?.has(o) && i < seg.length) i++; }
      continue;
    }
    break;
  }
  return i < seg.length ? { cmd: base(seg[i]), args: seg.slice(i + 1), env } : undefined;
}

/** rm's recursive / force in any spelling: -rf, -Rf, -rfv, -r -f, --recursive, --rec, --forc, PowerShell -Recurse / -Fo. */
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
const psRecurse = (args: string[]) => args.some((a) => { const l = a.toLowerCase(); if (l === '/s') return true; const n = l.startsWith('-') && !l.startsWith('--') ? l.slice(1).split(':')[0] : ''; return n.length >= 1 && 'recurse'.startsWith(n); });

/** git's subcommand, after global options (-C <path>, -c <k=v>, --git-dir <d>, --no-pager …). */
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
function gitSub(args: string[]): { sub?: string; rest: string[]; config: string[] } {
  const config: string[] = [];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (GIT_ARG_OPTS.has(args[i])) { if (args[i] === '-c' || args[i] === '--config-env') config.push(args[i + 1] ?? ''); i += 2; } else { if (args[i].startsWith('-c') && args[i].length > 2) config.push(args[i].slice(2)); i++; }
  }
  return { sub: args[i]?.toLowerCase(), rest: args.slice(i + 1), config };
}
const shortHas = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));

/** curl: method, whether it sends a body, where it goes. */
const CURL_SHORT_VALUE = new Set([...'AbcCdDeEFHKmoPQrtTuUwxXyYz']);
const CURL_LONG_VALUE = new Set(['data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'form', 'form-string', 'json', 'header', 'output', 'user', 'user-agent', 'referer',
  'request', 'cookie', 'cookie-jar', 'upload-file', 'write-out', 'config', 'proxy', 'proxy-user', 'preproxy', 'cert', 'key', 'cacert', 'capath', 'max-time', 'connect-timeout', 'range',
  'retry', 'retry-delay', 'retry-max-time', 'resolve', 'connect-to', 'url', 'output-dir', 'limit-rate', 'interface', 'dns-servers', 'doh-url', 'socks4', 'socks4a', 'socks5',
  'socks5-hostname', 'oauth2-bearer', 'aws-sigv4', 'unix-socket', 'abstract-unix-socket', 'request-target', 'variable', 'dump-header', 'continue-at', 'max-filesize', 'expect100-timeout']);
const CURL_REDIRECT = /^(proxy|preproxy|proxy1\.0|socks.*|resolve|connect-to|unix-socket|abstract-unix-socket|config|doh-url)$/;
interface Http { method?: string; body: boolean; dests: string[]; opaque: boolean }
function curlParse(args: string[]): Http {
  const h: Http = { body: false, dests: [], opaque: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const n = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      const takes = CURL_LONG_VALUE.has(n);
      const val = eq >= 0 ? a.slice(eq + 1) : takes ? args[++i] ?? '' : undefined;
      if (n === 'request') h.method = val;
      if (/^(data|form)/.test(n) || n === 'json' || n === 'upload-file') h.body = true;
      if (CURL_REDIRECT.test(n)) h.opaque = true;
      if (n === 'url' && val !== undefined) h.dests.push(val);
      continue;
    }
    if (/^-[a-zA-Z]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if ('dFT'.includes(ch)) h.body = true;
        if (ch === 'x' || ch === 'K') h.opaque = true;
        if (CURL_SHORT_VALUE.has(ch)) { const val = j + 1 < a.length ? a.slice(j + 1) : args[++i] ?? ''; if (ch === 'X') h.method = val; break; }
      }
      continue;
    }
    h.dests.push(a);
  }
  return h;
}
const WGET_SHORT_VALUE = new Set([...'oaOePUtTwQiBDIXlAR']);
const WGET_LONG_VALUE = new Set(['header', 'post-data', 'post-file', 'body-data', 'body-file', 'method', 'user', 'password', 'output-document', 'output-file', 'append-output', 'directory-prefix',
  'user-agent', 'tries', 'timeout', 'wait', 'input-file', 'execute', 'base', 'referer', 'load-cookies', 'save-cookies', 'config']);
function wgetParse(args: string[]): Http {
  const h: Http = { body: false, dests: [], opaque: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const n = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      const val = eq >= 0 ? a.slice(eq + 1) : WGET_LONG_VALUE.has(n) ? args[++i] ?? '' : undefined;
      if (n === 'method') h.method = val;
      if (/^(post|body)-/.test(n)) h.body = true;
      if (/^(input-file|execute|base|config)$/.test(n)) h.opaque = true;
      continue;
    }
    if (/^-[a-zA-Z]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if ('ieB'.includes(ch)) h.opaque = true;
        if (WGET_SHORT_VALUE.has(ch)) { if (j + 1 >= a.length) i++; break; }
      }
      continue;
    }
    h.dests.push(a);
  }
  return h;
}
/** Invoke-WebRequest / Invoke-RestMethod: parameters may be any unambiguous prefix and take `-Name:value`. */
const PS_WEB = new Set(['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm']);
const PS_SWITCHES = ['usebasicparsing', 'usedefaultcredentials', 'skipcertificatecheck', 'skipheadervalidation', 'skiphttperrorcheck', 'passthru', 'disablekeepalive',
  'allowunencryptedauthentication', 'allowinsecureredirect', 'proxyusedefaultcredentials', 'resume', 'nobody'];
function psWebParse(args: string[]): Http {
  const h: Http = { body: false, dests: [], opaque: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('@')) { h.opaque = true; h.body = true; continue; } // splatted parameters: can't see them
    if (/^-[a-zA-Z]/.test(a)) {
      const colon = a.indexOf(':');
      const n = (colon < 0 ? a.slice(1) : a.slice(1, colon)).toLowerCase();
      const is = (full: string) => full.startsWith(n);
      const isValue = ['method', 'body', 'infile', 'form', 'uri', 'proxy'].some(is);
      if (!isValue && PS_SWITCHES.some(is)) continue;
      const val = colon >= 0 ? a.slice(colon + 1) : args[++i] ?? '';
      if (is('method')) h.method = val;
      else if (is('body') || is('infile') || is('form')) h.body = true;
      else if (is('uri')) h.dests.push(val);
      else if (is('proxy')) h.opaque = true;
      continue;
    }
    h.dests.push(a);
  }
  return h;
}
const methodClass = (m: string | undefined): ActionClass | undefined => {
  if (m === undefined) return undefined;
  const u = m.toUpperCase();
  if (u === 'DELETE') return 'delete';
  return ['GET', 'HEAD', 'OPTIONS', 'DEFAULT', ''].includes(u) ? undefined : 'send';
};
function httpOf(c: Cmd): Http | undefined {
  if (c.cmd === 'curl') return curlParse(c.args);
  if (c.cmd === 'wget') return wgetParse(c.args);
  if (PS_WEB.has(c.cmd)) return psWebParse(c.args);
  return undefined;
}

const SEND_WORDS = new Set(['ssh', 'scp', 'sftp', 'mosh', 'mail', 'mailx', 'sendmail', 'mutt', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'ftp', 'tftp', 'send-mailmessage']);
const REMOVE_WORDS = new Set(['remove-item', 'ri', 'rd', 'rmdir', 'del', 'erase']);
const remoteArg = (a: string) => /^[^\s/\\:]{2,}:/.test(a) || /^[a-z][a-z0-9+.-]*:\/\//i.test(a); // host:path, user@host:path, rsync://…

/** The classes one command segment belongs to, read from its tokens. */
function segmentClasses(c: Cmd): ActionClass[] {
  const out: ActionClass[] = [];
  const { cmd, args } = c;
  if (cmd === 'rm') { const { r, f } = rmFlags(args); if (r && f) out.push('delete'); }
  if (REMOVE_WORDS.has(cmd) && psRecurse(args)) out.push('delete');
  if (cmd === 'find') {
    if (args.includes('-delete')) out.push('delete');
    args.forEach((a, i) => { if (/^-(exec|execdir|ok|okdir)$/.test(a) && ['rm', 'rmdir', 'unlink', 'shred', 'remove-item'].includes(base(args[i + 1] ?? ''))) out.push('delete'); });
  }
  if (cmd === 'git') {
    const { sub, rest } = gitSub(args);
    if (sub === 'push') out.push(rest.includes('--delete') || rest.includes('--mirror') || rest.includes('--prune') || shortHas(rest, 'd') || rest.some((a) => /^\+?:/.test(a)) ? 'delete' : 'send');
    if (sub === 'send-email' || sub === 'request-pull') out.push('send');
    if (sub === 'branch' && (shortHas(rest, 'D') || ((rest.includes('--delete') || shortHas(rest, 'd')) && (rest.includes('--force') || shortHas(rest, 'f'))))) out.push('delete');
    if (sub === 'clean' && (rest.includes('--force') || shortHas(rest, 'f'))) out.push('delete');
  }
  if (cmd === 'gh') {
    if (args[1]?.toLowerCase() === 'delete') out.push('delete');
    if (args[0] === 'api') {
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        const m = a === '-X' || a === '--method' ? args[i + 1] : /^--method=/.test(a) ? a.slice(9) : /^-X./.test(a) ? a.slice(2) : undefined;
        const k = methodClass(m);
        if (k) out.push(k);
        if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a)) out.push('send');
      }
    }
  }
  const h = httpOf(c);
  if (h) { const k = methodClass(h.method); if (k) out.push(k); if (h.body) out.push('send'); }
  if (SEND_WORDS.has(cmd)) out.push('send');
  if (cmd === 'rsync' && args.some((a) => !a.startsWith('-') && remoteArg(a))) out.push('send');
  return out;
}

// Regexes over the raw text and over the de-quoted tokens: a second net under the token reading (stricter wins).

/** Start of a command: line start, after ; & | ( ) { } $(, past sudo / env / VAR=x prefixes. */
const SEG = String.raw`(?:^|[;&|(){}\n]|\$\()\s*(?:(?:sudo|exec|command)\s+|env\s+|\w+=\S*\s+)*`;
/** `git`, then any global options (`-C repo`, `--no-pager`, `-c k=v`), then the subcommand. */
const GIT = String.raw`\bgit(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+`;
const REST = String.raw`[^;&|\n]*`; // the rest of this command, up to the next separator
const RECURSE = String.raw`-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?![\w-])`; // PowerShell accepts any prefix of -Recurse

const DELETE_CMD: RegExp[] = [
  new RegExp(GIT + String.raw`push\b${REST}\s(?:--delete\b|-d\b|:\S)`),
  new RegExp(GIT + String.raw`branch\b${REST}\s-[a-zA-Z]*D`),
  new RegExp(GIT + String.raw`clean\b${REST}\s-[a-zA-Z]*f`),
  /\bgh\s+[\w-]+\s+delete\b/,
  new RegExp(String.raw`\bgh\s+api\b${REST}\s(?:-X|--method)[\s=]*['"]?DELETE\b`, 'i'),
  new RegExp(String.raw`\bcurl\b${REST}\s(?:-[a-zA-Z]*X|--request)[\s=]*['"]?DELETE\b`, 'i'),
  new RegExp(String.raw`\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b${REST}-Method[\s:]+['"]?Delete\b`, 'i'),
  new RegExp(String.raw`\bRemove-Item\b${REST}\s${RECURSE}`, 'i'),
  new RegExp(SEG + String.raw`(?:ri|rd|rmdir|del|erase)(?=\s)${REST}\s(?:${RECURSE}|/s\b)`, 'i'),
  /\bnpm\s+unpublish\b/,
];

const INSTALL_CMD = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b${REST}\s(?:-g|--global)\b`, String.raw`\byarn\s+global\s+add\b`,
  String.raw`\bpip3?\s+install\b`, String.raw`\bpython3?\s+-m\s+pip\s+install\b`, String.raw`\b(?:uv\s+tool|pipx|cargo|go)\s+install\b`,
  String.raw`\b(?:brew|winget|choco|scoop)\s+install\b`, String.raw`\bapt(?:-get)?\s+install\b`,
  String.raw`\bclaude\s+plugin\s+install\b`, String.raw`\bnpx\s+skills\s+add\b`,
].join('|'));

const SEND_CMD: RegExp[] = [
  new RegExp(GIT + String.raw`(?:push|send-email)\b`),
  /\bgh\s+(?:pr|issue|release|gist|repo)\s+(?:create|comment|merge|close|edit|review|reopen|ready|upload|fork|rename|archive)\b/,
  new RegExp(String.raw`\bgh\s+api\b${REST}\s(?:(?:-X|--method)[\s=]*['"]?(?:POST|PUT|PATCH|DELETE)\b|(?:-f|-F|--field|--raw-field|--input)(?=[\s=]))`, 'i'),
  /\bglab\s+(?:mr|issue|release)\b/,
  // curl: a non-GET method, or any body / form / upload flag (short flags may be clustered: -sd, -sF)
  new RegExp(String.raw`\bcurl\b${REST}(?:\s(?:-[a-zA-Z]*X|--request)[\s=]*['"]?(?:POST|PUT|PATCH|DELETE)\b|\s-(?![a-zA-Z]*X)[a-zA-Z]*[dFT]|\s--(?:data[\w-]*|form[\w-]*|json|upload-file)\b)`, 'i'),
  new RegExp(String.raw`\bwget\b${REST}--(?:post-data|post-file|body-data|body-file|method[=\s]+['"]?(?:POST|PUT|PATCH|DELETE))`, 'i'),
  new RegExp(String.raw`\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b${REST}(?:-Method[\s:]+['"]?(?:Post|Put|Patch|Delete)\b|-Body\b|-InFile\b|-Form\b)`, 'i'),
  /\b(?:npm|pnpm|yarn|bun|cargo|poetry|vsce|ovsx)\s+(?:npm\s+)?publish\b|\btwine\s+upload\b|\bgem\s+push\b|\b(?:docker|podman)\s+push\b|\bdotnet\s+nuget\s+push\b/,
  /\bSend-MailMessage\b/i,
  // mail / ssh only as the command word — not ~/.ssh/config or src/mail/
  new RegExp(SEG + String.raw`(?:mail|mailx|sendmail|ssh|scp|sftp)(?=\s|$)`),
  new RegExp(String.raw`\brsync\b${REST}\s[\w.@-]{2,}:`),
];

/** De-quoted tokens back into one line for the regexes; spaces / separators inside a token can't start a command. */
const flatten = (segs: string[][]) => segs.map((s) => s.map((t) => t.replace(/[\s;&|(){}]/g, '_')).join(' ')).join(' ; ');

// ---- network calls that carry local data out ----

/** A simple command with what feeds it: substitution in its words, a pipe into it, a `<` redirect. */
interface PCmd { toks: string[]; subst: boolean; piped: boolean; stdin: boolean }

/**
 * Parse into simple commands, keeping what `segments()` throws away: whether a command's words contain command
 * substitution — bash $(…) / `…` / <(…), PowerShell $(…) / @(…) / (…) as an argument — and whether its stdin is a
 * pipe or a `<` file. The commands inside a substitution are parsed too (they are separate entries).
 */
function parseCommands(src: string, ps: boolean): PCmd[] {
  const all: PCmd[] = [];
  const esc = ps ? '`' : '\\';
  let i = 0;
  const level = (stop: string | null): void => {
    let cmd: PCmd = { toks: [], subst: false, piped: false, stdin: false };
    let cur = '', has = false;
    const endTok = () => { if (has) cmd.toks.push(cur); cur = ''; has = false; };
    const endCmd = (piped: boolean) => { endTok(); if (cmd.toks.length) all.push(cmd); cmd = { toks: [], subst: false, piped, stdin: false }; };
    const sub = (close: string) => { cmd.subst = true; cur += '$SUB'; has = true; level(close); };
    while (i < src.length) {
      const ch = src[i], nx = src[i + 1];
      if (stop !== null && ch === stop) { i++; endCmd(false); return; }
      if (ch === "'") { const j = src.indexOf("'", i + 1); const e = j < 0 ? src.length : j; cur += src.slice(i + 1, e); has = true; i = e + 1; continue; }
      if (ch === '"') {
        i++; has = true;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === esc && i + 1 < src.length) { cur += src[i + 1]; i += 2; continue; }
          if (src[i] === '$' && src[i + 1] === '(') { i += 2; sub(')'); continue; }
          if (!ps && src[i] === '`') { i++; sub('`'); continue; }
          cur += src[i++];
        }
        i++; continue;
      }
      if (ch === esc) { if (i + 1 < src.length) cur += nx; i += 2; has = true; continue; }
      if ((ch === '$' || (ps && ch === '@')) && nx === '(') { i += 2; sub(')'); continue; }
      if (!ps && (ch === '<' || ch === '>') && nx === '(') { i += 2; sub(')'); continue; }
      if (!ps && ch === '`') { i++; sub('`'); continue; }
      if (ch === '(') { i++; if (cmd.toks.length || has) sub(')'); else { endCmd(false); level(')'); } continue; }
      if (ch === ')') { i++; endCmd(false); continue; }
      if (ch === '|') { if (nx === '|') { i += 2; endCmd(false); } else { i++; endCmd(true); } continue; }
      if (ch === ';' || ch === '&' || ch === '\n') { i++; endCmd(false); continue; }
      if (!ps && ch === '<') { endTok(); cmd.stdin = true; i++; continue; }
      if (/\s/.test(ch)) { endTok(); i++; continue; }
      cur += ch; has = true; i++;
    }
    endCmd(false);
  };
  level(null);
  return all;
}

const NET_TOOLS = new Set(['curl', 'wget', 'irm', 'iwr', 'invoke-webrequest', 'invoke-restmethod', 'http', 'https', 'httpie', 'xh', 'xhs', 'nc', 'ncat', 'netcat', 'socat', 'telnet']);
const HTTPIE = new Set(['http', 'https', 'httpie', 'xh', 'xhs']);

/** A word that makes the tool read a local file and send it: @file, -d@file, --data-binary=@x, f=@x / f=<x, -T, -InFile, wget -i / --post-file. */
function readsLocalFile(cmd: string, a: string): boolean {
  if (a.startsWith('@') || /^-[a-zA-Z]+@/.test(a) || /^--[\w-]+=@/.test(a) || /[=:]@|=</.test(a)) return true;
  if (cmd === 'curl' && (/^-[a-zA-Z]*T/.test(a) || /^--upload-file\b/.test(a))) return true;
  if (cmd === 'wget' && (/^-[a-zA-Z]*i/.test(a) || /^--(input-file|post-file|body-file)\b/.test(a))) return true;
  if (['irm', 'iwr', 'invoke-webrequest', 'invoke-restmethod'].includes(cmd) && /^-in(f(i(le?)?)?)?(:|$)/i.test(a)) return true;
  return false;
}

/** httpie / xh: an explicit non-GET method, or request items that make a body (k=v, k:=v, k@file). */
function httpieSends(args: string[]): boolean {
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos[0] && /^(POST|PUT|PATCH|DELETE)$/i.test(pos[0])) return true;
  return pos.some((a) => /^[^=:@/]+(:=|=(?!=)|@)/.test(a));
}

/** Local data leaving through a network tool: substitution in its words, piped / redirected input, a file it reads. */
function carriesLocalData(raw: string, ps: boolean): boolean {
  for (const pc of parseCommands(raw, ps)) {
    const c = commandOf(pc.toks);
    if (!c || !NET_TOOLS.has(c.cmd)) continue;
    if (pc.subst || pc.piped || pc.stdin) return true;
    if (c.args.some((a) => readsLocalFile(c.cmd, a))) return true;
    if (HTTPIE.has(c.cmd) && httpieSends(c.args)) return true;
  }
  return false;
}

function classifyCommand(cmd: string, ps: boolean): ActionClass {
  const raw = cmd.trim();
  const segs = segments(raw, ps);
  const found = new Set<ActionClass>();
  for (const c of [raw, flatten(segs)]) {
    if (DELETE_CMD.some((re) => re.test(c))) found.add('delete');
    if (INSTALL_CMD.test(c)) found.add('install');
    if (SEND_CMD.some((re) => re.test(c))) found.add('send');
  }
  for (const seg of segs) {
    const c = commandOf(seg);
    if (c) for (const k of segmentClasses(c)) found.add(k);
    // net: rm -rf / Remove-Item -Recurse anywhere in the segment, whatever we took the command word to be
    seg.forEach((t, i) => {
      const w = base(t);
      if (w === 'rm') { const { r, f } = rmFlags(seg.slice(i + 1)); if (r && f) found.add('delete'); }
      if (REMOVE_WORDS.has(w) && psRecurse(seg.slice(i + 1))) found.add('delete');
    });
  }
  if (carriesLocalData(raw, ps)) found.add('send');
  if ([raw, ...segs.flat()].some((t) => urlsIn(t).some(isPayUrl))) found.add('pay');
  return RANK.find((k) => found.has(k)) ?? 'write_local';
}

// ---- named tools ----

const DELETE_NAME = /delete|remove|destroy|purge|trash|unpublish|wipe|erase/i;
const PAY_NAME = /checkout|purchase|payment|transfer|refund|charge|(^|_)(pay|order|buy)(s?_|s?$)/i;
const READ_FIRST = new Set(['search', 'list', 'get', 'read', 'fetch', 'find']);
/** Any of these anywhere in an MCP tool's name and it does more than read. */
const WRITE_WORDS = new Set(['send', 'post', 'reply', 'forward', 'create', 'update', 'write', 'publish', 'share', 'invite', 'upload', 'submit', 'set', 'put', 'add', 'edit', 'modify',
  'move', 'merge', 'close', 'approve', 'run', 'exec', 'execute', 'call', 'invoke', 'trigger', 'mark', 'archive', 'unarchive', 'cancel', 'replace', 'kick', 'label', 'unlabel', 'star',
  'unstar', 'remove', 'delete', 'pin', 'unpin', 'react', 'assign', 'unassign', 'ban', 'unban', 'mute', 'unmute', 'block', 'unblock', 'rename', 'copy', 'apply', 'commit', 'push',
  'import', 'sync', 'start', 'stop', 'restart', 'deploy', 'accept', 'reject', 'decline', 'schedule', 'subscribe', 'unsubscribe', 'follow', 'unfollow', 'like', 'vote', 'enable',
  'disable', 'grant', 'revoke', 'lock', 'unlock', 'transfer', 'pay', 'save', 'store', 'insert', 'upsert', 'patch', 'reset', 'clear', 'mutate', 'notify', 'broadcast', 'dispatch',
  'snooze', 'resolve', 'reopen', 'join', 'leave']);
/** camelCase → snake_case, lower: `sendMessage` → `send_message`. */
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

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
    // a read only when that's all it does: the tool part starts with a read verb and names no other action
    const parts = w.slice(w.lastIndexOf('__') + 2).split(/[_\-.]+/).filter(Boolean);
    if (READ_FIRST.has(parts[0]) && !parts.some((x) => WRITE_WORDS.has(x))) return 'read';
  }
  return 'send';
}

/** Secrets never reach the audit: auth headers, bearer tokens, -u user:pass, URL userinfo, *_KEY / *_TOKEN / *_SECRET values, mysql -p…, sk- / ghp_ keys. */
export function redact(s: string): string {
  return s
    .replace(/\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)(\s*[:=]\s*)[^'"\n]+/gi, '$1$2[redacted]')
    .replace(/\bbearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(\s(?:-u|--user|--proxy-user)(?:\s+|=))(['"]?)[^\s'"]+\2/g, '$1[redacted]')
    .replace(/(\/\/)[^\s/@'"]+:[^\s/@'"]+@/g, '$1[redacted]@')
    .replace(/(\bmysql(?:dump|admin|sh)?\b[^;&|\n]*?\s)-p(?=[^\s-])\S+/g, '$1-p[redacted]')
    .replace(/([?&;:\s"'{,$]|^)([\w-]*(?:token|secret|password|passwd|pwd|key|signature|credential)[\w-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^&\s'",}]+)/gi, '$1$2$3[redacted]')
    .replace(/\b(sk|rk|pk)-[\w-]{8,}/g, '$1-[redacted]')
    .replace(/\b(ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abprs])[-_][\w-]{8,}/g, '$1_[redacted]');
}

export function summarize(toolName: string, input: Record<string, unknown>): string {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  const key = typeof p.command === 'string' ? p.command : typeof p.file_path === 'string' ? p.file_path : typeof p.url === 'string' ? p.url : typeof p.channel === 'string' ? p.channel : JSON.stringify(p);
  return `${name}: ${redact(String(key))}`.replace(/\s+/g, ' ').slice(0, 160);
}

/** Strings from a param that may be a string ("a@x, b@y") or a list. */
function strs(...vals: unknown[]): string[] {
  const out: string[] = [];
  for (const v of vals) {
    const items = Array.isArray(v) ? v : [v];
    for (const it of items) if (typeof it === 'string') out.push(...it.split(/[,;]/).map((x) => x.trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

/** Where a shell command goes: hosts it names, and whether it also goes somewhere we can't read. */
function shellDestinations(command: string, ps: boolean): { hosts: string[]; opaque: boolean } {
  const segs = segments(command, ps);
  const hosts: string[] = [];
  let opaque = false;
  const addText = (t: string) => { const s = scanUrls(t); hosts.push(...s.urls.map(hostOf)); if (s.opaque) opaque = true; };
  addText(command);
  for (const seg of segs) {
    for (const t of seg) { addText(t); if (/^[\w.+-]+@[\w.-]+:/.test(t)) opaque = true; }
    const c = commandOf(seg);
    if (!c) continue;
    if (c.env.some((e) => /proxy|git_ssh|git_config|curl_home|wgetrc/i.test(e.split('=')[0]))) opaque = true;
    const h = httpOf(c);
    if (h) { if (h.opaque || h.dests.some((d) => !isHttp(d))) opaque = true; }
    if (SEND_WORDS.has(c.cmd) || (c.cmd === 'rsync' && c.args.some((a) => !a.startsWith('-') && remoteArg(a)))) opaque = true;
    if (c.cmd === 'git') {
      const { sub, rest, config } = gitSub(c.args);
      if (config.some((v) => /proxy|insteadof|sshcommand|askpass/i.test(v))) opaque = true;
      if (sub === 'send-email') opaque = true;
      // the repository argument (not the refspecs after it: main:main is a refspec)
      const pos = rest.filter((a) => !a.startsWith('-'));
      const repo = sub === 'remote' ? pos[2] : pos[0];
      if (sub && ['push', 'fetch', 'pull', 'clone', 'ls-remote', 'remote'].includes(sub) && repo && !isHttp(repo) && remoteArg(repo)) opaque = true;
    }
  }
  return { hosts, opaque };
}

/** Every amount in the call. A value under an amount key that isn't a plain non-negative decimal makes the amount unknown. */
const PLAIN = /^\d+(\.\d+)?$/;
const AMOUNT_IN_TEXT = /([\w.[\]-]*amount[\w.[\]-]*)["']?\s*[=:]\s*["']?([^\s&'",;}\]]*)/gi;
function textVariants(s: string): string[] {
  const out = [s, s.replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))];
  try { out.push(decodeURIComponent(s)); } catch { /* not encoded */ }
  return out;
}
function amountsOf(p: Record<string, unknown>, extraTexts: string[]): { amounts: number[]; unknown: boolean } {
  const amounts: number[] = [];
  let unknown = false;
  const scan = (s: string) => {
    for (const v of textVariants(s)) for (const m of v.matchAll(AMOUNT_IN_TEXT)) { if (PLAIN.test(m[2])) amounts.push(Number(m[2])); else unknown = true; }
  };
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 8) return;
    if (/amount/i.test(key)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) amounts.push(v);
      else if (typeof v === 'string' && PLAIN.test(v.trim())) amounts.push(Number(v.trim()));
      else if (v !== undefined && v !== null) unknown = true;
      return;
    }
    if (typeof v === 'string') scan(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, '', depth + 1));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(p, '', 0);
  extraTexts.forEach(scan);
  return { amounts, unknown };
}

/** What the scope rules match on: EVERY host the call touches, every channel / recipient, the LARGEST amount — and whether any of it couldn't be read. */
export function targetOf(_cls: ActionClass, toolName: string, input: Record<string, unknown>): Target {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  const out: Target = {};
  const hosts: string[] = [];
  let opaque = false;
  const shell = (name === 'Bash' || name === 'PowerShell') && typeof p.command === 'string';
  const tokens: string[] = [];
  if (shell) {
    const d = shellDestinations(p.command as string, name === 'PowerShell');
    hosts.push(...d.hosts); opaque = d.opaque;
    tokens.push(...segments(p.command as string, name === 'PowerShell').flat());
  }
  for (const t of [shell ? undefined : p.command, p.url, p.uri]) {
    if (typeof t !== 'string') continue;
    const s = scanUrls(t);
    hosts.push(...s.urls.map(hostOf));
    if (s.opaque) opaque = true;
  }
  const domains = [...new Set(hosts)];
  if (domains.length) out.domains = domains;
  const channels = strs(p.channel, p.channel_id, p.channels, p.channel_ids);
  if (channels.length) out.channels = channels;
  const recipients = strs(p.to, p.recipient, p.recipients, p.cc, p.bcc);
  if (recipients.length) out.recipients = recipients;
  const a = amountsOf(p, tokens);
  if (a.unknown) out.amountUnknown = true;
  else if (a.amounts.length) out.amount = Math.max(...a.amounts);
  if (opaque) out.opaque = true;
  return out;
}
