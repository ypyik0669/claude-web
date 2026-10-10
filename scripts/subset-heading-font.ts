// Cuts the heading face 「CW Heading」 (UI refresh spec §4.2): Noto Serif SC 600 reduced to the characters of the
// strings in web/src/ui/heading-text.ts. Writes web/src/assets/fonts/cw-heading.woff2 and, next to it, the list of
// what is in it (cw-heading.chars.txt); web/src/ui/heading-text.test.ts holds the two against the strings.
//
//   npx tsx scripts/subset-heading-font.ts        from the repo root, after a page or a heading was renamed
//
// One source file is enough: fontsource's whole simplified-Chinese face also carries the Latin letters (the 600
// weight has all of ASCII), so nothing has to be merged — a subsetter cannot merge two fonts. The cut is read back
// before it is kept: a character the source has no glyph for stops the script, and nothing is written.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const SOURCE = '@fontsource/noto-serif-sc/files/noto-serif-sc-chinese-simplified-600-normal.woff2';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const outDir = path.join(web, 'src', 'assets', 'fonts');

// web's modules reach each other through the aliases of web/tsconfig.json (`@/…`, `@shared`): import the list the
// way web itself would, so the strings come from where they are drawn from and not from a copy
const { HEADING_STRINGS, headingChars, sfntCodePoints } = (await tsImport('./src/ui/heading-text.ts', {
  parentURL: pathToFileURL(path.join(web, 'package.json')).href,
  tsconfig: path.join(web, 'tsconfig.json'),
})) as typeof import('../web/src/ui/heading-text');

// the face and the subsetter (harfbuzz) are web's dev dependencies
const require = createRequire(path.join(web, 'package.json'));
type SubsetOptions = { targetFormat?: 'woff2' | 'truetype'; keepAllGlyphs?: boolean };
const subsetFont: (font: Buffer, text: string | undefined, o: SubsetOptions) => Promise<Buffer> = require('subset-font');

const chars = headingChars(HEADING_STRINGS);
const source = await readFile(require.resolve(SOURCE));
// The space is not in the list (it draws nothing) but the headings have it: the font carries it too. The face's
// layout features stay (kerning, the spacing of full-width punctuation): they cost about half a KB.
const font = await subsetFont(source, `${chars} `, { targetFormat: 'woff2' });

// what the file really holds: unpacked again (every glyph kept), then its character map
const held = sfntCodePoints(await subsetFont(font, undefined, { targetFormat: 'truetype', keepAllGlyphs: true }));
const missing = [...chars].filter((ch) => !held.has(ch.codePointAt(0)!));
if (missing.length) {
  console.error(`The source face has no glyph for: ${missing.join(' ')}\n(${SOURCE})\nNothing was written.`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'cw-heading.woff2'), font);
await writeFile(path.join(outDir, 'cw-heading.chars.txt'), `${chars}\n`);

const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');
console.log(`${HEADING_STRINGS.length} strings, ${[...chars].length} characters`);
console.log(chars);
console.log(`${rel(path.join(outDir, 'cw-heading.woff2'))}  ${font.length} bytes (${(font.length / 1024).toFixed(1)} KB)`);
console.log(`${rel(path.join(outDir, 'cw-heading.chars.txt'))}`);
