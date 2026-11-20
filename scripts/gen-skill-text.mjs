// Skill sources → TypeScript the compiled server carries (tsc does not copy .md files, and the packaged app only
// carries server/dist):
// - server/src/characters/cafe-character.md → characters/skill-text.ts
// - server/src/themes/ascii-theme.md + every web/src/themes/builtin/<id>/ → themes/skill-text.ts (the skill, and the
//   built-in themes' source so theme_get / theme_guide can show them)
// - server/src/openings/opening-pack.md + openings/example/index.html → openings/skill-text.ts
// The tests next to them fail when they differ: edit the sources, then run this.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const chars = path.join(root, 'server', 'src', 'characters');
writeFileSync(
  path.join(chars, 'skill-text.ts'),
  `// Generated from cafe-character.md by scripts/gen-skill-text.mjs — edit the .md, then run it.\nexport const SKILL_MD = ${JSON.stringify(read(path.join(chars, 'cafe-character.md')))};\n`,
);
console.log('characters/skill-text.ts written');

const themes = path.join(root, 'server', 'src', 'themes');
const builtinDir = path.join(root, 'web', 'src', 'themes', 'builtin');
const builtin = {};
for (const id of readdirSync(builtinDir).sort()) {
  const d = path.join(builtinDir, id);
  if (!existsSync(path.join(d, 'theme.json'))) continue;
  const opt = (f) => (existsSync(path.join(d, f)) ? read(path.join(d, f)) : undefined);
  builtin[id] = { json: read(path.join(d, 'theme.json')), backdrop: opt('backdrop.js'), css: opt('theme.css') };
}
writeFileSync(
  path.join(themes, 'skill-text.ts'),
  '// Generated from ascii-theme.md and web/src/themes/builtin/* by scripts/gen-skill-text.mjs — edit those, then run it.\n'
    + `export const SKILL_MD = ${JSON.stringify(read(path.join(themes, 'ascii-theme.md')))};\n`
    + '/** the built-in themes\' three files, as text */\n'
    + `export const BUILTIN_THEMES: Record<string, { json: string; backdrop?: string; css?: string }> = ${JSON.stringify(builtin)};\n`,
);
console.log(`themes/skill-text.ts written (${Object.keys(builtin).length} built-in themes)`);

// 开场动画包: the opening-pack skill and its example (opening_guide shows both)
const openings = path.join(root, 'server', 'src', 'openings');
writeFileSync(
  path.join(openings, 'skill-text.ts'),
  '// Generated from opening-pack.md and example/index.html by scripts/gen-skill-text.mjs — edit those, then run it.\n'
    + `export const SKILL_MD = ${JSON.stringify(read(path.join(openings, 'opening-pack.md')))};\n`
    + '/** the example web pack opening_guide shows (a complete index.html) */\n'
    + `export const EXAMPLE_HTML = ${JSON.stringify(read(path.join(openings, 'example', 'index.html')))};\n`,
);
console.log('openings/skill-text.ts written');
