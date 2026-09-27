import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AcpListSource } from './acp-source.js';
import { libraryId } from './ids.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = path.join(here, '..', 'agents', '__mocks__', 'acp-agent.mjs');

function launch(env: Record<string, string> = {}) {
  return { command: process.execPath, args: [mock], env };
}

describe('AcpListSource (mock ACP agent)', () => {
  it('lists sessions when the agent advertises sessionCapabilities.list (MOCK_ACP_LIST=1)', async () => {
    const src = new AcpListSource('acp:e2e', () => launch({ MOCK_ACP_LIST: '1' }));
    try {
      const status = await src.status();
      expect(status.enabled).toBe(true);
      expect(src.caps).toEqual({ resume: false, rename: false, archive: false, delete: false, fork: false });

      const { items, next } = await src.list({ limit: 10 });
      expect(next).toBeUndefined();
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.sessionId)).toEqual([libraryId('acp:e2e', 's1'), libraryId('acp:e2e', 's2')]);
      const one = items.find((i) => i.sessionId === libraryId('acp:e2e', 's1'))!;
      expect(one.title).toBe('Session One');
      expect(one.cwd).toBe('/work/one');
      expect(one.agent).toBe('acp:e2e');
      expect(one.lastModified).toBe(Date.parse('2026-01-01T00:00:00.000Z')); // ISO -> ms
      const two = items.find((i) => i.sessionId === libraryId('acp:e2e', 's2'))!;
      expect(two.lastModified).toBe(1780000000000); // already ms
    } finally {
      await src.close();
    }
  });

  it('read() is unsupported: always empty with no next', async () => {
    const src = new AcpListSource('acp:e2e', () => launch({ MOCK_ACP_LIST: '1' }));
    try {
      const { messages, next } = await src.read(libraryId('acp:e2e', 's1'), { limit: 20 });
      expect(messages).toEqual([]);
      expect(next).toBeUndefined();
    } finally {
      await src.close();
    }
  });

  it('reports disabled and kills the process when the agent has no session/list capability', async () => {
    const src = new AcpListSource('acp:e2e', () => launch());
    try {
      const status = await src.status();
      expect(status.enabled).toBe(false);
      expect(status.disabledReason).toBeTruthy();

      const listed = await src.list({ limit: 10 });
      expect(listed.items).toEqual([]);
    } finally {
      await src.close();
    }
  });

  it('caches the probed capability across status() calls without respawning', async () => {
    let spawns = 0;
    const src = new AcpListSource('acp:e2e', () => { spawns++; return launch({ MOCK_ACP_LIST: '1' }); });
    try {
      const first = await src.status();
      expect(first.enabled).toBe(true);
      expect(spawns).toBe(1);

      const second = await src.status();
      expect(second.enabled).toBe(true);
      expect(spawns).toBe(1); // cached, no respawn
    } finally {
      await src.close();
    }
  });

  it('reports a broken launch as not enabled, without throwing, and list() degrades to empty', async () => {
    const src = new AcpListSource('acp:e2e', () => ({ command: 'definitely-not-a-real-acp-binary-xyz', args: [], env: {} }));
    try {
      const status = await src.status();
      expect(status.enabled).toBe(false);
      const listed = await src.list({ limit: 10 });
      expect(listed.items).toEqual([]);
    } finally {
      await src.close();
    }
  });
});
