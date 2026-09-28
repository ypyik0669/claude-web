import { describe, expect, it, vi } from 'vitest';

// A stand-in runner: no child process, state driven by the test.
vi.mock('./session-runner.js', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeRunner extends EventEmitter {
    id: string;
    sessionId: string;
    state = 'starting';
    cwd: string;
    info: any;
    lastActivity = Date.now();
    closeCalls = 0;
    constructor(params: any) {
      super();
      this.id = this.sessionId = params.sessionId ?? `new-${Math.random()}`;
      this.cwd = params.cwd;
      this.info = { sessionId: this.sessionId };
    }
    setState(s: string) {
      this.state = s;
      this.emit('state', s);
    }
    getHistory() { return []; }
    getPendingPermissions() { return []; }
    async close() {
      this.closeCalls++;
      await new Promise((r) => setTimeout(r, 5));
      this.setState('closed');
    }
  }
  return { SessionRunner: FakeRunner };
});

const { RunnerPool, idleTtlFor } = await import('./pool.js');

const pool = () => new RunnerPool({ forSession: () => undefined } as any);

describe('RunnerPool', () => {
  it('a closing runner does not evict the runner that replaced it', async () => {
    const p = pool();
    const a: any = p.open({ sessionId: 's1', cwd: '/x' });
    const closing = p.close('s1');
    // reopened while the old process is still shutting down
    const b: any = p.open({ sessionId: 's1', cwd: '/x' });
    expect(b).not.toBe(a);
    await closing;
    expect(p.get('s1')).toBe(b);
  });

  it('does not broadcast the replaced runner\'s shutdown as the new runner\'s state', async () => {
    const p = pool();
    const states: string[] = [];
    p.on('state', (_sid: string, s: string) => states.push(s));
    const a: any = p.open({ sessionId: 's2', cwd: '/x' });
    a.setState('error');
    const b: any = p.open({ sessionId: 's2', cwd: '/x' });
    expect(b).not.toBe(a);
    expect(a.closeCalls).toBe(1); // the errored runner is cleaned up
    await new Promise((r) => setTimeout(r, 20));
    expect(states).toEqual(['error']);
    expect(p.get('s2')).toBe(b);
  });

  it('drops a runner re-keyed by init when it closes', () => {
    const p = pool();
    const a: any = p.open({ cwd: '/x' });
    a.sessionId = 'real-id';
    a.emit('info', { sessionId: 'real-id' });
    expect(p.get('real-id')).toBe(a);
    a.setState('closed');
    expect(p.get('real-id')).toBeUndefined();
  });

  it('idle TTL follows the profile\'s cache retention: long-retention providers keep the process (a resume rebuilds the prompt prefix)', () => {
    const MIN = 60_000;
    expect(idleTtlFor(undefined)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'openai' } as any)).toBe(120 * MIN);
    expect(idleTtlFor({ type: 'grok' } as any)).toBe(120 * MIN);
    expect(idleTtlFor({ type: 'gemini' } as any)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'gateway' } as any)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'anthropic' } as any)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'anthropic', cache1h: true } as any)).toBe(65 * MIN);
  });

  it('the reaper uses the per-session TTL', () => {
    const p = new RunnerPool({ forSession: (id?: string) => (id === 'oai' ? { type: 'openai' } : undefined) } as any);
    const long: any = p.open({ sessionId: 'long', cwd: '/x', providerId: 'oai' });
    const plain: any = p.open({ sessionId: 'plain', cwd: '/x' });
    for (const r of [long, plain]) { r.state = 'idle'; r.lastActivity = Date.now() - 45 * 60_000; }
    (p as any).reap();
    expect(plain.closeCalls).toBe(1);
    expect(long.closeCalls).toBe(0);
  });

  it('closeAll survives a runner whose close rejects', async () => {
    const p = pool();
    const a: any = p.open({ sessionId: 's3', cwd: '/x' });
    const b: any = p.open({ sessionId: 's4', cwd: '/x' });
    a.close = async () => { throw new Error('boom'); };
    await expect(p.closeAll()).resolves.toBeUndefined();
    expect(b.closeCalls).toBe(1);
  });
});
