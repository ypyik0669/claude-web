// server/src/bots/policy/classify.ts
import type { ActionClass } from '../../protocol.js';
import type { Target } from './rules.js';

/** Harness / meta tools and plain reads: they never leave the machine on their own (sub-agents' own calls pass the gate). */
const READ_TOOLS = new Set([
  'Read', 'NotebookRead', 'LS', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'SearchExtraTools', 'ToolSearch', 'ExitPlanMode',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput',
]);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** When a call matches several classes, the first one here wins. */
const RANK: ActionClass[] = ['pay', 'delete', 'send', 'install', 'browser', 'write_local', 'read'];

const PAY_HOST = /(^|\.)(stripe|paypal|alipay)\.com$|^(checkout|pay|payments?)\./i;
const PAY_PATH = /(^|\/)(pay|checkout)(\/|$)/i;

const innerName = (toolName: string, input: Record<string, unknown>) => toolName === 'ExecuteExtraTool' && typeof input.tool_name === 'string' ? input.tool_name : toolName;
const innerParams = (toolName: string, input: Record<string, unknown>) => (toolName === 'ExecuteExtraTool' && input.params && typeof input.params === 'object' ? input.params : input) as Record<string, unknown>;

/** Every http(s) URL in a piece of text, trailing punctuation stripped. */
function urlsIn(text: string): URL[] {
  const out: URL[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s'"<>`]+/gi)) {
    try { out.push(new URL(m[0].replace(/[.,;:!?)\]}]+$/, ''))); } catch { /* not a URL */ }
  }
  return out;
}
const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/\.+$/, '');
const isPayUrl = (u: URL) => PAY_HOST.test(hostOf(u)) || PAY_PATH.test(u.pathname);

// ---- shell commands (Bash and PowerShell share these) ----

/** Start of a command: line start, after ; & | ( ) { } $(, past sudo / env / VAR=x prefixes. */
const SEG = String.raw`(?:^|[;&|(){}\n]|\$\()\s*(?:(?:sudo|exec|command)\s+|env\s+|\w+=\S*\s+)*`;
/** `git`, then any global options (`-C repo`, `--no-pager`, `-c k=v`), then the subcommand. */
const GIT = String.raw`\bgit(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+`;
const REST = String.raw`[^;&|\n]*`; // the rest of this command, up to the next separator
const RECURSE = String.raw`-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?![\w-])`; // PowerShell accepts any prefix of -Recurse

/** rm with both recursive and force, in any spelling: -rf, -Rf, -rfv, -r -f, --recursive --force, flags after paths. */
function rmRecursiveForce(c: string): boolean {
  for (const m of c.matchAll(/(?:^|[\s;&|(){}`/])rm(?=\s)([^;&|\n]*)/gi)) {
    const flags = m[1].trim().split(/\s+/).filter((t) => t.startsWith('-')).map((t) => t.toLowerCase());
    const short = flags.filter((f) => /^-[a-z]+$/.test(f)).join('');
    const r = short.includes('r') || flags.includes('--recursive');
    const f = short.includes('f') || flags.includes('--force');
    if (r && f) return true;
  }
  return false;
}

const DELETE_CMD: RegExp[] = [
  new RegExp(GIT + String.raw`push\b${REST}\s(?:--delete\b|-d\b|:\S)`),
  new RegExp(GIT + String.raw`branch\b${REST}\s-[a-zA-Z]*D`),
  new RegExp(GIT + String.raw`clean\b${REST}\s-[a-zA-Z]*f`),
  /\bgh\s+[\w-]+\s+delete\b/,
  new RegExp(String.raw`\bgh\s+api\b${REST}\s(?:-X|--method)[\s=]*['"]?DELETE\b`, 'i'),
  new RegExp(String.raw`\bcurl\b${REST}\s(?:-[a-zA-Z]*X|--request)[\s=]*['"]?DELETE\b`, 'i'),
  new RegExp(String.raw`\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b${REST}-Method\s+['"]?Delete\b`, 'i'),
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
  new RegExp(String.raw`\bcurl\b${REST}(?:\s(?:-[a-zA-Z]*X|--request)[\s=]*['"]?(?:POST|PUT|PATCH|DELETE|post|put|patch|delete)\b|\s-(?![a-zA-Z]*X)[a-zA-Z]*[dFT]|\s--(?:data[\w-]*|form[\w-]*|json|upload-file)\b)`),
  new RegExp(String.raw`\bwget\b${REST}--(?:post-data|post-file|body-data|body-file|method[=\s]+['"]?(?:POST|PUT|PATCH|DELETE))`, 'i'),
  new RegExp(String.raw`\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b${REST}(?:-Method\s+['"]?(?:Post|Put|Patch|Delete)\b|-Body\b|-InFile\b|-Form\b)`, 'i'),
  /\b(?:npm|pnpm|yarn|bun|cargo|poetry|vsce|ovsx)\s+(?:npm\s+)?publish\b|\btwine\s+upload\b|\bgem\s+push\b|\b(?:docker|podman)\s+push\b|\bdotnet\s+nuget\s+push\b/,
  /\bSend-MailMessage\b/i,
  // mail / ssh only as the command word — not ~/.ssh/config or src/mail/
  new RegExp(SEG + String.raw`(?:mail|mailx|sendmail|ssh|scp|sftp)(?=\s|$)`),
  new RegExp(String.raw`\brsync\b${REST}\s[\w.@-]{2,}:`),
];

function classifyCommand(cmd: string): ActionClass {
  const c = cmd.trim();
  const found = new Set<ActionClass>();
  if (rmRecursiveForce(c) || DELETE_CMD.some((re) => re.test(c))) found.add('delete');
  if (urlsIn(c).some(isPayUrl)) found.add('pay');
  if (INSTALL_CMD.test(c)) found.add('install');
  if (SEND_CMD.some((re) => re.test(c))) found.add('send');
  return RANK.find((k) => found.has(k)) ?? 'write_local';
}

// ---- named tools ----

const DELETE_NAME = /delete|remove|destroy|purge|trash|unpublish|wipe|erase/i;
const PAY_NAME = /checkout|purchase|payment|transfer|refund|charge|(^|_)(pay|order|buy)(s?_|s?$)/i;
const READ_VERB = /(^|_)(search|list|get|read|fetch|find)(_|$)/i;
const WRITE_VERB = /(^|_)(send|post|reply|create|update|write|publish|share|invite|upload|submit|set|put|add|edit|modify|move|merge|close|approve|run|exec|execute|call|invoke|trigger)(_|$)/i;
/** camelCase → snake_case, lower: `sendMessage` → `send_message`. */
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Which class of action a tool call is — the policy is written per class. Unknown tools are 'send': the side that asks. */
export function classify(toolName: string, input: Record<string, unknown>): ActionClass {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write_local';
  if (name === 'Bash' || name === 'PowerShell') return classifyCommand(String(p.command ?? ''));
  if (/^web\.(search|read)$|^memory\.(search|reflect)$/.test(name)) return 'read';
  if (/^memory\.write$|^sessions\./.test(name)) return 'write_local';
  const w = words(name);
  if (DELETE_NAME.test(w)) return 'delete';
  if (PAY_NAME.test(w) || urlsIn(String(p.url ?? '')).some(isPayUrl)) return 'pay';
  if (/^(ego_browser|browser_|web\.browser|computer[._])/.test(name) || /^mcp__(web|computer)__/.test(name)) return 'browser';
  if (/install/i.test(name)) return 'install';
  if (name.startsWith('mcp__')) {
    const verb = w.slice(w.lastIndexOf('__') + 2); // the tool part after the server name
    if (READ_VERB.test(verb) && !WRITE_VERB.test(verb)) return 'read';
  }
  return 'send';
}

/** Secrets never reach the audit: auth headers, bearer tokens, -u user:pass, URL userinfo, token= / key= values, sk- / ghp_ keys. */
export function redact(s: string): string {
  return s
    .replace(/\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)(\s*[:=]\s*)[^'"\n]+/gi, '$1$2[redacted]')
    .replace(/\bbearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(\s(?:-u|--user|--proxy-user)(?:\s+|=))(['"]?)[^\s'"]+\2/g, '$1[redacted]')
    .replace(/(\/\/)[^\s/@'"]+:[^\s/@'"]+@/g, '$1[redacted]@')
    .replace(/([?&;\s"'{,]|^)([\w-]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|signature)[\w-]*)(["']?\s*[=:]\s*["']?)[^&\s'",}]+/gi, '$1$2$3[redacted]')
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

/** What the scope rules match on: EVERY host the call touches, every channel / recipient, the LARGEST amount. */
export function targetOf(_cls: ActionClass, toolName: string, input: Record<string, unknown>): Target {
  const p = innerParams(toolName, input);
  const texts = [p.command, p.url, p.uri].filter((x): x is string => typeof x === 'string');
  const out: Target = {};
  const domains = [...new Set(texts.flatMap((t) => urlsIn(t).map(hostOf)))];
  if (domains.length) out.domains = domains;
  const channels = strs(p.channel, p.channel_id, p.channels, p.channel_ids);
  if (channels.length) out.channels = channels;
  const recipients = strs(p.to, p.recipient, p.recipients, p.cc, p.bcc);
  if (recipients.length) out.recipients = recipients;
  const amounts = texts.flatMap((t) => [...t.matchAll(/amount["']?[\s=:]+["']?(\d+(?:\.\d+)?)/gi)].map((a) => Number(a[1])));
  if (typeof p.amount === 'number') amounts.push(p.amount); else if (typeof p.amount === 'string' && /^\d+(\.\d+)?$/.test(p.amount)) amounts.push(Number(p.amount));
  if (amounts.length) out.amount = Math.max(...amounts);
  return out;
}
