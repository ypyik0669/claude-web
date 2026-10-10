/**
 * HTML character references → text. Result pages and the fallback reader only need the references that show up in
 * prose; an unknown name is left as it was written (a browser does the same for one it does not know).
 * Invisible characters are written as escapes on purpose (never as literals in source).
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  // the spaces all read as a plain space: the text is for a model, not for layout
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  middot: '·', bull: '•', hellip: '…', ndash: '–', mdash: '—', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', prime: '′', Prime: '″',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ',
  iexcl: '¡', iquest: '¿', szlig: 'ß', ne: '≠', le: '≤', ge: '≥', infin: '∞',
  // joiners, direction marks, the soft hyphen: nothing to read
  zwnj: '', zwj: '', lrm: '', rlm: '', shy: '',
};

function codePoint(n: number): string {
  // NUL, surrogates and anything past the last plane are not characters: the replacement character, as HTML says
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return String.fromCodePoint(n);
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, body: string) => {
    if (body[0] === '#') return codePoint(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
    return NAMED[body] ?? whole;
  });
}

/** Markup inside a title / snippet → its text, on one line (`\s` covers the no-break space). */
export function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
