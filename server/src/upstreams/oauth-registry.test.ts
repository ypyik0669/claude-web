import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../channels/providers/builtins.js';
import {
  PROVIDER_LOGINS, loginDef, loginInfos, loginModes, validateLoginDefs,
} from './oauth-registry.js';

describe('provider login registry', () => {
  it('is structurally coherent', () => {
    expect(validateLoginDefs()).toEqual([]);
  });

  it('has a definition for every subscription descriptor (including the unavailable ones)', () => {
    const ids = new Set(PROVIDER_LOGINS.map((d) => d.id));
    for (const p of PROVIDERS.filter((x) => x.kind === 'subscription')) {
      expect(ids.has(p.id), p.id).toBe(true);
    }
  });

  it('marks only flows with a real public client / reader as available', () => {
    const available = PROVIDER_LOGINS.filter((d) => d.available).map((d) => d.id).sort();
    expect(available).toEqual(['claude', 'codex', 'copilot', 'grok', 'opencode']);
    expect(loginDef('gemini')?.available).toBe(false);
    expect(loginDef('gemini')?.reason).toContain('Code Assist');
    expect(loginDef('kimi')?.available).toBe(false);
    expect(loginDef('devin')?.available).toBe(false);
    expect(loginDef('mimo')?.available).toBe(false);
  });

  it('never exposes an available login without a usable account mapping', () => {
    for (const d of PROVIDER_LOGINS.filter((x) => x.available)) {
      expect(d.account?.usable, d.id).toBe(true);
    }
  });

  it('describes the modes each provider really has', () => {
    expect(loginModes(loginDef('codex')!)).toEqual(['oauth']);
    expect(loginModes(loginDef('copilot')!)).toEqual(['device']);
    expect(loginModes(loginDef('opencode')!)).toEqual(['local']);
    const info = loginInfos().find((x) => x.id === 'gemini')!;
    expect(info.available).toBe(false);
    expect(info.reason).toBeTruthy();
  });

  it('rejects a broken definition instead of letting the wizard fake a flow', () => {
    const problems = validateLoginDefs([{
      id: 'broken',
      name: 'Broken',
      auth: 'oauth-loopback',
      instructions: 'x',
      available: true,
    }]);
    expect(problems.some((p) => p.includes('oauth config'))).toBe(true);
    expect(problems.some((p) => p.includes('usable account mapping'))).toBe(true);
  });
});
