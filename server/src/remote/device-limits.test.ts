import { describe, expect, it } from 'vitest';
import type { ClientRequest } from '../protocol.js';
import { refusedFromDevice } from './device-limits.js';

describe('refusedFromDevice', () => {
  it('a paired device cannot mint codes, manage devices, switch the listener or read secrets', () => {
    for (const req of [
      { kind: 'remote.pairCode' }, { kind: 'remote.set', enabled: false }, { kind: 'remote.devices.revoke', id: 'x' },
      { kind: 'remote.devices.rename', id: 'x', name: 'y' }, { kind: 'env.reveal', name: 'K' }, { kind: 'im.pairCode', id: 'a' },
      { kind: 'secrets.migrate' },
    ] as ClientRequest[]) expect(refusedFromDevice(req), req.kind).toBeTruthy();
  });
  it('everything else is judged as before', () => {
    expect(refusedFromDevice({ kind: 'remote.status' } as ClientRequest)).toBeNull();
    expect(refusedFromDevice({ kind: 'sessions.list' } as ClientRequest)).toBeNull();
  });
});
