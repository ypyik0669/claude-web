import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageService } from './service.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-usage-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const line = (id: string, model: string, u: Record<string, number>) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model, usage: u } });
function transcript(sessionId: string, lines: string[]) {
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

describe('UsageService.session', () => {
  const svc = new UsageService((sid) => (sid === 'gem-1' ? { type: 'gemini', name: 'Gemini 档案' } : sid === 'ds-1' ? { type: 'openai', name: 'DeepSeek 中转' } : undefined));

  it('Gemini-type sessions: input_tokens already includes the cached part — counted once', async () => {
    const f = transcript('gem-1', [line('m1', 'gemini-2.5-pro', { input_tokens: 20_000, output_tokens: 5, cache_read_input_tokens: 15_000 })]);
    const u = await svc.session(f);
    expect(u.total).toMatchObject({ input: 5_000, cacheRead: 15_000, output: 5 });
  });

  it('non-Claude models cost 0 (no Sonnet price as a fallback); Claude models keep the estimate', async () => {
    const f = transcript('ds-1', [
      line('m1', 'deepseek-v4', { input_tokens: 1_000_000, output_tokens: 0 }),
      line('m2', 'claude-sonnet-4-5', { input_tokens: 1_000_000, output_tokens: 0 }),
    ]);
    const u = await svc.session(f);
    expect(u.byModel['deepseek-v4'].costUsd).toBe(0);
    expect(u.byModel['claude-sonnet-4-5'].costUsd).toBeCloseTo(3);
  });

  it('buckets by provider × model; sessions without a profile are the Claude account', async () => {
    const f = transcript('ds-1', [line('m1', 'deepseek-v4', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 })]);
    expect(Object.keys((await svc.session(f)).byProvider)).toEqual(['DeepSeek 中转 · deepseek-v4']);
    const g = transcript('plain-1', [line('m1', 'claude-opus-4-5', { input_tokens: 10, output_tokens: 1 })]);
    expect(Object.keys((await svc.session(g)).byProvider)).toEqual(['Claude 账号 · claude-opus-4-5']);
  });
});
