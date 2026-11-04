// Grok web (grok.com) as an OpenAI chat-completions endpoint: the pure parts. The protocol was read off
// CNFlyCat/GrokProxy (MIT) and justlovemaki/AIClient2API's grok-web provider (GPL-3.0 — read, not copied).
//
// The credential is the grok.com `sso` cookie (the user copies it from the browser). A whole Cookie header pasted
// instead also works, and then its `cf_clearance` / `__cf_bm` ride along (Cloudflare sometimes wants them, with the
// browser's User-Agent — a `ua=` part of the pasted text, see `parseCredential`).
import crypto from 'node:crypto';

export const GROK_CATALOG_ID = 'grok-web';
export const GROK_BASE = 'https://grok.com';
export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

/** Our model id → grok.com's `modeId`. */
export const GROK_MODELS: { id: string; modeId: string; reasoning?: boolean }[] = [
  { id: 'grok-4.20', modeId: 'auto', reasoning: true },
  { id: 'grok-4.20-fast', modeId: 'fast' },
  { id: 'grok-4.20-expert', modeId: 'expert', reasoning: true },
  { id: 'grok-4.20-heavy', modeId: 'heavy', reasoning: true },
  { id: 'grok-4.1-thinking', modeId: 'grok-4-1-thinking', reasoning: true },
  { id: 'grok-4.1-mini', modeId: 'grok-4-1-mini' },
];
export const modeFor = (model: string) => GROK_MODELS.find((m) => m.id === model)?.modeId ?? 'auto';

export interface GrokCredential { sso: string; cfClearance?: string; cfBm?: string; ua?: string }

/**
 * What the user pasted → the cookie parts. Accepted: the bare `sso` value; `sso=…`; a whole Cookie header
 * (`a=1; sso=…; cf_clearance=…`); any of these followed by `ua=<User-Agent>` as the last part (a User-Agent has
 * `;` in it, so everything after `ua=` is the User-Agent).
 */
export function parseCredential(raw: string): GrokCredential | null {
  let text = String(raw ?? '').trim().replace(/^cookie:\s*/i, '');
  if (!text) return null;
  let ua: string | undefined;
  const um = /(?:^|[;\r\n]\s*)(?:ua|user-agent)\s*[=:]\s*([\s\S]+)$/i.exec(text);
  if (um) { ua = um[1].replace(/\s+/g, ' ').trim(); text = text.slice(0, um.index).trim(); }
  const joined = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('; ');
  if (!/[=;]/.test(joined)) return /^[\w.\-]+$/.test(joined) ? { sso: joined, ...(ua ? { ua } : {}) } : null;
  const parts: Record<string, string> = {};
  for (const p of joined.split(';')) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k && v) parts[k] = v;
  }
  const sso = parts.sso || parts['sso-rw'];
  if (!sso) return null;
  return { sso, ...(parts.cf_clearance ? { cfClearance: parts.cf_clearance } : {}), ...(parts.__cf_bm ? { cfBm: parts.__cf_bm } : {}), ...(ua ? { ua } : {}) };
}

export function cookieHeader(c: GrokCredential): string {
  const out = [`sso=${c.sso}`, `sso-rw=${c.sso}`];
  if (c.cfClearance) out.push(`cf_clearance=${c.cfClearance}`);
  if (c.cfBm) out.push(`__cf_bm=${c.cfBm}`);
  return out.join('; ');
}

/** grok.com's own JS sends an x-statsig-id; when its probe throws it sends the error, base64 — that is what we send. */
export function statsigId(): string {
  const r = crypto.randomBytes(8).toString('base64url').replace(/[^a-z]/gi, '').slice(0, 10) || 'abcdefghij';
  return Buffer.from(`e:TypeError: Cannot read properties of undefined (reading '${r}')`).toString('base64');
}

export function grokHeaders(c: GrokCredential): Record<string, string> {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: GROK_BASE,
    referer: `${GROK_BASE}/`,
    'user-agent': c.ua || DEFAULT_UA,
    'sec-ch-ua': '"Chromium";v="143", "Google Chrome";v="143", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-statsig-id': statsigId(),
    'x-xai-request-id': crypto.randomUUID(),
    cookie: cookieHeader(c),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// OpenAI request → one grok message

type Part = { type?: string; text?: string };
interface OaiMessage { role: string; content?: string | Part[] | null; name?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]; tool_call_id?: string }
interface OaiTool { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }
export interface OaiRequest { model?: string; messages?: OaiMessage[]; stream?: boolean; tools?: OaiTool[]; tool_choice?: unknown }

const textOf = (c: OaiMessage['content']): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p?.type === 'text' || typeof p?.text === 'string' ? p.text ?? '' : p?.type === 'image_url' ? '[image]' : '')).filter(Boolean).join('\n') : '');

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';

export function toolPrompt(tools: OaiTool[]): string {
  const list = tools.filter((t) => t?.function?.name).map((t) => ({ name: t.function!.name, description: t.function!.description ?? '', parameters: t.function!.parameters ?? {} }));
  return [
    '# Tools',
    'You can call these tools. To call one, reply with one or more blocks, each exactly:',
    `${TOOL_OPEN}{"name": "<tool name>", "arguments": { ... }}${TOOL_CLOSE}`,
    'Put nothing after the last block; you will get the results in the next message. Do not invent results.',
    'Answer normally, without any block, when no tool is needed.',
    '',
    JSON.stringify(list),
  ].join('\n');
}

/** The whole conversation as the single message grok.com takes (each call is a fresh, temporary chat). */
export function flatten(req: OaiRequest): string {
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  const out: string[] = [];
  const sys = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).filter(Boolean);
  if (req.tools?.length && req.tool_choice !== 'none') sys.push(toolPrompt(req.tools));
  if (sys.length) out.push(`[system]: ${sys.join('\n\n')}`);
  const convo = msgs.filter((m) => m.role !== 'system' && m.role !== 'developer');
  // one user turn and nothing else: send it as is
  if (!out.length && convo.length === 1 && convo[0].role === 'user') return textOf(convo[0].content);
  for (const m of convo) {
    if (m.role === 'user') out.push(`[user]: ${textOf(m.content)}`);
    else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => `${TOOL_OPEN}${JSON.stringify({ name: c.function?.name ?? '', arguments: safeJson(c.function?.arguments) })}${TOOL_CLOSE}`);
      out.push(`[assistant]: ${[textOf(m.content), ...calls].filter(Boolean).join('\n')}`);
    } else if (m.role === 'tool') out.push(`[tool result${m.tool_call_id ? ` ${m.tool_call_id}` : ''}]: ${textOf(m.content)}`);
    else out.push(`[${m.role}]: ${textOf(m.content)}`);
  }
  return out.join('\n\n');
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s ?? {};
  try { return JSON.parse(s); } catch { return s; }
}

export function grokBody(req: OaiRequest): Record<string, unknown> {
  return {
    temporary: true,
    message: flatten(req),
    modeId: modeFor(String(req.model ?? '')),
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: false,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: false,
    imageGenerationCount: 0,
    forceConcise: false,
    toolOverrides: {},
    enableSideBySide: true,
    sendFinalMetadata: true,
    isReasoning: false,
    disableTextFollowUps: true,
    disableMemory: true,
    isAsyncChat: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// grok's NDJSON → deltas

export type GrokDelta = { kind: 'text' | 'thinking'; text: string } | { kind: 'error'; message: string; status?: number };

/** One line of the stream (with or without a `data:` prefix) → what it adds. */
export function parseLine(line: string): GrokDelta[] {
  let s = line.trim();
  if (s.startsWith('data:')) s = s.slice(5).trim();
  if (!s || s === '[DONE]') return [];
  let j: any;
  try { j = JSON.parse(s); } catch { return []; }
  if (j?.error) return [{ kind: 'error', message: String(j.error.message ?? j.error.code ?? JSON.stringify(j.error)), status: Number(j.error.code) || undefined }];
  const r = j?.result?.response ?? j?.result;
  if (!r) return [];
  const out: GrokDelta[] = [];
  if (typeof r.token === 'string' && r.token) out.push({ kind: r.isThinking ? 'thinking' : 'text', text: r.token });
  const urls: unknown = r.modelResponse?.generatedImageUrls;
  if (Array.isArray(urls)) for (const u of urls) if (typeof u === 'string' && u) out.push({ kind: 'text', text: `\n![image](${u.startsWith('http') ? u : `https://assets.grok.com/${u.replace(/^\//, '')}`})\n` });
  return out;
}

/** Splits the answer's text into what it says and the tool calls it made (`<tool_call>{…}</tool_call>` blocks). */
export function extractToolCalls(text: string): { content: string; calls: { id: string; name: string; arguments: string }[] } {
  const calls: { id: string; name: string; arguments: string }[] = [];
  let content = text;
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let body = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      const j = JSON.parse(body);
      if (j && typeof j.name === 'string' && j.name) {
        const args = j.arguments ?? j.parameters ?? j.input ?? {};
        calls.push({ id: `call_${crypto.randomBytes(9).toString('hex')}`, name: j.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
        content = content.replace(m[0], '');
      }
    } catch { body = ''; }
  }
  return { content: content.trim(), calls };
}

/** An HTTP failure from grok.com, in words the source card can show. */
export function grokFailure(status: number, body: string): { status: number; message: string } {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 200);
  if (status === 401) return { status: 401, message: `grok.com rejected the sso cookie (signed out or expired): ${snippet}` };
  if (status === 403) return { status: 403, message: /cloudflare|cf-|challenge|just a moment/i.test(body) ? 'grok.com: blocked by Cloudflare — paste the whole Cookie header (with cf_clearance) and ua=<your browser User-Agent>' : `grok.com refused the request (403): ${snippet}` };
  if (status === 429) return { status: 429, message: `grok.com rate limit: ${snippet}` };
  return { status: status >= 400 && status < 600 ? status : 502, message: `grok.com ${status}: ${snippet}` };
}
