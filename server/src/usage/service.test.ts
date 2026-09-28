import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageService } from './service.js';
import { providerTimeline, type ProviderMark } from './timeline.js';
import type { ProviderType } from '../protocol.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-usage-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse('2026-09-28T10:00:00Z');
const line = (id: string, model: string, u: Record<string, number>, at = T0) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model, usage: u } });
function transcript(sessionId: string, lines: string[]) {
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

const profiles: Record<string, { type: ProviderType; name: string }> = { gem: { type: 'gemini', name: 'Gemini 档案' }, ds: { type: 'openai', name: 'DeepSeek 中转' } };
const sessions: Record<string, { current?: string; marks?: ProviderMark[] }> = {
  'gem-1': { current: 'gem' },
  'ds-1': { current: 'ds' },
  'gone-1': { current: 'deleted-id' },
  'sw-1': { current: 'ds', marks: [{ t: T0 + 1000, providerId: 'gem', providerName: 'Gemini 档案', fromProviderId: 'claude' }, { t: T0 + 2000, providerId: 'ds', providerName: 'DeepSeek 中转', fromProviderId: 'gem' }] },
};
const svc = new UsageService(async (sid) => { const s = sessions[sid] ?? {}; return providerTimeline(s.marks ?? [], s.current, (id) => profiles[id]); });

describe('UsageService.session', () => {
  it('Gemini-type sessions: input_tokens already includes the cached part — counted once', async () => {
    const f = transcript('gem-1', [line('m1', 'gemini-2.5-pro', { input_tokens: 20_000, output_tokens: 5, cache_read_input_tokens: 15_000 })]);
    const u = await svc.session(f);
    expect(u.total).toMatchObject({ input: 5_000, cacheRead: 15_000, output: 5 });
  });

  it('non-Claude models: cost unknown (counted apart, not $0); Claude models keep the estimate', async () => {
    const f = transcript('ds-1', [
      line('m1', 'deepseek-v4', { input_tokens: 1_000_000, output_tokens: 0 }),
      line('m2', 'claude-sonnet-4-5', { input_tokens: 1_000_000, output_tokens: 0 }),
    ]);
    const u = await svc.session(f);
    expect(u.byModel['deepseek-v4']).toMatchObject({ costUsd: 0, costUnknown: 1, turns: 1 });
    expect(u.byModel['claude-sonnet-4-5'].costUsd).toBeCloseTo(3);
    expect(u.byModel['claude-sonnet-4-5'].costUnknown).toBe(0);
    expect(u.total).toMatchObject({ turns: 2, costUnknown: 1 });
  });

  it('buckets by provider × model; sessions without a profile are the Claude account; a deleted profile is not', async () => {
    const f = transcript('ds-1', [line('m1', 'deepseek-v4', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 })]);
    expect(Object.keys((await svc.session(f)).byProvider)).toEqual(['DeepSeek 中转 · deepseek-v4']);
    const g = transcript('plain-1', [line('m1', 'claude-opus-4-5', { input_tokens: 10, output_tokens: 1 })]);
    expect(Object.keys((await svc.session(g)).byProvider)).toEqual(['Claude 账号 · claude-opus-4-5']);
    const h = transcript('gone-1', [line('m1', 'deepseek-v4', { input_tokens: 10, output_tokens: 1 })]);
    expect(Object.keys((await svc.session(h)).byProvider)).toEqual(['已删除的档案 · deepseek-v4']);
  });

  it('a session that switched profiles: each turn under the profile that answered it (and Gemini turns deduped)', async () => {
    const f = transcript('sw-1', [
      line('a', 'claude-opus-4-5', { input_tokens: 100, output_tokens: 1 }, T0 + 500),
      line('b', 'gemini-2.5-pro', { input_tokens: 1_000, output_tokens: 1, cache_read_input_tokens: 800 }, T0 + 1500),
      line('c', 'deepseek-v4', { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 450 }, T0 + 2500),
    ]);
    const u = await svc.session(f);
    expect(u.byProvider['Claude 账号 · claude-opus-4-5']).toMatchObject({ input: 100 });
    expect(u.byProvider['Gemini 档案 · gemini-2.5-pro']).toMatchObject({ input: 200, cacheRead: 800 });
    expect(u.byProvider['DeepSeek 中转 · deepseek-v4']).toMatchObject({ input: 50, cacheRead: 450 });
  });
});
