import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeVersion, cmpVersion, noteClaudeVersion, refreshLatestClaudeVersion, resetClaudeVersion } from './claude-version.js';
import { aliasTarget, ccbAccountEnv, ccbModel, liveClaudeExtras, modelLabel, modelsFor, setLiveClaude } from './models/catalog.js';
import { ClaudeLive } from './usage/claude-live.js';
import { CLAUDE_PKG, downloadedClaude, updateClaudeBinary } from './engines/claude-update.js';
import { PROFILES } from './gateway/fingerprint/profiles.js';

let dir = '';
const saved = process.env.CLAUDE_WEB_DIR;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-live-')); process.env.CLAUDE_WEB_DIR = dir; resetClaudeVersion(); });
afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = saved; resetClaudeVersion(); setLiveClaude(null); fs.rmSync(dir, { recursive: true, force: true }); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('claude-version', () => {
  it('compares numerically and ignores suffixes', () => {
    expect(cmpVersion('2.1.290', '2.1.280')).toBeGreaterThan(0);
    expect(cmpVersion('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(cmpVersion('2.1.322 (Claude Code)', '2.1.322')).toBe(0);
  });
  it('only moves forward, and remembers across restarts', () => {
    const floor = claudeCodeVersion();
    noteClaudeVersion('1.0.0');
    expect(claudeCodeVersion()).toBe(floor);
    noteClaudeVersion('9.9.9 (Claude Code)');
    expect(claudeCodeVersion()).toBe('9.9.9');
    resetClaudeVersion();
    expect(claudeCodeVersion()).toBe('9.9.9');
  });
  it('takes the registry latest; a failure keeps the last known', async () => {
    expect(await refreshLatestClaudeVersion((async () => json({ version: '7.0.1' })) as typeof fetch)).toBe('7.0.1');
    expect(await refreshLatestClaudeVersion((async () => { throw new Error('offline'); }) as typeof fetch)).toBe('7.0.1');
  });
  it('the gateway fingerprint follows it', () => {
    noteClaudeVersion('8.2.3');
    expect(PROFILES['claude-code'].userAgent).toBe('claude-cli/8.2.3 (external, cli)');
  });
});

describe('live Claude models in the catalog', () => {
  const list = [
    { id: 'claude-fable-6', displayName: 'Fable 6' },
    { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
    { id: 'claude-fable-5-2', displayName: 'Fable 5.2' },
    { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
    { id: 'claude-opus-4-7', displayName: 'Opus 4.7' },
  ];
  it('without a live list the measured table is used', () => {
    expect(aliasTarget('claude', 'fable')).toBe('claude-fable-5-2');
    expect(aliasTarget('claude', 'toString')).toBe('toString');
  });
  it('aliases follow the newest of each family', () => {
    setLiveClaude(list);
    expect(aliasTarget('claude', 'fable')).toBe('claude-fable-6');
    expect(aliasTarget('claude', 'fable[1m]')).toBe('claude-fable-6');
    expect(aliasTarget('claude', 'best')).toBe('claude-opus-5-5');
    expect(aliasTarget('claude', 'toString')).toBe('toString');
    expect(ccbModel('fable[1m]')).toBe('claude-fable-6[1m]');
    expect(ccbAccountEnv().ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-5-5');
    expect(modelLabel('claude', 'claude-fable-6')).toBe('Fable 6');
  });
  it('the picker: newest per family plus non-legacy known ones; legacy stays out', () => {
    setLiveClaude(list);
    const ids = modelsFor('claude').map((m) => m.value);
    expect(ids).toEqual(['claude-fable-6', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  });
  it('extras: what the CLI did not list (its aliases resolved)', () => {
    setLiveClaude(list);
    const extra = liveClaudeExtras(['default', 'opus', 'sonnet', 'haiku', 'claude-fable-5-2']).map((m) => m.value);
    expect(extra).toEqual(['claude-fable-6']);
  });
});

describe('ClaudeLive', () => {
  it('reads models and the plan name, keeps them on disk, and keeps the last answer on failure', async () => {
    let fail = false;
    const f = (async (url: string) => {
      if (fail) return json({}, 500);
      return String(url).includes('/v1/models')
        ? json({ data: [{ id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2' }] })
        : json({ organization: { plan_display_name: 'Ultra' } });
    }) as unknown as typeof fetch;
    const live = new ClaudeLive(f, async () => 'tok');
    const changes: unknown[] = [];
    live.on('change', (s) => changes.push(s));
    await live.refresh();
    expect(live.models()).toEqual([{ id: 'claude-fable-5-2', displayName: 'Fable 5.2' }]);
    expect(live.plan()).toBe('Ultra');
    expect(changes).toHaveLength(1);
    fail = true;
    await live.refresh();
    expect(live.models()).toHaveLength(1);
    expect(live.plan()).toBe('Ultra');
    expect(new ClaudeLive(f, async () => 'tok').plan()).toBe('Ultra');
  });
  it('a plan name the CLI would refuse is ignored', async () => {
    const f = (async (url: string) => String(url).includes('/v1/models') ? json({ data: [] }) : json({ organization: { plan_display_name: '<script>' } })) as unknown as typeof fetch;
    const live = new ClaudeLive(f, async () => 'tok');
    await live.refresh();
    expect(live.get()?.plan).toBeUndefined();
  });
});

/** A minimal ustar archive with one file. */
function tgz(name: string, body: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write('0000755\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return zlib.gzipSync(Buffer.concat([h, body, pad, Buffer.alloc(1024)]));
}

describe('updateClaudeBinary', () => {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  it('refuses a package whose integrity does not match, and installs nothing', async () => {
    const pkg = tgz(`package/${exe}`, Buffer.from('not a binary'));
    const f = (async (url: string) => String(url).endsWith('/latest')
      ? json({ version: '99.0.0', dist: { tarball: 'https://x/p.tgz', integrity: 'sha512-' + crypto.createHash('sha512').update('other').digest('base64') } })
      : new Response(pkg)) as unknown as typeof fetch;
    const r = await updateClaudeBinary({ fetchImpl: f, dir: path.join(dir, 'engines', 'claude') });
    expect(r.updated).toBe(false);
    expect(r.error).toMatch(/integrity/);
    expect(downloadedClaude(path.join(dir, 'engines', 'claude'))).toBeNull();
  });
  it('does nothing when the bundled package is already the latest', async () => {
    const f = (async () => json({ version: '0.0.1', dist: { tarball: 'https://x/p.tgz', integrity: 'sha512-AAAA' } })) as unknown as typeof fetch;
    const r = await updateClaudeBinary({ fetchImpl: f, dir: path.join(dir, 'engines', 'claude') });
    expect(r).toEqual({ updated: false, version: '0.0.1' });
  });
  it('a verified package whose binary does not run is not installed', async () => {
    const pkg = tgz(`package/${exe}`, Buffer.from('#!/bin/false\n'));
    const integrity = 'sha512-' + crypto.createHash('sha512').update(pkg).digest('base64');
    const f = (async (url: string) => String(url).endsWith('/latest') ? json({ version: '99.0.0', dist: { tarball: 'https://x/p.tgz', integrity } }) : new Response(pkg)) as unknown as typeof fetch;
    const r = await updateClaudeBinary({ fetchImpl: f, dir: path.join(dir, 'engines', 'claude') });
    expect(r.updated).toBe(false);
    expect(r.error).toMatch(/did not run/);
    expect(fs.readdirSync(path.join(dir, 'engines', 'claude'))).toEqual([]);
  });
  it('the package name is per platform', () => expect(CLAUDE_PKG).toBe(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`));
});
