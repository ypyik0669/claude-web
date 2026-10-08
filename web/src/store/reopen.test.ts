import { describe, expect, it } from 'vitest';
import type { SessionInfoSnapshot } from '@shared';
import { forkParams, lastAssistantModel, mergeResume, reopenSettings, resumeParams, resumeView } from './reopen';

describe('mergeResume', () => {
  it('picking a level leaves 深度编排 (the rule of a running conversation)', () => {
    expect(mergeResume({ ultracode: true }, { effort: 'low' })).toEqual({ ultracode: false, effort: 'low' });
    expect(mergeResume({ effort: 'low' }, { ultracode: true })).toEqual({ effort: 'low', ultracode: true });
    expect(mergeResume({ ultracode: true }, { model: 'x' })).toEqual({ ultracode: true, model: 'x' });
    expect(mergeResume(undefined, { effort: 'high', ultracode: true })).toEqual({ effort: 'high', ultracode: true });
  });
});

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

describe('what a conversation that is not running will continue with (final review §9 #1, re-review I-1 / M-2)', () => {
  it('the last answer\'s model (a hint only): the last top-level answer\'s, skipping synthetic error lines and subagents', () => {
    expect(lastAssistantModel(items('claude-opus-5', 'claude-sonnet-5'))).toBe('claude-sonnet-5');
    expect(lastAssistantModel([...items('claude-sonnet-5'), { kind: 'assistant', id: 'x', model: '<synthetic>', parentToolUseId: null }])).toBe('claude-sonnet-5');
    expect(lastAssistantModel([...items('claude-sonnet-5'), { kind: 'assistant', id: 'y', model: 'claude-haiku-4-5', parentToolUseId: 'toolu_1' }])).toBe('claude-sonnet-5');
    expect(lastAssistantModel([{ kind: 'user', id: 'u' }])).toBeUndefined();
  });
  it('what the chips show: the user\'s pick > the last live info > what the resume really gets (no model = the default, 每步询问); the transcript\'s model is only lastModel', () => {
    const conv = { items: items('claude-sonnet-5') };
    expect(resumeView({ conv }, undefined)).toEqual({ providerId: 'claude', model: undefined, permissionMode: 'default', effort: undefined, ultracode: false, lastModel: 'claude-sonnet-5' });
    expect(resumeView({ conv }, { providerId: 'p1' })).toMatchObject({ providerId: 'p1', model: undefined, permissionMode: 'default' });
    expect(resumeView({ conv, info: info({ model: 'claude-opus-5', permissionMode: 'acceptEdits', effort: 'low', providerId: 'p2', ultracode: true }) }, { providerId: 'p1' }))
      .toEqual({ providerId: 'p2', model: 'claude-opus-5', permissionMode: 'acceptEdits', effort: 'low', ultracode: true, lastModel: 'claude-sonnet-5' });
    expect(resumeView({ conv, info: info({ model: 'claude-opus-5' }), resume: { model: 'claude-haiku-4-5', providerId: 'claude', permissionMode: 'plan', effort: 'max' } }, { providerId: 'p1' }))
      .toMatchObject({ providerId: 'claude', model: 'claude-haiku-4-5', permissionMode: 'plan', effort: 'max', ultracode: false });
    expect(resumeView({ conv, info: info({ model: 'claude-opus-5' }), resume: { model: '' } }, undefined).model).toBeUndefined();
  });
  it('nothing picked and no live info: the resume params are exactly reopenSettings(undefined) — the server / CLI choose', () => {
    const conv = { items: items('claude-sonnet-5') };
    expect(resumeParams({ conv })).toEqual({});
    expect(resumeParams({ conv })).toEqual(reopenSettings(undefined));
    expect(resumeParams({ conv }, { providerId: 'p1' })).toEqual(reopenSettings(undefined));
  });
  it('the resume params: the pick over the live info; the provider only when the user picked one (else the server keeps the recorded one)', () => {
    const conv = { items: items('claude-sonnet-5') };
    expect(resumeParams({ conv, resume: { providerId: 'p9', model: 'm9', permissionMode: 'acceptEdits', effort: 'low', ultracode: false } })).toEqual({ providerId: 'p9', model: 'm9', permissionMode: 'acceptEdits', effort: 'low' });
    // only the mode picked: no model goes (not the transcript's)
    expect(resumeParams({ conv, resume: { permissionMode: 'plan' } })).toEqual({ permissionMode: 'plan' });
    // a picked default ('' — the account's / the profile's) sends no model, even over live info
    expect(resumeParams({ conv, info: info({ model: 'claude-opus-5' }), resume: { providerId: 'claude', model: '' } })).toEqual({ providerId: 'claude' });
    // it last ran on the account while the server still records a profile (it only records profiles): say so
    expect(resumeParams({ conv, info: info({}) }, { providerId: 'p1' })).toMatchObject({ providerId: 'claude' });
    expect(resumeView({ conv, info: info({}) }, { providerId: 'p1' }).providerId).toBe('claude');
    expect(resumeParams({ conv, info: info({ providerId: 'p1' }) }, { providerId: 'p1' }).providerId).toBeUndefined();
    // a reaped conversation comes back as it was (review of 6a481ac): model, effort, mode, 深度编排, features
    const i = info({ model: 'claude-opus-5', effort: 'high', permissionMode: 'plan', ultracode: true, features: { chrome: true } });
    expect(resumeParams({ conv, info: i })).toEqual(reopenSettings(i));
  });
});

describe('what an edit-and-resend / rerun copy starts with (re-review M-1)', () => {
  const conv = { items: items('claude-sonnet-5') };
  it('a conversation not running: its chips — the picks (provider included: the fork has a new id) over the last live info', () => {
    expect(forkParams({ state: 'history', conv, resume: { providerId: 'p2', model: 'm2', permissionMode: 'plan' } }, { providerId: 'p1' })).toEqual({ providerId: 'p2', model: 'm2', permissionMode: 'plan' });
    expect(forkParams({ state: 'closed', conv, info: info({ model: 'claude-opus-5', permissionMode: 'acceptEdits' }), resume: { permissionMode: 'plan' } })).toEqual({ model: 'claude-opus-5', permissionMode: 'plan' });
    // nothing picked, no live info: nothing — the server keeps the original's recorded provider for the fork
    expect(forkParams({ state: 'history', conv }, { providerId: 'p1' })).toEqual({});
  });
  it('a running conversation: what it runs on, its provider explicitly', () => {
    expect(forkParams({ state: 'idle', conv, info: info({ model: 'm1', permissionMode: 'plan', providerId: 'p1', effort: 'low' }) })).toEqual({ model: 'm1', permissionMode: 'plan', providerId: 'p1', effort: 'low' });
    expect(forkParams({ state: 'running', conv, info: info({ model: 'claude-opus-5' }) }).providerId).toBeUndefined();
    // running on the account while the server still records a relay (older data): the account, like resumeParams (re-review n-2)
    expect(forkParams({ state: 'idle', conv, info: info({ model: 'm1' }) }, { providerId: 'p1' })).toEqual({ model: 'm1', providerId: 'claude' });
    expect(forkParams({ state: 'idle', conv, info: info({ model: 'm1' }) }, { providerId: 'claude' }).providerId).toBeUndefined();
  });
});
