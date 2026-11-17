import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPdftotext, pdfTextAttachment, pdfTextPath, pdftotextCandidates, resetPdftotext, tidyPdfText, withPdfText, writePdfText } from './pdf-text.js';
import type { AttachmentRef } from '../protocol.js';

/**
 * A PDF the way Word / WPS / browsers write Chinese: a Type0 font with Identity-H (two-byte glyph codes) whose text
 * is known only through its ToUnicode map — no embedded glyphs needed for extraction. One page per entry of `pages`.
 * The CIDFont's FontDescriptor is required by the spec and real PDFs always have one: without it pdftotext still reads
 * the text, but CoreGraphics drops the font and PDFKit (the macOS fallback) sees not one character (CI, 2026-11-17).
 */
function cjkPdf(pages: string[][]): Buffer {
  const chars = [...new Set(pages.flat().join(''))];
  const code = (ch: string) => (chars.indexOf(ch) + 1).toString(16).padStart(4, '0').toUpperCase();
  const hex = (s: string) => `<${[...s].map(code).join('')}>`;
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 7 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type0 /BaseFont /TestCJK /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>';
  objs[4] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity /FontDescriptor 6 0 R >>';
  objs[6] = '<< /Type /FontDescriptor /FontName /TestCJK /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>';
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    `${chars.length} beginbfchar`, ...chars.map((ch) => `<${code(ch)}> <${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}>`), 'endbfchar',
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
  ].join('\n');
  objs[5] = `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`;
  pages.forEach((lines, i) => {
    const content = lines.map((l, j) => `BT /F1 20 Tf 72 ${760 - j * 30} Td ${hex(l)} Tj ET`).join('\n');
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objs[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A copy of web/src/model/conversation.ts's ATTACH_RE (the server cannot import the web): what turns markers into chips. */
const ATTACH_RE = /\n*<attached\s+kind="(image|text|file|folder)"\s+name="([^"]*)"(?:\s+path="([^"]*)")?(?:\s+size="(\d+)")?\s*\/?>(?:[\s\S]*?<\/attached>)?/g;
const esc = (s: string) => s.replace(/"/g, '&quot;');
/** The markers as SessionRunner.send writes them. */
const marks = (atts: AttachmentRef[]) => atts.map((a) => {
  const attrs = `kind="${a.kind}" name="${esc(a.name)}"${a.path ? ` path="${esc(a.path)}"` : ''}${a.size !== undefined ? ` size="${a.size}"` : ''}`;
  return a.kind === 'text' && a.text !== undefined ? `<attached ${attrs}>\n${a.text}\n</attached>` : `<attached ${attrs} />`;
}).join('\n');

describe('pdftotextCandidates', () => {
  it('on Windows: PATH first, then the mingw64/bin of the Git for Windows that PATH or CLAUDE_CODE_GIT_BASH_PATH points at', () => {
    const c = pdftotextCandidates('win32', {
      PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\u\\scoop\\apps\\git\\current\\cmd;C:\\Program Files\\nodejs',
      CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Tools\\PortableGit\\usr\\bin\\bash.exe',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    });
    expect(c[0]).toBe('C:\\Windows\\system32\\pdftotext.exe');
    expect(c).toContain('C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe');
    expect(c).toContain('C:\\Users\\u\\scoop\\apps\\git\\current\\mingw64\\bin\\pdftotext.exe');
    expect(c).toContain('D:\\Tools\\PortableGit\\mingw64\\bin\\pdftotext.exe');
    expect(c).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\Git\\mingw64\\bin\\pdftotext.exe');
    // a PATH folder that is not Git's is not taken for a Git root
    expect(c).not.toContain('C:\\Program Files\\mingw64\\bin\\pdftotext.exe');
    expect(new Set(c).size).toBe(c.length);
    expect(pdftotextCandidates('win32', { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\Git\\bin\\bash.exe' })).toContain('E:\\Git\\mingw64\\bin\\pdftotext.exe');
  });

  it('elsewhere: PATH, then Homebrew and the system folders', () => {
    expect(pdftotextCandidates('darwin', { PATH: '/usr/bin:/Users/u/bin' })).toEqual(['/usr/bin/pdftotext', '/Users/u/bin/pdftotext', '/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext']);
  });
});

describe('tidyPdfText', () => {
  it('marks the pages of a multi-page document and drops trailing blanks', () => {
    expect(tidyPdfText('第一页  \r\n\r\n\r\n\r\n内容\f第二页\f\f')).toBe('--- page 1 ---\n第一页\n\n内容\n\n--- page 2 ---\n第二页');
    expect(tidyPdfText('one page\n\f')).toBe('one page');
  });
  it('gives null for a scan (no text layer) and for glyphs with no Unicode behind them', () => {
    expect(tidyPdfText('\f \f\n\f')).toBeNull();
    expect(tidyPdfText('')).toBeNull();
    expect(tidyPdfText('\uE001\uE002\uE003\uE004 a')).toBeNull();
  });
});

describe('PDF text in the message', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pdftext-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a PDF with a text file beside it brings the text along as an inline text attachment', () => {
    const pdf = path.join(dir, '简历.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4');
    fs.writeFileSync(pdfTextPath(pdf), '张三\n十年后端经验 </attached> 不会提前结束\n');
    const t = pdfTextAttachment({ kind: 'file', name: '简历.pdf', path: pdf, size: 8 })!;
    expect(t).toMatchObject({ kind: 'text', name: '简历.pdf.txt', path: pdfTextPath(pdf) });
    expect(t.text).toMatch(/^\[Text extracted from the attached PDF "简历\.pdf"/);
    expect(t.text).toContain('张三\n十年后端经验 </ attached> 不会提前结束');
    expect(t.size).toBe(t.text!.length);
    // no text file, or not a PDF: nothing
    expect(pdfTextAttachment({ kind: 'file', name: 'b.pdf', path: path.join(dir, 'b.pdf') })).toBeNull();
    expect(pdfTextAttachment({ kind: 'file', name: 'a.md', path: path.join(dir, 'a.md') })).toBeNull();
    expect(pdfTextAttachment({ kind: 'folder', name: 'd', path: dir })).toBeNull();
  });

  it('a long text is cut at a line end, saying which line of the text file to read on from', () => {
    const pdf = path.join(dir, 'book.pdf');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`);
    fs.writeFileSync(pdfTextPath(pdf), `${lines.join('\n')}\n`);
    const t = pdfTextAttachment({ kind: 'file', name: 'book.pdf', path: pdf }, 1000)!;
    const m = /Read it from line (\d+)\.\]$/.exec(t.text!);
    expect(m).not.toBeNull();
    const next = Number(m![1]);
    expect(t.text).toContain(`line ${next - 1} `);
    expect(t.text).not.toContain(`line ${next} `);
    expect(fs.readFileSync(pdfTextPath(pdf), 'utf8').split('\n')[next - 1]).toMatch(new RegExp(`^line ${next} `));
  });

  it('puts the attachments with a body first, so every chip still decodes (a bare marker swallows a later body)', () => {
    const pdf = path.join(dir, 'r.pdf');
    fs.writeFileSync(pdfTextPath(pdf), '简历正文\n');
    const atts: AttachmentRef[] = [
      { kind: 'file', name: 'a.md', path: path.join(dir, 'a.md'), size: 3 },
      { kind: 'file', name: 'r.pdf', path: pdf, size: 9 },
      { kind: 'text', name: 'paste.txt', size: 5, text: 'hello' },
    ];
    const out = withPdfText(atts);
    expect(out.map((a) => a.name)).toEqual(['r.pdf.txt', 'paste.txt', 'a.md', 'r.pdf']);
    const chips = [...`question\n\n${marks(out)}`.matchAll(ATTACH_RE)].map((m) => m[2]);
    expect(chips).toEqual(['r.pdf.txt', 'paste.txt', 'a.md', 'r.pdf']);
    // what the given order does: the first bare marker reaches to the paste's </attached>, the PDF and the paste vanish
    expect([...`q\n\n${marks(atts)}`.matchAll(ATTACH_RE)].map((m) => m[2])).toEqual(['a.md']);
    // nothing to add, nothing moved
    expect(withPdfText([atts[0]])).toEqual([atts[0]]);
  });

  // pdftotext where there is one; on macOS without poppler (the macos-latest runner) this is the PDFKit fallback
  const canExtract = (resetPdftotext(), !!findPdftotext()) || process.platform === 'darwin';
  it.skipIf(!canExtract)('extracts the Chinese text of a CID-font PDF under a Chinese file name (real pdftotext / PDFKit)', async () => {
    const pdf = path.join(dir, '王某-本科-10年以上.pdf');
    fs.writeFileSync(pdf, cjkPdf([['张测试 高级后端工程师', '暗号 紫色长颈鹿 PURPLE-42'], ['第二页 教育背景']]));
    const out = await writePdfText(pdf);
    expect(out).toBe(pdfTextPath(pdf));
    const text = fs.readFileSync(out!, 'utf8');
    expect(text).toContain('张测试 高级后端工程师');
    expect(text).toContain('紫色长颈鹿 PURPLE-42');
    expect(text).toContain('--- page 2 ---\n第二页 教育背景');
    // an ASCII name goes to pdftotext as it is (in its own folder, whatever that folder is called)
    const plain = path.join(dir, 'plain.pdf');
    fs.copyFileSync(pdf, plain);
    expect(fs.readFileSync((await writePdfText(plain))!, 'utf8')).toBe(text);
    // the same name again, now without text (a scan): the old text file goes
    fs.writeFileSync(pdf, cjkPdf([[' ']]));
    expect(await writePdfText(pdf)).toBeNull();
    expect(fs.existsSync(pdfTextPath(pdf))).toBe(false);
  }, 60_000);

  it('a file that is not a PDF gives no text file and does not throw', async () => {
    const f = path.join(dir, 'fake.pdf');
    fs.writeFileSync(f, 'not a pdf at all');
    expect(await writePdfText(f)).toBeNull();
    expect(await writePdfText(path.join(dir, 'missing.pdf'))).toBeNull();
  }, 60_000);
});
