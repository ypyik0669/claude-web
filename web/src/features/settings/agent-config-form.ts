// Pure helpers for the agent config center's MCP form: text fields → McpSpec (and back from a catalog entry).
import type { McpSpec } from '@shared';

export interface McpForm { name: string; transport: McpSpec['transport']; command: string; url: string; env: string; headers: string }

export const EMPTY_FORM: McpForm = { name: '', transport: 'stdio', command: '', url: '', env: '', headers: '' };

/** Shell-ish split: whitespace separates, "double" / 'single' quotes group, no escapes beyond that. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let cur: string | null = null;
  let last = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const piece = m[1] ?? m[2] ?? m[3];
    // `--root="a b"` stays one argument: adjacent tokens (no space between) glue together
    if (cur !== null && m.index === last) cur += piece;
    else { if (cur !== null) out.push(cur); cur = piece; }
    last = m.index + m[0].length;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** `KEY=value` (env) or `Key: value` (headers), one per line; blank lines and `#` comments skipped. */
export function parsePairs(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(sep);
    if (i <= 0) throw new Error(`「${line}」不是 ${sep === '=' ? 'KEY=value' : 'Key: value'} 形式`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function formToSpec(f: McpForm): McpSpec {
  const name = f.name.trim();
  if (!name) throw new Error('请填写名称');
  if (f.transport === 'stdio') {
    const [command, ...args] = splitArgs(f.command);
    if (!command) throw new Error('请填写启动命令');
    const env = parsePairs(f.env, '=');
    return { name, transport: 'stdio', command, args, ...(Object.keys(env).length ? { env } : {}) };
  }
  const url = f.url.trim();
  if (!url) throw new Error('请填写 URL');
  const headers = parsePairs(f.headers, ':');
  return { name, transport: f.transport, url, ...(Object.keys(headers).length ? { headers } : {}) };
}

const quote = (a: string) => (/[\s"]/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a);

/** Prefill from a Claude-style `{type, command, args, url}` catalog entry; required env keys become `KEY=` lines. */
export function formFromCatalog(id: string, json: Record<string, any>, envKeys: string[] = []): McpForm {
  const transport: McpSpec['transport'] = json.type === 'sse' ? 'sse' : json.type === 'http' || json.url ? 'http' : 'stdio';
  return {
    name: id,
    transport,
    command: transport === 'stdio' ? [json.command, ...(json.args ?? [])].filter(Boolean).map(quote).join(' ') : '',
    url: transport === 'stdio' ? '' : json.url ?? '',
    env: envKeys.map((k) => `${k}=`).join('\n'),
    headers: '',
  };
}

/** One-line description of a listed server (values are already masked by the server). */
export function describeSpec(s: McpSpec): string {
  return s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].map((a) => quote(a ?? '')).join(' ') : s.url ?? '';
}
