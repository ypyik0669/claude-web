// Regression tests for the review of the gateway (pure parts: codecs, headers, failover state, agent wiring).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildOutbound, parseInbound } from './convert.js';
import { MemberStates, classify } from './failover.js';
import { acceptEncoding, errorHeaders, passthroughHeaders } from './upstream.js';
import { beforeAppServer, codexGatewayArgs, geminiApiKeyEnv, writeAtomic } from './agents.js';
import { MetaStore } from '../meta/store.js';
import { ProviderService } from '../providers/service.js';
import type { GatewayGroup } from './types.js';

describe('codecs', () => {
  it('anthropic → openai: a tool_result image goes into a user message after the text-only tool message', () => {
    const ir = parseInbound('anthropic', {
      model: 'm', max_tokens: 5,
      messages: [
        { role: 'user', content: 'shot' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_x', name: 'screenshot', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_x', content: [{ type: 'text', text: 'here' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] },
      ],
    }, { stream: false });
    const { body } = buildOutbound('openai', ir);
    const tool = body.messages.find((m: any) => m.role === 'tool');
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'call_x', content: 'here' });
    const after = body.messages[body.messages.indexOf(tool) + 1];
    expect(after).toEqual({ role: 'user', content: [{ type: 'text', text: '[tool result image for call_x]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] });
  });
  it('anthropic out keeps temperature and drops top_p when both are set', () => {
    const ir = parseInbound('openai', { model: 'm', temperature: 0.3, top_p: 0.9, messages: [{ role: 'user', content: 'x' }] }, { stream: false });
    const { body } = buildOutbound('anthropic', ir);
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBeUndefined();
    expect(buildOutbound('anthropic', { ...ir, temperature: undefined }).body.top_p).toBe(0.9);
  });
});

describe('passthrough headers', () => {
  it('credential swapped in place; Connection-listed fields dropped; order kept', () => {
    const h = passthroughHeaders(['Host', 'x', 'Authorization', 'Bearer gw', 'X-Api-Key', '', 'User-Agent', 'ua', 'Connection', 'keep-alive, X-Foo', 'X-Foo', '1', 'anthropic-beta', 'b'], 'anthropic', 'sk');
    expect(Object.keys(h)).toEqual(['Authorization', 'User-Agent', 'anthropic-beta']);
    expect(h.Authorization).toBe('Bearer sk');
    const x = passthroughHeaders(['User-Agent', 'ua', 'x-api-key', 'cwg', 'anthropic-version', 'v'], 'anthropic', 'sk');
    expect(Object.entries(x)).toEqual([['User-Agent', 'ua'], ['x-api-key', 'sk'], ['anthropic-version', 'v']]);
  });
  it('accept-encoding keeps zstd only when it can be decoded', () => {
    const v = acceptEncoding('gzip, br, zstd');
    expect(v).toBe(typeof (zlib as any).createZstdDecompress === 'function' ? 'gzip, br, zstd' : 'gzip, br');
  });
  it('error headers keep retry-after / request-id / rate limit headers', () => {
    expect(errorHeaders({ 'retry-after': '3', 'request-id': 'r1', 'anthropic-ratelimit-tokens-reset': 't', 'x-ratelimit-remaining-requests': '0', 'set-cookie': ['a'], 'content-length': '9' })).toEqual({ 'retry-after': '3', 'request-id': 'r1', 'anthropic-ratelimit-tokens-reset': 't', 'x-ratelimit-remaining-requests': '0' });
  });
});

describe('concurrent outcomes', () => {
  const g: GatewayGroup = { id: 'g', name: 'G', strategy: 'failover', members: [{ providerId: 'a' }] };
  it('several in-flight 429s count as one strike', () => {
    const s = new MemberStates();
    // three requests sent at t=0..2, all answered 429 at t=10..12
    s.fail('g', 'a', { action: 'switch', kind: 'rate', cooldownMs: 60_000 }, 429, 'rl', 10, 0);
    s.fail('g', 'a', { action: 'switch', kind: 'rate', cooldownMs: 120_000 }, 429, 'rl', 11, 1);
    s.fail('g', 'a', { action: 'switch', kind: 'rate', cooldownMs: 240_000 }, 429, 'rl', 12, 2);
    const st = s.get('g', 'a');
    expect(st.strikes).toBe(1);
    expect(st.cooldownUntil).toBe(10 + 60_000); // backoff guesses from concurrent requests do not extend it
    expect(s.order(g, 1000)).toHaveLength(0);
  });
  it('an older success finishing late does not clear a newer cooldown', () => {
    const s = new MemberStates();
    s.fail('g', 'a', { action: 'switch', kind: 'rate', cooldownMs: 60_000 }, 429, 'rl', 100, 50);
    expect(s.ok('g', 'a', 150, 10)).toBe(false); // sent at 10, before the failure was recorded
    expect(s.get('g', 'a').cooldownUntil).toBe(60_100);
    s.ok('g', 'a', 200, 120); // sent after the failure: a real recovery
    expect(s.get('g', 'a').cooldownUntil).toBe(0);
  });
});

describe('agent wiring', () => {
  it('codex: a -c provider override placed before app-server', () => {
    const args = beforeAppServer(['-c', 'x=1', 'app-server', '--listen'], codexGatewayArgs('http://127.0.0.1:9/gateway/g'));
    expect(args.slice(0, 2)).toEqual(['-c', 'x=1']);
    expect(args.indexOf('app-server')).toBe(args.length - 2);
    expect(args).toContain('model_providers.cwgw.base_url="http://127.0.0.1:9/gateway/g/v1"');
    expect(args).toContain('model_providers.cwgw.env_key="CW_GATEWAY_KEY"');
    expect(args).toContain('model_providers.cwgw.wire_api="responses"');
    expect(args).toContain('model_provider="cwgw"');
    expect(beforeAppServer(['serve'], ['-c', 'y'])).toEqual(['serve']);
  });
  it('gemini: a system settings copy that forces API-key auth', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gw-gem-'));
    const prev = { d: process.env.CLAUDE_WEB_DIR, s: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH };
    fs.writeFileSync(path.join(dir, 'sys.json'), JSON.stringify({ general: { x: 1 }, security: { auth: { selectedType: 'oauth-personal', enforced: false } } }));
    process.env.CLAUDE_WEB_DIR = dir;
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = path.join(dir, 'sys.json');
    try {
      const env = geminiApiKeyEnv();
      const j = JSON.parse(fs.readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
      expect(j).toEqual({ general: { x: 1 }, security: { auth: { selectedType: 'gemini-api-key', enforced: false } } });
      expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH.startsWith(dir)).toBe(true);
    } finally {
      if (prev.d === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prev.d;
      if (prev.s === undefined) delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH; else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = prev.s;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('second review', () => {
  it('A: six concurrent 429s without reset headers keep the first 60s cooldown', () => {
    const s = new MemberStates();
    for (let i = 0; i < 6; i++) {
      const v = classify(429, {}, '', s.get('g', 'a').strikes);
      s.fail('g', 'a', v, 429, 'rl', 100 + i, i); // all sent before the first answer came back
    }
    expect(s.get('g', 'a').cooldownUntil).toBe(100 + 60_000);
    expect(s.get('g', 'a').strikes).toBe(1);
    // a stated reset still extends it
    s.fail('g', 'a', classify(429, { 'retry-after': '300' }, '', 1), 429, 'rl', 200, 5);
    expect(s.get('g', 'a').cooldownUntil).toBe(200 + 300_000);
  });

  it('B/D: only the gemini kind gets the settings override; codex gets the profile model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gw-launch-'));
    const prev = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir;
    try {
      const meta = new MetaStore(path.join(dir, 'meta.json'));
      const p = await meta.upsertProvider({ name: 'GW', type: 'gateway', gatewayGroupId: 'g', baseUrl: '', apiKey: '', defaultModel: 'claude-sonnet-4-5' });
      const svc = new ProviderService(meta);
      svc.gatewayEndpoint = () => ({ baseUrl: 'http://127.0.0.1:1/gateway/g', key: 'cwg-k' });
      expect(svc.agentLaunch(p.id, 'acp', 'gemini').env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeTruthy();
      const qwen = svc.agentLaunch(p.id, 'acp', 'qwen');
      expect(qwen.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
      expect(qwen.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:1/gateway/g/v1');
      const codex = svc.agentLaunch(p.id, 'codex', 'codex');
      expect(codex.args.slice(0, 2)).toEqual(['-c', 'model="claude-sonnet-4-5"']);
      expect(codex.env.CW_GATEWAY_KEY).toBe('cwg-k');
      expect(codexGatewayArgs('http://x')).not.toContain('-c model');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C: settings copy is written atomically (replaces in one step, leaves no temp files)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gw-atomic-'));
    try {
      const f = path.join(dir, 's.json');
      writeAtomic(f, '{"a":1}');
      writeAtomic(f, '{"a":2}');
      expect(fs.readFileSync(f, 'utf8')).toBe('{"a":2}');
      expect(fs.readdirSync(dir)).toEqual(['s.json']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
