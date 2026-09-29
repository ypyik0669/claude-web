import { describe, expect, it } from 'vitest';
import type { SessionInfoSnapshot } from '@shared';
import { lastAssistantModel, lastPermissionMode, reopenSettings, resumeParams, resumeView } from './reopen';

describe('reopenSettings', () => {
  it('carries model, effort, permission mode, ultracode and features', () => {
    const info = { sessionId: 's', cwd: '/x', model: 'gpt-5.6-sol', effort: 'high', permissionMode: 'bypassPermissions', ultracode: true, features: { chrome: true } } as unknown as SessionInfoSnapshot;
    expect(reopenSettings(info)).toEqual({ model: 'gpt-5.6-sol', effort: 'high', permissionMode: 'bypassPermissions', ultracode: true, features: { chrome: true } });
  });
  it('omits what is unset (server defaults apply) and tolerates no info', () => {
    expect(reopenSettings(undefined)).toEqual({});
    expect(reopenSettings({ sessionId: 's', cwd: '/x', effort: null, features: {} } as unknown as SessionInfoSnapshot)).toEqual({});
  });
});

const info = (o: Partial<SessionInfoSnapshot>): SessionInfoSnapshot => ({ sessionId: 's', state: 'closed', cwd: '/r', ...o }) as SessionInfoSnapshot;
const items = (...models: (string | undefined)[]) => models.map((model, i) => ({ kind: 'assistant', id: `a${i}`, model, parentToolUseId: null }));

describe('what a conversation that is not running will continue with (final review §9 #1)', () => {
  it('the model: the last top-level answer\'s, skipping synthetic error lines and subagents', () => {
    expect(lastAssistantModel(items('claude-opus-5', 'claude-sonnet-5'))).toBe('claude-sonnet-5');
    expect(lastAssistantModel([...items('claude-sonnet-5'), { kind: 'assistant', id: 'x', model: '<synthetic>', parentToolUseId: null }])).toBe('claude-sonnet-5');
    expect(lastAssistantModel([...items('claude-sonnet-5'), { kind: 'assistant', id: 'y', model: 'claude-haiku-4-5', parentToolUseId: 'toolu_1' }])).toBe('claude-sonnet-5');
    expect(lastAssistantModel([{ kind: 'user', id: 'u' }])).toBeUndefined();
  });
  it('the permission mode of the transcript\'s last line that has one — never 完全放开 (that one is chosen, not restored)', () => {
    expect(lastPermissionMode([{ type: 'user', permissionMode: 'plan' }, { type: 'user', permissionMode: 'acceptEdits' }, { type: 'assistant' }])).toBe('acceptEdits');
    expect(lastPermissionMode([{ type: 'user', permissionMode: 'bypassPermissions' }])).toBeUndefined();
    expect(lastPermissionMode([{ type: 'user', permissionMode: 'nonsense' }])).toBeUndefined();
    expect(lastPermissionMode([])).toBeUndefined();
  });
  it('what the chips show: the user\'s pick > the last live info > the transcript > the defaults', () => {
    const conv = { items: items('claude-sonnet-5') };
    expect(resumeView({ conv }, undefined)).toEqual({ providerId: 'claude', model: 'claude-sonnet-5', permissionMode: 'default', effort: undefined, ultracode: false });
    expect(resumeView({ conv, lastMode: 'plan' }, { providerId: 'p1' })).toMatchObject({ providerId: 'p1', permissionMode: 'plan' });
    expect(resumeView({ conv, info: info({ model: 'claude-opus-5', permissionMode: 'acceptEdits', effort: 'low', providerId: 'p2', ultracode: true }) }, { providerId: 'p1' }))
      .toEqual({ providerId: 'p2', model: 'claude-opus-5', permissionMode: 'acceptEdits', effort: 'low', ultracode: true });
    expect(resumeView({ conv, info: info({ model: 'claude-opus-5' }), resume: { model: 'claude-haiku-4-5', providerId: 'claude', permissionMode: 'plan', effort: 'max' } }, { providerId: 'p1' }))
      .toEqual({ providerId: 'claude', model: 'claude-haiku-4-5', permissionMode: 'plan', effort: 'max', ultracode: false });
  });
  it('the resume params: exactly what the chips show; the provider only when the user picked one (else the server keeps the recorded one)', () => {
    const conv = { items: items('claude-sonnet-5') };
    expect(resumeParams({ conv })).toEqual({ model: 'claude-sonnet-5' });
    expect(resumeParams({ conv, lastMode: 'plan' })).toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan' });
    expect(resumeParams({ conv, resume: { providerId: 'p9', model: 'm9', permissionMode: 'acceptEdits', effort: 'low', ultracode: false } })).toEqual({ providerId: 'p9', model: 'm9', permissionMode: 'acceptEdits', effort: 'low' });
    // a picked default ('' — the account's / the profile's) sends no model, even over the transcript's and live info's
    expect(resumeParams({ conv, info: info({ model: 'claude-opus-5' }), resume: { providerId: 'claude', model: '' } })).toEqual({ providerId: 'claude' });
    expect(resumeView({ conv, resume: { model: '' } }, undefined).model).toBeUndefined();
    // it last ran on the account while the server still records a profile (it only records profiles): say so
    expect(resumeParams({ conv, info: info({}) }, { providerId: 'p1' })).toMatchObject({ providerId: 'claude' });
    expect(resumeView({ conv, info: info({}) }, { providerId: 'p1' }).providerId).toBe('claude');
    expect(resumeParams({ conv, info: info({ providerId: 'p1' }) }, { providerId: 'p1' }).providerId).toBeUndefined();
    expect(resumeParams({ conv }, { providerId: 'p1' }).providerId).toBeUndefined();
    // a reaped conversation comes back as it was (review of 6a481ac): model, effort, mode, 深度编排, features
    const i = info({ model: 'claude-opus-5', effort: 'high', permissionMode: 'plan', ultracode: true, features: { chrome: true } });
    expect(resumeParams({ conv, info: i })).toEqual(reopenSettings(i));
  });
});
