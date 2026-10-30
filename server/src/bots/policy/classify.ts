// server/src/bots/policy/classify.ts
import type { ActionClass } from '../../protocol.js';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TaskOutput', 'TaskList', 'TaskGet', 'LSP']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'TaskCreate', 'TaskUpdate']);
const PAY_HOSTS = /(^|\.)(stripe\.com|paypal\.com|alipay\.com|checkout\.|pay\.|payments?\.)/i;

const innerName = (toolName: string, input: Record<string, unknown>) => toolName === 'ExecuteExtraTool' && typeof input.tool_name === 'string' ? input.tool_name : toolName;
const innerParams = (toolName: string, input: Record<string, unknown>) => (toolName === 'ExecuteExtraTool' && input.params && typeof input.params === 'object' ? input.params : input) as Record<string, unknown>;

function classifyCommand(cmd: string): ActionClass {
  const c = cmd.trim();
  if (/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/.test(c) || /\bgit\s+push\b.*--delete\b/.test(c) || /\bgit\s+branch\s+-D\b/.test(c) || /\bgit\s+push\b.*\s:\S/.test(c)) return 'delete';
  if (/https?:\/\/[^\s/]*(stripe|paypal|alipay|checkout\.|\/pay\b)/i.test(c)) return 'pay';
  if (/\b(npm|pnpm|yarn)\s+(i|install|add)\b.*(-g|--global)|\bpip3?\s+install\b|\buv\s+tool\s+install\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b|\bclaude\s+plugin\s+install\b|\bnpx\s+skills\s+add\b/.test(c)) return 'install';
  if (/\bgit\s+push\b|\bgh\s+(pr|issue|release)\s+(create|comment|merge|close|edit)\b|\bglab\s+mr\b|\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s)|\bwget\b.*--post|\bInvoke-WebRequest\b.*-Method\s+(Post|Put)|\bmail\b|\bsendmail\b|\bssh\b|\bscp\b|\brsync\b.*:/.test(c)) return 'send';
  return 'write_local';
}

/** Which class of action a tool call is — the policy is written per class. Unknown tools are 'send': the side that asks. */
export function classify(toolName: string, input: Record<string, unknown>): ActionClass {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write_local';
  if (name === 'Bash' || name === 'PowerShell') return classifyCommand(String(p.command ?? ''));
  if (/^web\.(search|read)$|^memory\.(search|reflect)$|^mcp__.*(search|list|get|read|fetch|find)/i.test(name)) return 'read';
  if (/^memory\.write$|^sessions\./.test(name)) return 'write_local';
  if (/delete|remove|destroy|purge|trash/i.test(name)) return 'delete';
  if (/pay|charge|checkout|purchase|order|transfer/i.test(name) || PAY_HOSTS.test(String(p.url ?? ''))) return 'pay';
  if (/^(ego_browser|browser_|web\.browser|computer[._])/.test(name) || /^mcp__web__/.test(name)) return 'browser';
  if (/install/i.test(name)) return 'install';
  return 'send';
}

export function summarize(toolName: string, input: Record<string, unknown>): string {
  const name = innerName(toolName, input);
  const p = innerParams(toolName, input);
  const key = typeof p.command === 'string' ? p.command : typeof p.file_path === 'string' ? p.file_path : typeof p.url === 'string' ? p.url : typeof p.channel === 'string' ? p.channel : JSON.stringify(p);
  return `${name}: ${String(key)}`.replace(/\s+/g, ' ').slice(0, 160);
}

export function targetOf(cls: ActionClass, toolName: string, input: Record<string, unknown>): { domain?: string; recipient?: string; channel?: string; amount?: number } {
  const p = innerParams(toolName, input);
  const text = typeof p.command === 'string' ? p.command : typeof p.url === 'string' ? p.url : '';
  const out: ReturnType<typeof targetOf> = {};
  const m = /https?:\/\/([^\s/'"]+)/.exec(text); if (m) out.domain = m[1].toLowerCase();
  if (typeof p.channel === 'string') out.channel = p.channel;
  if (typeof p.to === 'string') out.recipient = p.to; else if (typeof p.recipient === 'string') out.recipient = p.recipient;
  if (cls === 'pay') { const a = /amount[=:\s]+(\d+(?:\.\d+)?)/i.exec(text); if (a) out.amount = Number(a[1]); }
  return out;
}
