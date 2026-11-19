import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compactCap, compactSize, compactVarSet, ownAnthropicBase, ownOverride, settingsOverride, userCompactSource } from './user-env.js';
import { sweepFlagSettings, writeFlagSettings } from './flag-settings.js';

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-user-env-'));
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'cfg');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});
const write = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const ours = { ANTHROPIC_BASE_URL: 'https://relay.invalid', ANTHROPIC_AUTH_TOKEN: 'provider-token', ANTHROPIC_MODEL: 'claude-sonnet-5', CLAUDE_CODE_ENTRYPOINT: 'cli' };

describe('settingsOverride', () => {
  it('is null when no settings file sets anything (the common case: nothing is written)', () => {
    expect(settingsOverride(ours, path.join(tmp, 'proj'))).toBeNull();
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), { env: { FOO: '1' }, model: 'opus' });
    expect(settingsOverride(ours, path.join(tmp, 'proj'))).toBeNull();
  });

  it('puts the provider value back over an old token / base URL left in ~/.claude/settings.json', () => {
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), { env: { ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_BASE_URL: 'https://old.invalid', DISABLE_TELEMETRY: '1' } });
    expect(settingsOverride(ours)).toEqual({ ANTHROPIC_AUTH_TOKEN: 'provider-token', ANTHROPIC_BASE_URL: 'https://relay.invalid' });
  });

  it('blanks routing keys the provider does not set, in user, project and local settings; leaves the rest', () => {
    const proj = path.join(tmp, 'proj');
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), { env: { ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-haiku' } });
    write(path.join(proj, '.claude', 'settings.json'), { env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'old-model' } });
    write(path.join(proj, '.claude', 'settings.local.json'), { env: { OPENAI_API_KEY: 'x', MY_TOOL_HOME: '/opt/t' } });
    expect(settingsOverride(ours, proj)).toEqual({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      OPENAI_API_KEY: '',
    });
  });

  it('ignores files that are not JSON or whose env is not an object, as the CLI does', () => {
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{ not json');
    const proj = path.join(tmp, 'proj');
    write(path.join(proj, '.claude', 'settings.json'), { env: ['ANTHROPIC_AUTH_TOKEN'] });
    expect(settingsOverride(ours, proj)).toBeNull();
  });
});

describe('ownOverride (the account: only the keys we set, where a settings file sets them too)', () => {
  it('is null when no file sets them; otherwise just those keys with our values', () => {
    const proj = path.join(tmp, 'proj');
    const mine = { CLAUDE_CODE_SUBAGENT_MODEL: 'cw-sub/deepseek-chat', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/gateway/~s/t/k/cwx-k' };
    expect(ownOverride(mine, proj)).toBeNull();
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://relay.invalid', ANTHROPIC_AUTH_TOKEN: 'user-token', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5' } });
    // the user's token and model map stay theirs: not in the file we write
    expect(ownOverride(mine, proj)).toEqual({ ANTHROPIC_BASE_URL: mine.ANTHROPIC_BASE_URL });
    write(path.join(proj, '.claude', 'settings.local.json'), { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } });
    expect(ownOverride(mine, proj)).toEqual(mine);
    expect(ownOverride({}, proj)).toBeNull();
  });
});

describe('ownAnthropicBase (where the account’s CLI really sends)', () => {
  let envBase: string | undefined;
  beforeEach(() => { envBase = process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_BASE_URL; });
  afterEach(() => { if (envBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = envBase; });

  it('settings files over the environment, the later file winning; blank is unset', () => {
    const proj = path.join(tmp, 'proj');
    expect(ownAnthropicBase(proj)).toBeUndefined();
    process.env.ANTHROPIC_BASE_URL = 'https://env.invalid';
    expect(ownAnthropicBase(proj)).toBe('https://env.invalid');
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://kiro.invalid/api' } });
    expect(ownAnthropicBase(proj)).toBe('https://kiro.invalid/api');
    write(path.join(proj, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://project.invalid' } });
    expect(ownAnthropicBase(proj)).toBe('https://project.invalid');
    write(path.join(proj, '.claude', 'settings.local.json'), { env: { ANTHROPIC_BASE_URL: ' ' } });
    expect(ownAnthropicBase(proj)).toBeUndefined();
  });
});

describe('writeFlagSettings', () => {
  it('writes {env} for the CLI, owner-only, and removes it on dispose', () => {
    const dir = path.join(tmp, 'flags');
    const f = writeFlagSettings({ ANTHROPIC_AUTH_TOKEN: 'provider-token' }, dir);
    expect(path.dirname(f.file)).toBe(dir);
    expect(path.basename(f.file).startsWith(`${process.pid}-`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: 'provider-token' } });
    if (process.platform !== 'win32') expect(fs.statSync(f.file).mode & 0o077).toBe(0);
    f.dispose();
    f.dispose();
    expect(fs.existsSync(f.file)).toBe(false);
  });

  it('sweeps the files of servers that are gone, keeps its own', () => {
    const dir = path.join(tmp, 'flags');
    const mine = writeFlagSettings({ A: '1' }, dir);
    // a pid that cannot be running (above any real pid range)
    const stale = path.join(dir, '2147483646-00000000-0000-0000-0000-000000000000.json');
    fs.writeFileSync(stale, '{}');
    sweepFlagSettings(dir);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(mine.file)).toBe(true);
    mine.dispose();
  });
});

// 2026-10-24 review I3: the composer ring / the folded context card divided by the provider's window (1M) while the
// card body (the engine) used the autocompact cap (700k from ~/.claude/settings.json) — 58 % against 82 %
describe('compactCap (the autocompact window a conversation really has)', () => {
  let envCap: string | undefined;
  beforeEach(() => { envCap = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; });
  afterEach(() => { if (envCap === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = envCap; });
  const user = () => path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');

  it('none set anywhere: undefined', () => {
    expect(compactCap({}, path.join(tmp, 'proj'), true)).toBeUndefined();
  });
  it('the server environment, under the settings files, under the conversation\'s own env (provider / account)', () => {
    const proj = path.join(tmp, 'proj');
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '900000';
    expect(compactCap({}, proj, true)).toBe(900_000);
    write(user(), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' } });
    expect(compactCap({}, proj, true)).toBe(700_000);
    write(path.join(proj, '.claude', 'settings.local.json'), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 600000 } });
    expect(compactCap({}, proj, true)).toBe(600_000);
    // ours goes over the files through the flag tier (settingsOverride)
    expect(compactCap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '272000' }, proj, true)).toBe(272_000);
  });
  it('the account without a provider: the settings files go over what the conversation was started with', () => {
    write(user(), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' } });
    expect(compactCap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, undefined, false)).toBe(700_000);
    expect(compactCap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, path.join(tmp, 'none'), false)).toBe(700_000);
    fs.rmSync(user());
    expect(compactCap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, undefined, false)).toBe(500_000);
  });
  // 2026-11-19: the official CLI's /autocompact keeps its point in settings.json (autoCompactWindow), under the variable
  it('no variable anywhere: the /autocompact setting — a model’s own entry, else the top level; \'auto\' is none', () => {
    const proj = path.join(tmp, 'proj');
    write(user(), { autoCompactWindow: 400_000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 250_000 }, 'claude-haiku-5-5': { autoCompactWindow: 'auto' } } });
    expect(compactCap({}, proj, true)).toBe(400_000);
    expect(compactCap({}, proj, true, 'claude-opus-5-5[1m]')).toBe(250_000);
    expect(compactCap({}, proj, true, 'claude-haiku-5-5')).toBeUndefined();
    // a project's file later in the merge wins
    write(path.join(proj, '.claude', 'settings.json'), { autoCompactWindow: '300k' });
    expect(compactCap({}, proj, true, 'gpt-5.5')).toBe(300_000);
    // any variable (even blank) is above the setting, as in the CLI
    expect(compactCap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, proj, true, 'gpt-5.5')).toBe(500_000);
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '';
    expect(compactCap({}, proj, true, 'gpt-5.5')).toBeUndefined();
    expect(compactVarSet(proj)).toBe(true);
  });

  it('compactSize: numbers and the CLI’s text forms, within 100K–1M', () => {
    expect(compactSize(500_000)).toBe(500_000);
    expect(compactSize('500k')).toBe(500_000);
    expect(compactSize('1m')).toBe(1_000_000);
    expect(compactSize('200')).toBe(200_000); // the CLI's shorthand: thousands
    expect(compactSize('200000')).toBe(200_000);
    expect(compactSize(50_000)).toBe(100_000);
    expect(compactSize(5_000_000)).toBe(1_000_000);
    expect(compactSize('auto')).toBeUndefined();
    expect(compactSize('lots')).toBeUndefined();
    expect(compactSize(0)).toBeUndefined();
  });

  it('blank, zero or not a number on the layer that wins: no cap (a blank in a settings file unsets the environment\'s)', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '800000';
    expect(compactCap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'abc' }, undefined, true)).toBeUndefined();
    expect(compactCap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '0' }, undefined, true)).toBeUndefined();
    write(user(), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '' } });
    expect(compactCap({}, undefined, true)).toBeUndefined();
  });
});

// A7: the compaction point edit page shows what is in effect now — 「现在：700K（来自你的 settings.json）」. User level
// only (the page is not tied to a project).
describe('userCompactSource (where the compaction point in effect comes from)', () => {
  let envCap: string | undefined;
  beforeEach(() => { envCap = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; });
  afterEach(() => { if (envCap === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = envCap; });
  const user = () => path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');

  it('the user settings.json env: settings, over the server environment', () => {
    write(user(), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' } });
    expect(userCompactSource()).toEqual({ value: 700_000, source: 'settings' });
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '900000';
    expect(userCompactSource()).toEqual({ value: 700_000, source: 'settings' });
    write(user(), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 600000 } });
    expect(userCompactSource()).toEqual({ value: 600_000, source: 'settings' });
  });
  it('no file (or no such key in it), the server environment has it: env', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '900000';
    expect(userCompactSource()).toEqual({ value: 900_000, source: 'env' });
    write(user(), { env: { FOO: '1' } });
    expect(userCompactSource()).toEqual({ value: 900_000, source: 'env' });
  });
  it('neither: none', () => {
    expect(userCompactSource()).toEqual({ source: 'none' });
    write(user(), '{ not json');
    expect(userCompactSource()).toEqual({ source: 'none' });
  });
  it('abc / 0 / blank: no cap — in settings.json it unsets the environment\'s, as for the CLI (compactCap)', () => {
    for (const bad of ['abc', '0', '', '-5']) {
      write(user(), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: bad } });
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      expect(userCompactSource()).toEqual({ source: 'none' });
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '900000';
      expect(userCompactSource()).toEqual({ source: 'none' });
      expect(compactCap({}, undefined, false)).toBeUndefined(); // what the conversations really get
      fs.rmSync(user());
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = bad;
      expect(userCompactSource()).toEqual({ source: 'none' });
    }
  });
  it('a home folder: its .claude/settings.json, when CLAUDE_CONFIG_DIR does not say elsewhere', () => {
    const home = path.join(tmp, 'home');
    write(path.join(home, '.claude', 'settings.json'), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' } });
    expect(userCompactSource(home)).toEqual({ source: 'none' }); // CLAUDE_CONFIG_DIR (the temp cfg) wins, as for the CLI
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(userCompactSource(home)).toEqual({ value: 700_000, source: 'settings' });
  });
});
