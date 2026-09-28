import { describe, expect, it } from 'vitest';
import type { SessionInfoSnapshot } from '@shared';
import { reopenSettings } from './reopen';

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
