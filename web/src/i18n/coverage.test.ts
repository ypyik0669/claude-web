// The interface's two languages stay whole: every text in the code that a user reads is a `tr('中文')` call, and
// every one has its English. Reads the sources (scripts/i18n/scan.mjs) and the English catalogs.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AREAS, collectKeys, rawChinese, sourceFiles } from '../../../scripts/i18n/scan.mjs';
import { readCatalog } from '../../../scripts/i18n/extract.mjs';

const ROOT = path.resolve(__dirname, '../../..');
const CJK = /[㐀-鿿]/;
/** trAs('中文', 'English' … with both written out as string literals */
const TRAS = /trAs\(('[^']*'|"[^"]*"),\s*('[^']*'|"[^"]*")/g;
const ph =(s: string) => [...new Set([...s.matchAll(/\{(\w+)\??/g)].map((m) => m[1]))].sort().join(',');
const { byArea, dynamic } = collectKeys(ROOT);

describe('English catalogs', () => {
  it('every tr() call takes a text written out in the code (a computed one could not be found, or translated)', () => {
    expect(dynamic).toEqual([]);
  });

  for (const area of AREAS) {
    const keys = byArea.get(area.export)!;
    const have = readCatalog(area);
    it(`${area.export}: every text has its English`, () => {
      expect([...keys.keys()].filter((k) => !(k in have))).toEqual([]);
    });
    it(`${area.export}: no English text left for a Chinese one that is gone`, () => {
      expect(Object.keys(have).filter((k) => !keys.has(k))).toEqual([]);
    });
    it(`${area.export}: each English keeps its Chinese's {placeholders}, has no empty text and no Chinese of its own`, () => {
      const bad: string[] = [];
      for (const [k, en] of Object.entries(have)) {
        if (!en.trim()) bad.push(`empty: ${k}`);
        else if (ph(en) !== ph(k)) bad.push(`{} ${ph(k)} → ${ph(en)}: ${k.slice(0, 50)}`);
        else if ([...en].some((c) => CJK.test(c) && !k.includes(c))) bad.push(`Chinese: ${en.slice(0, 50)}`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('the Chinese is only a key once: the same text in two areas says the same in both', () => {
    const seen = new Map<string, string>();
    const bad: string[] = [];
    for (const area of AREAS) for (const [k, en] of Object.entries(readCatalog(area))) {
      if (seen.has(k) && seen.get(k) !== en) bad.push(k.slice(0, 40));
      seen.set(k, en);
    }
    expect(bad).toEqual([]);
  });
});

describe('trAs: the English written next to the Chinese', () => {
  it('has none of its own Chinese, and says the same {placeholders}', () => {
    const bad: string[] = [];
    for (const area of AREAS) for (const f of sourceFiles(path.join(ROOT, area.dir))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(TRAS)) {
        const zh = m[1].slice(1, -1), en = m[2].slice(1, -1);
        if (CJK.test(en) || ph(zh) !== ph(en)) bad.push(`${path.relative(ROOT, f)}: ${zh}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/** Words other code looks for in a message (a regex on the text), in English too — see GUIDE.md "Fixed wordings". */
describe('English texts that other code matches on', () => {
  const en = { ...readCatalog(AREAS[0]), ...readCatalog(AREAS[1]), ...readCatalog(AREAS[2]) };
  const of = (zh: string) => en[zh] ?? '';
  const startsWith = (zh: string) => Object.entries(en).filter(([k]) => k.startsWith(zh)).map(([, v]) => v);

  it('a file changed on disk, a missing project folder, a login, a timeout, a fork, the original text', () => {
    expect(startsWith('文件在磁盘上已被修改').length).toBeGreaterThan(0);
    for (const v of startsWith('文件在磁盘上已被修改')) expect(v).toMatch(/modified on disk/);
    for (const v of startsWith('找不到这个对话的项目文件夹')) expect(v).toMatch(/project folder/);
    for (const v of startsWith('对话的项目文件夹不是一个文件夹')) expect(v).toMatch(/project folder/);
    for (const v of startsWith('未登录')) expect(v).toMatch(/not logged in/i);
    expect(of('原文：')).toBe('Original: ');
    expect(of('{replace} (分叉)')).toBe('{replace} (fork)');
  });
});

/**
 * Chinese text left outside tr(): nothing a user reads may be one. The files below are the exceptions — data (names
 * of apps people say in Chinese, the pattern a regex looks for, values kept in a database, a skill that is written
 * for the model) — each with what it is.
 */
describe('no Chinese text left outside tr()', () => {
  const ALLOWED: Record<string, string> = {
    'server/src/characters/skill-text.ts': 'the cafe-character skill: a file for the model, in the language the skill is written in',
    'server/src/characters/tool-defs.ts': 'tool descriptions of the character maker (for the model)',
    'server/src/computer/apps.ts': 'the names a user gives an app, in Chinese, to find it',
    'server/src/errors/explain.ts': 'a regex that finds 「错误 404」 in a raw error',
    'server/src/memory/extract.ts': 'regexes that find decisions / constraints in a Chinese conversation',
    'server/src/memory/mcp.ts': 'the memory tool answers the model (not the screen)',
    'server/src/privacy/zhname.ts': 'Chinese surnames and name context words the privacy filter looks for in a request',
    'server/src/memory/service.ts': 'kind labels stored in memory.db',
    'server/src/runtime/thinking-language.ts': 'languages named in themselves, for the instruction to the model',
    'web/src/features/settings/ui-settings.ts': 'a language named in itself, and font names',
    'web/src/features/settings/thinking-language.ts': 'languages named in themselves (思考用的语言)',
    'desktop/src/update-policy.ts': 'a marker looked for in a release note',
    'server/src/themes/core/frames.ts': 'what is wrong with the frames of a theme, for the theme skill (the model fixes them)',
    'server/src/themes/core/pack.ts': 'what is wrong with a theme pack, for the theme skill (the model fixes it)',
    'server/src/themes/core/contrast.ts': 'the contrast a theme misses, for the theme skill',
    'server/src/themes/check.ts': 'what is wrong with a theme draft, for the theme skill',
    'server/src/themes/skill-text.ts': 'the ascii-theme skill and the built-in themes\' source, generated: a file for the model',
    'server/src/themes/tools.ts': 'the theme tools answer the model (a heading of the theme source they show)',
    'site/src/i18n/languages.ts': 'languages named in themselves (the site\'s language switch)',
  };
  const CATALOGS = AREAS.map((a) => a.catalog);

  it('the sources of the app, the server and the desktop shell', () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const area of AREAS) {
      for (const f of sourceFiles(path.join(ROOT, area.dir))) {
        const rel = path.relative(ROOT, f).split(path.sep).join('/');
        if (seen.has(rel) || CATALOGS.includes(rel) || ALLOWED[rel]) continue;
        seen.add(rel);
        for (const r of rawChinese(f, fs.readFileSync(f, 'utf8'))) bad.push(`${rel}: ${r.text.slice(0, 50)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the allowed files are still there and still have Chinese in them', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const f = path.join(ROOT, rel);
      expect(fs.existsSync(f), rel).toBe(true);
      expect(rawChinese(f, fs.readFileSync(f, 'utf8')).length, rel).toBeGreaterThan(0);
    }
  });
});
