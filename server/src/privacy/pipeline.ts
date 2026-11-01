// Request bodies out, responses back (spec 2026-10-26 §4.1). The outbound walker works on any of the four wire
// formats the gateway / shim send (Anthropic messages, OpenAI chat, Responses, Gemini): every string the user or a tool
// wrote is looked at; ids, model names, tool names / schemas, signed thinking, encrypted reasoning and media are not.
// The inbound side puts placeholders back in non-stream JSON and in SSE streams, including a placeholder cut across
// two deltas and one inside streamed tool-argument JSON.
import type http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { decoder } from './upstream.js';
import { partialTail, redactText, restoreText, type Compiled } from './detect.js';
import type { PrivacyHit } from './types.js';

/** Keys whose value is never content (structure, ids, signatures, schemas, media). */
const SKIP_KEYS = new Set([
  'model', 'id', 'type', 'role', 'name', 'object', 'tool_use_id', 'tool_call_id', 'call_id', 'item_id', 'previous_response_id',
  'signature', 'thoughtSignature', 'thought_signature', 'encrypted_content', 'redacted_content',
  'media_type', 'mime_type', 'mimeType', 'data', 'source', 'image_url', 'inlineData', 'inline_data', 'fileData', 'file_data', 'file_id', 'url', 'detail',
  'cache_control', 'tool_choice', 'tools', 'functionDeclarations', 'input_schema', 'parameters', 'response_format', 'text_format',
  'stream_options', 'generationConfig', 'safetySettings', 'toolConfig', 'thinking', 'reasoning', 'reasoning_effort', 'metadata',
  'prompt_cache_key', 'prompt_cache_retention', 'user', 'stop_reason', 'finish_reason', 'service_tier', 'include', 'truncation',
]);
/** Blocks whose content is signed / encrypted by the vendor: altering one byte breaks the next turn. */
const SIGNED_TYPES = new Set(['thinking', 'redacted_thinking', 'reasoning']);
/** Under these keys every leaf is content, whatever its key (a tool's input object has arbitrary keys). */
const CONTENT_OBJECTS = new Set(['input', 'args', 'response']);
/** Never touched, not even inside a tool's input. */
const HARD_SKIP = new Set(['signature', 'thoughtSignature', 'thought_signature', 'encrypted_content', 'redacted_content', 'data', 'id', 'tool_use_id', 'tool_call_id', 'call_id']);

export interface RedactOutcome { hits: PrivacyHit[]; changed: boolean }

/** Walk a parsed body in place. */
export function redactValue(v: any, c: Compiled, secret: Buffer, map: Map<string, string>, hits: PrivacyHit[], free = false): any {
  if (typeof v === 'string') {
    const r = redactText(v, c, secret, map);
    if (r.hits.length) hits.push(...r.hits);
    return r.text;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = redactValue(v[i], c, secret, map, hits, free);
    return v;
  }
  if (v && typeof v === 'object') {
    if (typeof v.type === 'string' && SIGNED_TYPES.has(v.type)) return v;
    if (v.thought === true && typeof v.thoughtSignature === 'string') return v;
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (HARD_SKIP.has(k) || (!free && SKIP_KEYS.has(k))) {
        // `input` / `args` objects are content even below a skipped key's sibling; a skipped key is left alone
        continue;
      }
      // OpenAI tool-call arguments: a JSON text — redacted inside, so the JSON stays valid
      if (k === 'arguments' && typeof val === 'string') {
        let parsed: any;
        try { parsed = JSON.parse(val); } catch { parsed = undefined; }
        if (parsed !== undefined && typeof parsed === 'object') {
          const before = hits.length;
          const out = redactValue(parsed, c, secret, map, hits, true);
          if (hits.length > before) v[k] = JSON.stringify(out);
          continue;
        }
      }
      // an object under input / args / response (a tool's input, a function's result) has arbitrary keys: all content
      v[k] = redactValue(val, c, secret, map, hits, free || (CONTENT_OBJECTS.has(k) && !!val && typeof val === 'object' && !Array.isArray(val)));
    }
    return v;
  }
  return v;
}

/**
 * A request body (Buffer of JSON) with its content redacted. Unchanged bytes when nothing was replaced (a relay that
 * compares the body with the official client's sees what it always saw). Not JSON → the whole text goes through.
 */
export function redactBody(body: Buffer, c: Compiled, secret: Buffer, map: Map<string, string>): { body: Buffer; hits: PrivacyHit[] } {
  const text = body.toString('utf8');
  const hits: PrivacyHit[] = [];
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (json === undefined) {
    const r = redactText(text, c, secret, map);
    return { body: r.hits.some((h) => h.action === 'redact') ? Buffer.from(r.text) : body, hits: r.hits };
  }
  const out = redactValue(json, c, secret, map, hits);
  return { body: hits.some((h) => h.action === 'redact') ? Buffer.from(JSON.stringify(out)) : body, hits };
}

/** Is this string leaf JSON text (streamed / serialized tool arguments)? */
const jsonLeaf = (path: string[], evType: string) => {
  const k = path[path.length - 1];
  return k === 'partial_json' || k === 'arguments' || (k === 'delta' && /arguments|custom_tool_call_input/.test(evType));
};

/** Placeholders back in every string of a parsed value (in place). */
export function restoreValue(v: any, map: ReadonlyMap<string, string>, path: string[] = [], evType = ''): any {
  if (typeof v === 'string') return restoreText(v, map, jsonLeaf(path, evType));
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = restoreValue(v[i], map, [...path, String(i)], evType); return v; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = restoreValue(v[k], map, [...path, k], evType); return v; }
  return v;
}

/** A whole non-stream body: JSON → every string restored; anything else → plain text replacement. */
export function restoreBody(text: string, map: ReadonlyMap<string, string>): string {
  if (!text.includes('{{')) return text;
  try { return JSON.stringify(restoreValue(JSON.parse(text), map)); } catch { return restoreText(text, map); }
}

/** String leaves of an event with their paths. */
function leaves(v: any, path: string[], out: { path: string[]; value: string }[]) {
  if (typeof v === 'string') out.push({ path, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...path, String(i)], out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) leaves(v[k], [...path, k], out);
}
const getAt = (o: any, p: string[]) => p.reduce((a, k) => (a == null ? a : a[k]), o);
const setAt = (o: any, p: string[], val: string) => { const parent = getAt(o, p.slice(0, -1)); if (parent) parent[p[p.length - 1]] = val; };

/** The slot a delta belongs to: event type + its index fields + the leaf's path (a new block is a new slot). */
const slotOf = (j: any, path: string[]) => [j?.type ?? '', j?.index ?? '', j?.output_index ?? '', j?.content_index ?? '', j?.item_id ?? '', path.join('.')].join('|');

/**
 * SSE text in, SSE text out with placeholders restored. A data event whose content ends in what may be the start of a
 * placeholder is held back until the next event of the same slot, and the two texts are joined there; anything else
 * arriving first flushes it as it was (a cut placeholder then stays a placeholder — never a wrong value).
 */
export class SseRestorer {
  private buf = '';
  private held: { pre: string; j: any; path: string[]; nl: string } | null = null;
  constructor(private map: ReadonlyMap<string, string>) {}

  feed(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const ev = this.buf.slice(0, m.index);
      const sep = m[0];
      this.buf = this.buf.slice(m.index + sep.length);
      out += this.event(ev, sep);
    }
    return out;
  }

  end(): string {
    let out = '';
    if (this.buf) { out += this.event(this.buf, ''); this.buf = ''; }
    return out + this.flush();
  }

  private flush(): string {
    if (!this.held) return '';
    const h = this.held;
    this.held = null;
    return this.render(h.pre, h.j, h.nl);
  }

  private render(pre: string, j: any, sep: string): string {
    return `${pre}data: ${JSON.stringify(restoreValue(j, this.map, [], String(j?.type ?? '')))}${sep}`;
  }

  private event(raw: string, sep: string): string {
    const lines = raw.split(/\r?\n/);
    const di = lines.findIndex((l) => l.startsWith('data:'));
    // only single-line JSON data events are touched; comments, [DONE] and the like go as they came
    if (di < 0 || lines.filter((l) => l.startsWith('data:')).length !== 1) return this.flush() + raw + sep;
    const data = lines[di].slice(5).replace(/^ /, '');
    let j: any;
    try { j = JSON.parse(data); } catch { return this.flush() + raw + sep; }
    const pre = lines.slice(0, di).map((l) => `${l}\n`).join('');
    const post = lines.slice(di + 1);
    const nl = (post.length ? `\n${post.join('\n')}` : '') + (sep || '\n\n');
    const ls: { path: string[]; value: string }[] = [];
    leaves(j, [], ls);
    let out = '';
    if (this.held) {
      const slot = slotOf(this.held.j, this.held.path);
      const same = ls.find((l) => slotOf(j, l.path) === slot);
      if (same) {
        setAt(j, same.path, String(getAt(this.held.j, this.held.path)) + same.value);
        same.value = String(getAt(j, same.path));
        this.held = null;
      } else out += this.flush();
    }
    if (!raw.includes('{') && !this.held) return out + raw + sep;
    const tail = ls.find((l) => partialTail(l.value) >= 0);
    if (tail) { this.held = { pre, j, path: tail.path, nl }; return out; }
    if (!ls.some((l) => l.value.includes('{{'))) return out + `${pre}data: ${JSON.stringify(j)}${nl}`;
    return out + this.render(pre, j, nl);
  }
}

/**
 * Restore what a handler writes to `res`: hooks writeHead / write / end. `stream` = the request asked for a stream;
 * the response's content type still decides (an error comes back as JSON). A compressed answer (a passthrough whose
 * upstream ignored accept-encoding: identity) is decoded first and goes out uncompressed.
 */
export function restoreResponse(res: http.ServerResponse, map: ReadonlyMap<string, string>, stream: boolean): void {
  if ((res as any).cwRestoring) return;
  (res as any).cwRestoring = true;
  const origWriteHead = res.writeHead.bind(res) as (...a: any[]) => http.ServerResponse;
  const origWrite = res.write.bind(res) as (...a: any[]) => boolean;
  const origEnd = res.end.bind(res) as (...a: any[]) => http.ServerResponse;
  let mode: 'sse' | 'whole' = 'whole';
  let sse: SseRestorer | null = null;
  let whole = '';
  const dec = new StringDecoder('utf8');
  let z: import('node:stream').Transform | null = null;
  let zDone: Promise<void> | null = null;
  const take = (text: string): string => (mode === 'sse' ? sse!.feed(text) : ((whole += text), ''));
  const finish = (): string => (mode === 'sse' ? sse!.feed(dec.end()) + sse!.end() : restoreBody(whole + dec.end(), map));

  (res as any).writeHead = (status: number, ...rest: any[]) => {
    const headers: Record<string, any> = { ...(typeof rest[0] === 'object' ? rest[0] : rest[1] ?? {}) };
    const ct = String(Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '');
    mode = /event-stream/i.test(ct) || (stream && !/json/i.test(ct)) ? 'sse' : 'whole';
    if (mode === 'sse') sse = new SseRestorer(map);
    for (const k of Object.keys(headers)) {
      const l = k.toLowerCase();
      if (l === 'content-length') delete headers[k];
      if (l === 'content-encoding') {
        z = decoder(String(headers[k]));
        delete headers[k];
      }
    }
    if (z) {
      const zz = z as import('node:stream').Transform;
      zz.on('data', (d: Buffer) => { const o = take(dec.write(d)); if (o) origWrite(o); });
      zDone = new Promise((r) => { zz.on('end', () => r()); zz.on('error', () => r()); });
    }
    return origWriteHead(status, headers);
  };
  (res as any).write = (chunk: any, ...rest: any[]) => {
    if (chunk === undefined || chunk === null) return true;
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    if (z) { (z as any).write(b); return true; }
    const o = take(dec.write(b));
    if (o) return origWrite(o, ...rest.filter((x) => typeof x === 'function'));
    return true;
  };
  (res as any).end = (chunk?: any, ...rest: any[]) => {
    if (typeof chunk === 'function') { rest = [chunk]; chunk = undefined; }
    if (chunk !== undefined && chunk !== null) (res as any).write(chunk);
    if (z && zDone) {
      (z as any).end();
      void zDone.then(() => { const o = finish(); origEnd(o || undefined); });
      return res;
    }
    const o = finish();
    return origEnd(o || undefined);
  };
}
