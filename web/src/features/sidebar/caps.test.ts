import { describe, expect, it } from 'vitest';
import type { SessionSummary, SourceCaps } from '@shared';
import { capsIntersection, deleteSummary, deleteTargets, effectiveCaps, nativeCliCommand } from './caps';

const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/w', lastModified: 0, ...o });
const CLAUDE: SourceCaps = { resume: true, rename: true, archive: false, delete: true, fork: true };
const NATIVE: SourceCaps = { resume: true, rename: true, archive: true, delete: true, fork: true };
const READONLY: SourceCaps = { resume: false, rename: false, archive: false, delete: false, fork: false };

describe('effectiveCaps', () => {
  it('Claude archives through meta (no native archive flag)', () => {
    const c = effectiveCaps(s('0b6f3c1e-uuid', { agent: 'claude', caps: CLAUDE }));
    expect(c.archive).toBe(true);
    expect(c.archiveVia).toBe('meta');
    expect(c.delete).toBe(true);
  });

  it('an imported source with native archive uses the library', () => {
    expect(effectiveCaps(s('claudeai-t1', { agent: 'claudeai', caps: NATIVE })).archiveVia).toBe('library');
  });

  it('a read-only imported source offers nothing, archive included', () => {
    const c = effectiveCaps(s('claudeai-x', { agent: 'claudeai', caps: READONLY }));
    expect(c).toMatchObject({ archive: false, archiveVia: null, delete: false, rename: false, fork: false });
  });

  it('an imported id without caps never gets delete / fork', () => {
    expect(effectiveCaps(s('claudeai-t9', { agent: 'claudeai' }))).toMatchObject({ delete: false, fork: false, archive: false });
  });
});

describe('capsIntersection', () => {
  it('only offers what every selected session supports', () => {
    const claude = s('c1', { agent: 'claude', caps: CLAUDE });
    const native = s('claudeai-a', { agent: 'claudeai', caps: NATIVE });
    const ro = s('claudeai-b', { agent: 'claudeai', caps: READONLY });
    expect(capsIntersection([claude, native])).toEqual({ archive: true, delete: true });
    expect(capsIntersection([claude, ro])).toEqual({ archive: false, delete: false });
    expect(capsIntersection([])).toEqual({ archive: false, delete: false });
  });
});

describe('nativeCliCommand', () => {
  it('a Claude session resumes with claude --resume', () => {
    expect(nativeCliCommand(s('abc-123', { agent: 'claude' }))).toBe('claude --resume abc-123');
    expect(nativeCliCommand(s('abc-123'))).toBe('claude --resume abc-123');
  });

  it('hides the item for an imported claude.ai conversation', () => {
    expect(nativeCliCommand(s('claudeai-x', { agent: 'claudeai' }))).toBeNull();
  });
});

describe('deleteSummary', () => {
  it('states the count and the per-source split, biggest first', () => {
    const list = [s('c1'), s('claudeai-1', { agent: 'claudeai' }), s('claudeai-2', { agent: 'claudeai' })];
    expect(deleteSummary(list, (k) => ({ claudeai: 'claude.ai', claude: 'Claude Code' })[k] ?? k)).toBe('将删除 3 个对话（claude.ai 2、Claude Code 1）');
  });
});

describe('deleteTargets', () => {
  const names = (k: string) => ({ claudeai: 'claude.ai', claude: 'Claude Code' })[k] ?? k;
  it('imported sessions are deleted from their source, Claude sessions from Claude Code', () => {
    expect(deleteTargets([s('claudeai-1', { agent: 'claudeai', caps: NATIVE }), s('c1')], names)).toBe('从 claude.ai、Claude Code 删除');
  });
});

describe('sessions on other machines (federation)', () => {
  const B = { id: 'b1', name: 'Box B' };
  const names = (k: string) => ({ claudeai: 'claude.ai', claude: 'Claude Code' })[k] ?? k;
  it('an online peer session keeps its caps; an imported one on the peer pages through library.read', () => {
    expect(effectiveCaps(s('peer_b1~uuid', { peer: B })).resume).toBe(true);
    expect(effectiveCaps(s('peer_b1~claudeai-t', { peer: B, agent: 'claudeai', caps: NATIVE })).archiveVia).toBe('library');
  });
  it('an offline peer session is read-only', () => {
    const c = effectiveCaps(s('peer_b1~uuid', { peer: { ...B, offline: true }, caps: NATIVE }));
    expect(c).toMatchObject({ resume: false, rename: false, archive: false, delete: false, fork: false, archiveVia: null });
  });
  it('no native CLI command: the session is not on this machine', () => {
    expect(nativeCliCommand(s('peer_b1~uuid', { peer: B }))).toBeNull();
  });
  it('the delete confirm names the machine', () => {
    expect(deleteTargets([s('peer_b1~uuid', { peer: B })], names)).toBe('从 机器「Box B」 删除');
  });
});
