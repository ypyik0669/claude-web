import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { expandSessionRefs, seedCanonical } from './briefing.js';
import { CanonicalLog } from '../session/canonical.js';

const sdk = {
  user: (text: string) => ({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text }] } }),
  assistantText: (text: string) => ({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  result: (extra: Record<string, unknown> = {}) => ({ type: 'result', duration_ms: 500, usage: { input_tokens: 5, output_tokens: 5 }, ...extra }),
};

describe('expandSessionRefs', () => {
  it('returns the text unchanged when there is no marker', async () => {
    const out = await expandSessionRefs('just a normal message, nothing to see', async () => {
      throw new Error('should not be called');
    });
    expect(out).toBe('just a normal message, nothing to see');
  });

  it('expands a readable reference into a briefing and a failing one into an error tag, leaving the rest of the text intact', async () => {
    const text =
      'before ' +
      '<session-ref id="codex-abc" title="修一下登录" /> ' +
      'middle ' +
      '<session-ref id="opencode-xyz" title="别的会话" /> ' +
      'after';

    const readAll = async (id: string) => {
      if (id === 'codex-abc') return [sdk.user('把登录改成 OAuth 流程'), sdk.assistantText('好了'), sdk.result()];
      throw new Error('磁盘上找不到那份记录');
    };

    const out = await expandSessionRefs(text, readAll);

    expect(out).toContain('before');
    expect(out).toContain('middle');
    expect(out).toContain('after');
    expect(out).toContain('<referenced-session id="codex-abc" title="修一下登录">');
    expect(out).toContain('把登录改成 OAuth 流程');
    expect(out).toContain('</referenced-session>');
    expect(out).toContain('<referenced-session id="opencode-xyz" title="别的会话" error="无法读取');
    expect(out).not.toContain('<session-ref ');
  });

  it('unescapes the title attribute and tolerates attribute order', async () => {
    const text = '<session-ref title="A &amp; &quot;B&quot;" id="codex-1" />';
    const readAll = async () => [sdk.user('hi'), sdk.result()];
    const out = await expandSessionRefs(text, readAll);
    expect(out).toContain('id="codex-1"');
    expect(out).toContain('title="A &amp; &quot;B&quot;"');
  });
});

describe('seedCanonical', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.CLAUDE_WEB_DIR;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-briefing-'));
    process.env.CLAUDE_WEB_DIR = dir;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.CLAUDE_WEB_DIR;
    else process.env.CLAUDE_WEB_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  });

  it('observes each native message into the canonical log and settles before returning', async () => {
    const canonical = new CanonicalLog();
    await canonical.ensure('sid-1', '/repo');
    await seedCanonical(canonical, 'sid-1', [sdk.user('把登录改成 OAuth'), sdk.assistantText('好了'), sdk.result()]);
    const events = await canonical.load('sid-1');
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant', 'result']);
  });
});
