import { describe, expect, it } from 'vitest';
import { SseLines, fixChatUsage, insertTopLevelField } from './cache.js';

describe('insertTopLevelField', () => {
  it('adds the field and leaves every other byte alone', () => {
    const raw = '{"model":"deepseek-v4",  "messages":[{"role":"user","content":"hi"}],"stream":true}';
    const out = insertTopLevelField(raw, 'prompt_cache_key', 'cw:s1')!;
    expect(out).toBe('{"prompt_cache_key":"cw:s1","model":"deepseek-v4",  "messages":[{"role":"user","content":"hi"}],"stream":true}');
    expect(out.replace('"prompt_cache_key":"cw:s1",', '')).toBe(raw);
    expect(insertTopLevelField(' {}', 'k', 1)).toBe(' {"k":1}');
    expect(insertTopLevelField('[1]', 'k', 1)).toBeNull();
  });
});

describe('fixChatUsage', () => {
  it('DeepSeek / Kimi top-level hit → prompt_tokens_details.cached_tokens (what ccb reads)', () => {
    const ds: any = { prompt_tokens: 20_000, prompt_cache_hit_tokens: 15_000, prompt_cache_miss_tokens: 5_000 };
    expect(fixChatUsage(ds)).toBe(true);
    expect(ds.prompt_tokens_details).toEqual({ cached_tokens: 15_000 });
    const kimi: any = { prompt_tokens: 100, cached_tokens: 60, prompt_tokens_details: { audio_tokens: 0 } };
    expect(fixChatUsage(kimi)).toBe(true);
    expect(kimi.prompt_tokens_details).toEqual({ audio_tokens: 0, cached_tokens: 60 });
  });
  it('already there / nothing to add → untouched', () => {
    expect(fixChatUsage({ prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 5 })).toBe(false);
    expect(fixChatUsage({ prompt_tokens: 1 })).toBe(false);
    expect(fixChatUsage(undefined)).toBe(false);
  });
});

describe('SseLines', () => {
  const rw = (j: any) => fixChatUsage(j?.usage);
  it('passes lines through byte for byte except a usage line that needed fixing, across chunk splits', () => {
    const chunk1 = 'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\r\n\r\ndata: {"id":"c","choices":[],"usa';
    const chunk2 = 'ge":{"prompt_tokens":20,"prompt_cache_hit_tokens":15}}\r';
    const chunk3 = '\n\r\ndata: [DONE]\r\n\r\n';
    const s = new SseLines(rw);
    const out = s.push(chunk1) + s.push(chunk2) + s.push(chunk3) + s.end();
    expect(out).toBe('data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\r\n\r\ndata: {"id":"c","choices":[],"usage":{"prompt_tokens":20,"prompt_cache_hit_tokens":15,"prompt_tokens_details":{"cached_tokens":15}}}\r\n\r\ndata: [DONE]\r\n\r\n');
  });
  it('a usage line that is already fine is not re-serialized', () => {
    const line = 'data: {"usage" : {"prompt_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}\n\n';
    const s = new SseLines(rw);
    expect(s.push(line) + s.end()).toBe(line);
  });
});
