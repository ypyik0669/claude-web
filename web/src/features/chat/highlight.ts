// Sync syntax highlighting via lowlight (highlight.js grammars → hast) rendered with the React JSX runtime.
import { createLowlight, common } from 'lowlight';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { ReactNode } from 'react';

const lowlight = createLowlight(common);

const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', sh: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  ps1: 'powershell', psm1: 'powershell', yml: 'yaml', md: 'markdown', mdx: 'markdown', htm: 'xml', html: 'xml', svg: 'xml', vue: 'xml',
  cs: 'csharp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c', golang: 'go', dockerfile: 'dockerfile', toml: 'ini', cfg: 'ini', conf: 'ini', env: 'bash',
  jsonc: 'json', json5: 'json', txt: 'plaintext', text: 'plaintext', plain: 'plaintext', log: 'plaintext',
};

export function normalizeLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase().trim();
  const a = ALIASES[l] ?? l;
  return lowlight.registered(a) ? a : a === 'plaintext' ? 'plaintext' : undefined;
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
