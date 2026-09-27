// Targeted edits of other agents' config files. The rule is "change the one key the user named, leave every
// other byte alone": TOML goes through a line-level editor (smol-toml only parses / escapes — it has no
// comment-preserving writer), JSON / JSONC through jsonc-parser's modify(), which keeps comments and layout.
// Every edit re-parses its result; a mismatch throws instead of writing something half-right.
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
import * as jsonc from 'jsonc-parser';

export type ConfigFormat = 'toml' | 'json';

/** Parse a config file; blank = `{}`. Throws with the first error position on malformed input. */
export function parseConfig(text: string, format: ConfigFormat): Record<string, unknown> {
  if (!text.trim()) return {};
  if (format === 'toml') return tomlParse(text) as Record<string, unknown>;
  const errors: jsonc.ParseError[] = [];
  const v = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`JSON 解析失败：${jsonc.printParseErrorCode(errors[0].error)} @${errors[0].offset}`);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('配置文件的顶层不是对象');
  return v as Record<string, unknown>;
}

const BARE = /^[A-Za-z0-9_-]+$/;
/** A TOML key, quoted when it isn't a bare key. */
export function tomlKey(k: string): string {
  return BARE.test(k) ? k : tomlString(k);
}
/** A TOML basic string literal (escaping delegated to smol-toml). */
export function tomlString(v: string): string {
  return tomlStringify({ x: v }).trim().replace(/^x\s*=\s*/, '');
}

const HEADER = /^\s*\[\[?\s*[^\]\n]+\]\]?\s*(#.*)?$/;
const blankOrComment = (l: string) => !l.trim() || l.trim().startsWith('#');

/** Stable JSON for deep comparison (key order independent). */
function canon(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`;
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return JSON.stringify(v);
}

/**
 * Set (or with `undefined`, remove) a single-line top-level `key = "value"` in a TOML document. Only the
 * line holding that key changes (its trailing comment is kept); a missing key is inserted after the last
 * top-level entry, before the first table. Throws if the key's current value spans several lines, or if the
 * result doesn't parse back to "the same document with just this key changed".
 */
export function setTomlTopLevel(text: string, key: string, value: string | undefined): string {
  const before = parseConfig(text, 'toml');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => HEADER.test(l));
  const top = firstTable < 0 ? lines.length : firstTable;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:${esc}|"${esc}"|'${esc}')\\s*=`);
  const at = lines.slice(0, top).findIndex((l) => re.test(l));
  const newLine = value === undefined ? null : `${tomlKey(key)} = ${tomlString(value)}`;
  if (at >= 0) {
    const line = lines[at];
    let single: Record<string, unknown>;
    try { single = tomlParse(line) as Record<string, unknown>; } catch { throw new Error(`${key} 的值跨多行，不能定点修改`); }
    // keep a trailing comment: the first `#` after which the line still parses to the same value
    let comment = '';
    for (let i = line.indexOf('#'); i > 0; i = line.indexOf('#', i + 1)) {
      try { if (canon((tomlParse(line.slice(0, i)) as any)[key]) === canon(single[key])) { comment = ' ' + line.slice(i).trimStart(); break; } } catch { /* # inside the value */ }
    }
    if (newLine === null) lines.splice(at, 1); else lines[at] = newLine + comment;
  } else if (newLine !== null) {
    let last = -1;
    for (let i = 0; i < top; i++) if (!blankOrComment(lines[i])) last = i;
    const ins = last + 1;
    // keep a blank line between the new key and a table header right after it
    lines.splice(ins, 0, ...(HEADER.test(lines[ins] ?? '') ? [newLine, ''] : [newLine]));
  }
  let out = lines.join(nl);
  if (out && !out.endsWith(nl)) out += nl;
  const after = parseConfig(out, 'toml');
  const expect = { ...before } as Record<string, unknown>;
  if (value === undefined) delete expect[key]; else expect[key] = value;
  if (canon(after) !== canon(expect)) throw new Error(`改写 ${key} 后文件结构不一致，已放弃`);
  return out;
}

/** Append `[a.b.c]` with string entries at the end of a TOML document (e.g. Codex `mcp_servers.<n>.http_headers`). */
export function appendTomlTable(text: string, tablePath: string[], entries: Record<string, string>): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const body = [`[${tablePath.map(tomlKey).join('.')}]`, ...Object.entries(entries).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)].join(nl);
  const base = text.replace(/\s*$/, '');
  const out = `${base}${base ? nl + nl : ''}${body}${nl}`;
  const doc = parseConfig(out, 'toml') as any; // throws on e.g. a duplicate table
  let node = doc;
  for (const k of tablePath) node = node?.[k];
  if (canon(node) !== canon(entries)) throw new Error(`追加 [${tablePath.join('.')}] 后内容不一致，已放弃`);
  return out;
}

/** Set / remove one (possibly nested) key in a JSON / JSONC document, keeping comments and formatting. */
export function setJsonPath(text: string, jsonPath: string[], value: unknown): string {
  const src = text.trim() ? text : '{}\n';
  parseConfig(src, 'json');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const edits = jsonc.modify(src, jsonPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: nl } });
  const out = jsonc.applyEdits(src, edits);
  let node: any = parseConfig(out, 'json');
  for (const k of jsonPath) node = node?.[k];
  if (canon(node) !== canon(value)) throw new Error(`改写 ${jsonPath.join('.')} 后内容不一致，已放弃`);
  return out;
}

/** Read a dotted path from a parsed document. */
export function getPath(doc: unknown, dotted: string): unknown {
  let node: any = doc;
  for (const k of dotted.split('.')) node = node && typeof node === 'object' ? node[k] : undefined;
  return node;
}
