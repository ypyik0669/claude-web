// Sync syntax highlighting via lowlight (highlight.js grammars → hast) rendered with the React JSX runtime.
// A curated grammar set instead of `common` keeps ~90 KB out of the main bundle; unknown languages fall back to plain text.
import { createLowlight } from 'lowlight';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { ReactNode } from 'react';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import diff from 'highlight.js/lib/languages/diff';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import swift from 'highlight.js/lib/languages/swift';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import makefile from 'highlight.js/lib/languages/makefile';
import plaintext from 'highlight.js/lib/languages/plaintext';

const lowlight = createLowlight({ javascript, typescript, python, bash, powershell, json, xml, css, scss, markdown, yaml, ini, diff, sql, go, rust, java, kotlin, c, cpp, csharp, php, ruby, swift, dockerfile, makefile, plaintext });

const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', kts: 'kotlin', sh: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  ps1: 'powershell', psm1: 'powershell', yml: 'yaml', md: 'markdown', mdx: 'markdown', htm: 'xml', html: 'xml', svg: 'xml', vue: 'xml', xaml: 'xml',
  cs: 'csharp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c', golang: 'go', toml: 'ini', cfg: 'ini', conf: 'ini', env: 'bash',
  jsonc: 'json', json5: 'json', txt: 'plaintext', text: 'plaintext', plain: 'plaintext', log: 'plaintext', patch: 'diff', less: 'scss',
};

export function normalizeLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase().trim();
  const a = ALIASES[l] ?? l;
  return lowlight.registered(a) ? a : undefined;
}

/** Guess a highlight language from a file path. */
export function langFromPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const base = p.replace(/\\/g, '/').split('/').pop() ?? '';
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  if (/^makefile$/i.test(base)) return 'makefile';
  if (/^(\.env|\.gitignore|\.npmrc)$/i.test(base)) return 'bash';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return normalizeLang(ext);
}

export const HIGHLIGHT_MAX_CHARS = 50_000;

/** Highlight `code`; returns plain text when the language is unknown or the input is too large. */
export function highlight(code: string, lang: string | undefined): ReactNode {
  if (code.length > HIGHLIGHT_MAX_CHARS) return code;
  const l = normalizeLang(lang);
  try {
    const tree = l && l !== 'plaintext' ? lowlight.highlight(l, code) : l === 'plaintext' ? null : code.length < 8000 ? lowlight.highlightAuto(code) : null;
    if (!tree) return code;
    return toJsxRuntime(tree as any, { Fragment, jsx, jsxs } as any);
  } catch {
    return code;
  }
}

export function detectLang(code: string): string | undefined {
  if (code.length > 8000) return undefined;
  try {
    const r = lowlight.highlightAuto(code);
    return (r.data as any)?.language;
  } catch {
    return undefined;
  }
}
