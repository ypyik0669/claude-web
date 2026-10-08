import { describe, expect, it } from 'vitest';
import { accountFailed } from './account-fail';

const base = { sessionId: 'a1b2', agent: 'claude', providers: 1 } as const;

describe('accountFailed', () => {
  it('a Claude-account conversation whose key was refused or could not connect, with a provider added', () => {
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: true, live: undefined })).toBe(true);
    expect(accountFailed({ ...base, errorKind: 'network', hasInfo: true, live: 'claude' })).toBe(true);
    // not running: the record says where it resumes
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: false, recorded: undefined })).toBe(true);
  });

  it('not when it is on a provider, has no provider to go to, failed otherwise, is another agent or another machine', () => {
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: true, live: 'p1' })).toBe(false);
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: false, recorded: 'p1' })).toBe(false);
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: true, providers: 0 })).toBe(false);
    expect(accountFailed({ ...base, errorKind: 'throttled', hasInfo: true })).toBe(false);
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: true, agent: 'codex' })).toBe(false);
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: true, sessionId: 'peer_m1~a1b2' })).toBe(false);
  });

  it('the running process wins over an old record (switched in this window, not yet written back)', () => {
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: true, live: 'p1', recorded: 'claude' })).toBe(false);
    expect(accountFailed({ ...base, errorKind: 'credential', hasInfo: true, live: undefined, recorded: 'p1' })).toBe(true);
  });
});
