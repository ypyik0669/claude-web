import type { BrowserElement } from '../protocol.js';
import { decodeEntities } from './entities.js';

/**
 * HTML → text a model can read, for pages fetched by the server (no desktop window with the built-in browser).
 * A small tokenizer rather than a DOM: no HTML parser ships with the app, and reading needs only tag names, a few
 * attributes and the text between them. What goes: scripts, styles, navigation, hidden subtrees, embedded media.
 * What stays: prose with block structure as line breaks, headings as `#`, list items as `-`, table cells separated
 * by ` | `, `<pre>` as written, and every link as a numbered element (`ref` 1, 2, …) with its absolute address.
 */
export interface ReadablePage { title: string; text: string; elements: BrowserElement[] }

/** Elements whose content is not for reading. */
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'audio', 'video', 'map', 'nav', 'select', 'datalist', 'dialog']);
/** Their content is raw text up to the closing tag: a `<` inside is not a tag. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set(['address', 'article', 'aside', 'body', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'html', 'li', 'main', 'section', 'summary', 'tbody', 'tfoot', 'thead', 'tr']);
/** Blocks that stand apart: a blank line around them. */
const PARA = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol']);

// Whitespace inside <pre> must survive the final collapse: it is held in private-use characters until then.
const PRE_SPACE = String.fromCharCode(0xe000);
const PRE_NEWLINE = String.fromCharCode(0xe001);
const PRE_TAB = String.fromCharCode(0xe002);

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** The index just past the `>` that ends the tag whose attributes start at `from` (quotes may hold a `>`); -1 when it never ends. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  // an unbalanced quote: the tag ends at the first `>` after all
  const plain = html.indexOf('>', from);
  return plain < 0 ? -1 : plain + 1;
}

/** Not shown on the page (`aria-hidden` is not this: that content is visible, only skipped by screen readers). */
function hidden(a: Record<string, string>): boolean {
  if ('hidden' in a) return true;
  return !!a.style && /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.style);
}

/** The index just past the closing tag of raw-text element `name`, searching from `from`; -1 when it is never closed. */
function closeOf(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}\\s*>`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index + m[0].length : -1;
}

export interface HtmlTextOptions { maxLinks?: number }

export function htmlToText(html: string, baseUrl?: string, opts: HtmlTextOptions = {}): ReadablePage {
  const maxLinks = opts.maxLinks ?? 400;
  let out = '';
  let title = '';
  let base = baseUrl;
  const elements: BrowserElement[] = [];
  const seenLinks = new Set<string>();
  let pre = 0;
  let preStart = false;
  /** inside a dropped subtree: its tag name and how many of that name are open */
  let skip: { name: string; depth: number } | null = null;
  let link: { href: string; at: number; fallback: string } | null = null;
  let rowHasCell = false;
  const lists: { ordered: boolean; n: number }[] = [];
  const n = html.length;

  const text = (raw: string) => {
    const t = decodeEntities(raw);
    // source line breaks are just spaces, except in <pre> (where the one right after the tag is not content)
    if (!pre) { out += t.replace(/\s+/g, ' '); return; }
    const p = t.replace(/\r\n?/g, '\n');
    out += (preStart ? p.replace(/^\n/, '') : p).replace(/ /g, PRE_SPACE).replace(/\n/g, PRE_NEWLINE).replace(/\t/g, PRE_TAB);
    preStart = false;
  };
  const closeLink = () => {
    if (!link) return;
    const name = (out.slice(link.at).replaceAll(PRE_SPACE, ' ').replaceAll(PRE_NEWLINE, ' ').replaceAll(PRE_TAB, ' ').replace(/\s+/g, ' ').trim() || link.fallback).slice(0, 200);
    const { href } = link;
    link = null;
    if (!name || elements.length >= maxLinks || seenLinks.has(href)) return;
    seenLinks.add(href);
    elements.push({ ref: String(elements.length + 1), role: 'link', name, href });
  };
  const resolve = (href: string): string | null => {
    const h = href.trim();
    if (!h || h.startsWith('#')) return null;
    try {
      const u = base ? new URL(h, base) : new URL(h);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  };
  /** A block boundary: make sure the text so far ends with `want` line breaks (1 = a new line, 2 = a blank line). */
  const brk = (want: 1 | 2) => {
    let have = 0;
    for (let k = out.length - 1; k >= 0 && have < want; k--) {
      if (out[k] === '\n') have++;
      else if (out[k] !== ' ') break;
    }
    out += '\n'.repeat(want - have);
  };
  /** Content of the raw-text element just opened at `from`, and where scanning goes on. */
  const raw = (name: string, from: number): { content: string; next: number } => {
    const e = closeOf(html, name, from);
    return e < 0 ? { content: html.slice(from), next: n } : { content: html.slice(from, html.lastIndexOf('<', e - 1)), next: e };
  };

  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { if (!skip) text(html.slice(i)); break; }
    if (lt > i && !skip) text(html.slice(i, lt));
    i = lt;
    // comments, doctype, processing instructions, CDATA
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
    if (html[i + 1] === '!' || html[i + 1] === '?') { const e = html.indexOf('>', i + 2); i = e < 0 ? n : e + 1; continue; }
    const closing = html[i + 1] === '/';
    const nameAt = i + (closing ? 2 : 1);
    const nm = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(nameAt, nameAt + 40));
    if (!nm) { if (!skip) text('<'); i += 1; continue; } // a stray `<` in text
    const name = nm[0].toLowerCase();
    const end = tagEnd(html, nameAt + nm[0].length);
    if (end < 0) break; // the document ends inside a tag
    const inner = html.slice(nameAt + nm[0].length, end - 1);
    const selfClosed = inner.trimEnd().endsWith('/');
    i = end;

    if (skip) {
      // a `</nav>` inside a script's string is not a tag
      if (!closing && RAW.has(name)) { i = raw(name, i).next; continue; }
      if (name === skip.name) {
        if (closing) { if (--skip.depth === 0) skip = null; }
        else if (!selfClosed && !VOID.has(name)) skip.depth++;
      }
      continue;
    }

    if (closing) {
      if (name === 'a') closeLink();
      else if (name === 'pre') {
        pre = Math.max(0, pre - 1);
        // the line break before </pre> is markup, not content
        if (!pre) while (out.endsWith(PRE_NEWLINE)) out = out.slice(0, -1);
        brk(2);
      }
      else if (name === 'ul' || name === 'ol') { lists.pop(); brk(2); }
      else if (PARA.has(name)) brk(2);
      else if (BLOCK.has(name)) brk(1);
      continue;
    }

    const a = attrs(inner);
    if (name === 'title') {
      const r = raw('title', i);
      if (!title) title = decodeEntities(r.content).replace(/\s+/g, ' ').trim();
      i = r.next;
      continue;
    }
    if (name === 'base') { const b = resolve(a.href ?? ''); if (b) base = b; continue; }
    if (DROP.has(name) || (hidden(a) && !VOID.has(name))) {
      if (RAW.has(name)) i = raw(name, i).next;
      else if (!selfClosed) skip = { name, depth: 1 };
      continue;
    }
    if (RAW.has(name)) {
      // textarea & co: their text is content
      const r = raw(name, i);
      text(r.content);
      i = r.next;
      continue;
    }
    switch (name) {
      case 'br': out += pre ? PRE_NEWLINE : '\n'; break;
      case 'hr': brk(2); out += '---'; brk(2); break;
      case 'img': { const alt = (a.alt ?? '').trim(); if (alt) out += ` [image: ${alt}] `; break; }
      case 'a': {
        closeLink(); // an <a> never nests: a new one ends the open one
        const href = resolve(a.href ?? '');
        if (href) link = { href, at: out.length, fallback: (a['aria-label'] ?? a.title ?? '').trim() };
        break;
      }
      case 'pre': brk(2); pre++; preStart = true; break;
      case 'ul': case 'ol': brk(2); lists.push({ ordered: name === 'ol', n: 0 }); break;
      case 'li': {
        const l = lists[lists.length - 1];
        brk(1);
        // the indent of a nested list is kept like <pre> whitespace (leading spaces are trimmed otherwise)
        out += `${(PRE_SPACE + PRE_SPACE).repeat(Math.max(0, lists.length - 1))}${l?.ordered ? `${++l.n}. ` : '- '}`;
        break;
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': brk(2); out += `${'#'.repeat(Number(name[1]))} `; break;
      case 'tr': rowHasCell = false; brk(1); break;
      case 'td': case 'th': if (rowHasCell) out += ' | '; rowHasCell = true; break;
      default:
        if (PARA.has(name)) brk(2);
        else if (BLOCK.has(name)) brk(1);
    }
  }
  closeLink();

  const body = out
    .replace(/[^\S\n]+/g, ' ') // runs of spaces (any kind but a line break) → one
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replaceAll(PRE_SPACE, ' ')
    .replaceAll(PRE_NEWLINE, '\n')
    .replaceAll(PRE_TAB, '\t');
  return { title, text: body, elements };
}
