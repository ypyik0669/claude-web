import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttachmentRef } from '../protocol.js';

/**
 * The text of a PDF the user attached, next to it as `<file>.pdf.txt` (2026-11-17, community report: a résumé PDF
 * dragged into a conversation on a relay could not be read). Both engines' Read hands a PDF over as a base64
 * `document` block, and that only reaches a model whose API takes documents: the engine's OpenAI-format adapter
 * drops it without a word (the model gets just "PDF file read: … (62KB)"), relays that translate to another API do
 * the same, and the `pages` option renders with poppler's pdftoppm, which Windows does not have. Plain text reaches
 * every model, so the upload keeps one beside the PDF and the message carries it (`pdfTextAttachment`).
 *
 * Where the text comes from: `pdftotext` — xpdf's copy inside Git for Windows (Claude Code on Windows needs Git for
 * Windows; its mingw64/bin is not on PATH by default), poppler's elsewhere — and on macOS, PDFKit through JXA.
 * Chinese text in CID fonts comes out through the font's ToUnicode map (what Word / WPS / browsers write); a PDF
 * with no text layer (a scan) gives nothing and keeps only the PDF.
 */

/** One extraction gives up after this long (a 500-page book takes pdftotext a few seconds). */
export const PDF_TEXT_TIMEOUT_MS = 30_000;
/** PDFs bigger than this are not extracted at upload. */
export const PDF_TEXT_MAX_BYTES = 100 * 1024 * 1024;
/** At most this much of the text goes into the message; the rest is left to a Read of the text file. */
export const PDF_INLINE_CHARS = 20_000;

export const isPdfPath = (p: string): boolean => /\.pdf$/i.test(p);
/** The text file kept next to a PDF attachment. */
export const pdfTextPath = (pdf: string): string => `${pdf}.txt`;

type Env = Record<string, string | undefined>;

/**
 * Where a pdftotext may be, in the order to try. On Windows: every PATH directory, the Git for Windows that PATH's
 * git.exe (or CLAUDE_CODE_GIT_BASH_PATH's bash.exe) belongs to, and the usual Git install folders.
 */
export function pdftotextCandidates(platform: NodeJS.Platform, env: Env): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (p && !out.includes(p)) out.push(p); };
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (platform !== 'win32') {
    for (const d of [...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) add(path.posix.join(d, 'pdftotext'));
    return out;
  }
  const w = path.win32;
  for (const d of dirs) add(w.join(d, 'pdftotext.exe'));
  const roots: string[] = [];
  const bash = env.CLAUDE_CODE_GIT_BASH_PATH;
  // …\Git\bin\bash.exe or …\Git\usr\bin\bash.exe
  if (bash) { const b = w.dirname(bash); roots.push(w.basename(w.dirname(b)).toLowerCase() === 'usr' ? w.dirname(w.dirname(b)) : w.dirname(b)); }
  // …\Git\cmd (the installer's PATH entry), …\PortableGit\bin, scoop's …\apps\git\current\cmd
  for (const d of dirs) if (/[\\/][^\\/]*git[^\\/]*[\\/](?:current[\\/])?(cmd|bin)$/i.test(d)) roots.push(w.dirname(d));
  const pf = env.ProgramFiles || 'C:\\Program Files';
  roots.push(w.join(pf, 'Git'));
  if (env['ProgramFiles(x86)']) roots.push(w.join(env['ProgramFiles(x86)'], 'Git'));
  if (env.LOCALAPPDATA) roots.push(w.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  if (env.USERPROFILE) roots.push(w.join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current'));
  for (const r of roots) for (const sub of ['mingw64', 'clangarm64', 'mingw32']) add(w.join(r, sub, 'bin', 'pdftotext.exe'));
  return out;
}

let found: string | null | undefined;
/** The first pdftotext that exists (remembered once found; looked for again while there is none). */
export function findPdftotext(platform: NodeJS.Platform = process.platform, env: Env = process.env): string | null {
  if (found) return found;
  for (const c of pdftotextCandidates(platform, env)) {
    try { if (fs.statSync(c).isFile()) return (found = c); } catch { /* not there */ }
  }
  return null;
}

/** Only for tests: forget what was found. */
export function resetPdftotext(): void { found = undefined; }

/**
 * Page texts → one text: lines' trailing spaces and runs of blank lines go, and a document of several pages gets a
 * `--- page N ---` line in front of each page (so the model can say where something is). Null when nothing readable
 * is left (a scan; a font with no Unicode map that came out as control characters or private-use glyphs).
 */
export function tidyPdfText(raw: string): string | null {
  const pages = raw.replace(/\r\n?/g, '\n').split('\f')
    .map((p) => p.split('\n').map((l) => l.replace(/[ \t\u3000]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim());
  while (pages.length && !pages[pages.length - 1]) pages.pop();
  const all = pages.join('');
  const readable = (all.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const junk = (all.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000E-\u001F]/g) ?? []).length;
  if (readable === 0 || junk > readable / 2) return null;
  return pages.length > 1 ? pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join('\n\n') : pages[0];
}

const run = (cmd: string, args: string[], cwd?: string): Promise<string | null> => new Promise((resolve) => {
  execFile(cmd, args, { cwd, windowsHide: true, timeout: PDF_TEXT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
    resolve(err ? null : stdout.toString('utf8'));
  });
});

/** PDFKit's page texts, form-feed separated (macOS always has it; no pdftotext needed). */
const JXA = `function run(argv) {
  ObjC.import('Quartz');
  var d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!d || d.isNil()) return '';
  var out = [];
  for (var i = 0; i < d.pageCount; i++) { var s = d.pageAtIndex(i).string; out.push(s && !s.isNil() ? s.js : ''); }
  return out.join('\\f');
}`;

/**
 * The raw text of a PDF, or null (no tool for it here, a scan, a password, a timeout…). xpdf's pdftotext on Windows
 * opens its file through the ANSI code page — a Chinese name on an English Windows is "Couldn't open file" — so it
 * is given a relative name in its working directory, and a copy under an ASCII name when the file's own name is not.
 */
export async function pdfRawText(file: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const exe = findPdftotext(platform);
  if (exe) {
    const name = path.basename(file);
    if (platform !== 'win32' || /^[\x20-\x7e]+$/.test(name)) {
      const t = await run(exe, ['-q', '-enc', 'UTF-8', platform === 'win32' ? name : file, '-'], platform === 'win32' ? path.dirname(file) : undefined);
      if (t !== null) return t;
    } else {
      const tmp = path.join(os.tmpdir(), `cw-pdf-${randomBytes(6).toString('hex')}.pdf`);
      try {
        await fs.promises.copyFile(file, tmp);
        const t = await run(exe, ['-q', '-enc', 'UTF-8', path.basename(tmp), '-'], path.dirname(tmp));
        if (t !== null) return t;
      } catch { /* fall through */ } finally {
        fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
    }
  }
  if (platform === 'darwin') return run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA, file]);
  return null;
}

/**
 * Extract a PDF attachment's text into `<pdf>.txt`; returns that path, or null when there is no usable text (an
 * old text file of an earlier upload under the same name is removed then). Never throws.
 */
export async function writePdfText(pdf: string): Promise<string | null> {
  const out = pdfTextPath(pdf);
  try {
    const st = await fs.promises.stat(pdf);
    const text = st.size > 0 && st.size <= PDF_TEXT_MAX_BYTES ? tidyPdfText((await pdfRawText(pdf)) ?? '') : null;
    if (text) { await fs.promises.writeFile(out, `${text}\n`); return out; }
  } catch { /* no text then */ }
  await fs.promises.rm(out, { force: true }).catch(() => {});
  return null;
}

/**
 * The text kept next to an attached PDF, as an inline text attachment for the message: a line saying what it is and
 * where the PDF is, then the text, cut at a line end past `PDF_INLINE_CHARS` with where to read on. Null when the
 * attachment is not a PDF or has no text file. The words are for the model (the web UI shows a chip, not the body).
 */
export function pdfTextAttachment(a: AttachmentRef, max = PDF_INLINE_CHARS): AttachmentRef | null {
  if (a.kind !== 'file' || !a.path || !isPdfPath(a.path)) return null;
  const file = pdfTextPath(a.path);
  let text: string;
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) return null;
    text = fs.readFileSync(file, 'utf8').trimEnd();
  } catch { return null; }
  if (!text) return null;
  let body = text;
  let tail = '';
  if (text.length > max) {
    const cut = text.lastIndexOf('\n', max);
    const atLineEnd = cut > max / 2;
    body = text.slice(0, atLineEnd ? cut : max);
    const line = body.split('\n').length + (atLineEnd ? 1 : 0);
    tail = `\n[That is the first ${body.length} of ${text.length} characters. The rest is in ${file}: Read it from line ${line}.]`;
  }
  // a literal closing tag inside the text would end the attachment early for whoever decodes it
  body = body.replace(/<\/attached>/gi, '</ attached>');
  const head = `[Text extracted from the attached PDF "${a.name}" so that any model can read it. Layout, pictures and scanned pages are not in it; if those matter, Read the PDF itself, whole (its pages option needs poppler's pdftoppm, usually missing on Windows).]`;
  const full = `${head}\n${body}${tail}`;
  return { kind: 'text', name: path.basename(file), path: file, size: full.length, text: full };
}

/**
 * The attachments as they go into a message: each PDF with its text right after it, and every attachment that has a
 * body (inline text) ahead of the ones that do not. The order matters to the web UI's marker pattern: a body-less
 * `<attached … />` followed later by a `</attached>` is read as reaching to it, which hides the attachments between.
 */
export function withPdfText(atts: AttachmentRef[]): AttachmentRef[] {
  const body: AttachmentRef[] = [];
  const bare: AttachmentRef[] = [];
  for (const a of atts) {
    (a.kind === 'text' && a.text !== undefined ? body : bare).push(a);
    const t = pdfTextAttachment(a);
    if (t) body.push(t);
  }
  return [...body, ...bare];
}
