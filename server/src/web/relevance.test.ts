import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverage, queryTokens, relevance } from './relevance.js';
import { parseBing } from './engines/bing.js';
import { parseDuckDuckGo } from './engines/duckduckgo.js';

const hit = (title: string, url = 'https://e.example/', snippet = '') => ({ title, url, snippet });
const fixture = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', name), 'utf8');

describe('queryTokens', () => {
  it('Latin words and numbers as written, without filler words and search operators', () => {
    expect(queryTokens('How to use the Node.js stream API in v22.1?')).toEqual(['use', 'node.js', 'stream', 'api', 'v22.1']);
    // a one-letter word (`c++` without its signs) says too little to judge by
    expect(queryTokens('site:github.com "exact phrase" c++ c# -legacy')).toEqual(['github.com', 'exact', 'phrase', 'legacy']);
    expect(queryTokens('a I x')).toEqual([]); // nothing to judge by
    expect(queryTokens('ERR_MODULE_NOT_FOUND in ESM.')).toEqual(['err_module_not_found', 'esm']); // an identifier stays whole
  });
  it('CJK text as overlapping pairs (there are no spaces to split on)', () => {
    expect(queryTokens('提示缓存 怎么用')).toEqual(['提示', '示缓', '缓存', '怎么', '么用']);
    expect(queryTokens('TypeScript 5.9 发布说明')).toEqual(['typescript', '5.9', '发布', '布说', '说明']);
    expect(queryTokens('猫')).toEqual(['猫']);
    expect(queryTokens('Rust 所有権 わかりやすく')).toContain('所有');
  });
});

describe('relevance', () => {
  it('results that know the query are ok', () => {
    const hits = [hit('vitest-fetch-mock - npm', 'https://www.npmjs.com/package/vitest-fetch-mock', 'Vitest mock for fetch'), hit('Mocking | Guide | Vitest', 'https://vitest.dev/guide/mocking')];
    expect(relevance('vitest mock fetch example', hits)).toBe('ok');
    expect(coverage(queryTokens('vitest mock fetch example'), hits)).toBe(3);
  });

  it('what Bing gave this app for real queries is told apart (2026-10-10)', () => {
    // nothing to do with the query at all
    expect(relevance('vitest mock fetch example', [hit('Urus storan anda dalam Drive, Gmail & Photos - Google Help', 'https://support.google.com/mail/answer/6374270?hl=ms', 'Storan Google anda dikongsi')])).toBe('unrelated');
    expect(relevance('electron titleBarOverlay height', [hit('WhatsApp Web', 'https://web.whatsapp.com/'), hit('Google', 'https://www.google.com/')])).toBe('unrelated');
    // only the first word
    expect(relevance('sqlite fts5 trigram tokenizer chinese', [hit('SQLite Home Page', 'https://sqlite.org/index.html'), hit('SQLite Download Page', 'https://sqlite.org/download.html')])).toBe('weak');
    expect(relevance('tokio select cancel safety', [hit('Tokio Marine Malaysia | Life and General Insurance', 'https://www.tokiomarine.com/my/en.html')])).toBe('weak');
    expect(relevance('TypeScript 5.9 发布说明', [hit('TypeScript: JavaScript With Syntax For Types', 'https://www.typescriptlang.org/')])).toBe('weak');
    // …and the real page behind the Bing fixture: "node.js stream backpressure" answered with the Node.js home page
    const bing = parseBing(fixture('bing.html')).results;
    expect(relevance('node.js stream backpressure', bing)).toBe('weak');
    // DuckDuckGo's page for the same query is about it
    expect(relevance('node.js stream backpressure', parseDuckDuckGo(fixture('duckduckgo.html')).results)).toBe('ok');
  });

  it('is lenient where it cannot know better', () => {
    // a short query: one word found is all there is to find
    expect(relevance('vitest mocking', [hit('Vitest | Next Generation testing framework', 'https://vitest.dev/')])).toBe('ok');
    // no usable words, no results: not for this check to say
    expect(relevance('a', [hit('anything')])).toBe('ok');
    expect(relevance('vitest mock fetch', [])).toBe('ok');
    // a word found only in the address, or percent-encoded there
    expect(relevance('提示缓存', [hit('Prompt caching', 'https://docs.example/zh/%E6%8F%90%E7%A4%BA%E7%BC%93%E5%AD%98')])).toBe('ok');
    expect(relevance('zod discriminatedUnion migration', [hit('Migration guide', 'https://zod.dev/v4/changelog#discriminatedunion')])).toBe('ok');
    // case does not matter
    expect(relevance('ASYNCIO Gather', [hit('asyncio.gather() explained')])).toBe('ok');
  });
});
