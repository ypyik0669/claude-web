import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsOverride } from './user-env.js';
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
