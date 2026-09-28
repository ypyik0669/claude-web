import { describe, expect, it } from 'vitest';
import type { SessionSummary, SourceCaps } from '@shared';
import { capsIntersection, deleteSummary, deleteTargets, effectiveCaps, nativeCliCommand } from './caps';

const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/w', lastModified: 0, ...o });
const CLAUDE: SourceCaps = { resume: true, rename: true, archive: false, delete: true, fork: true };
const CODEX: SourceCaps = { resume: true, rename: true, archive: true, delete: true, fork: true };
const READONLY: SourceCaps = { resume: false, rename: false, archive: false, delete: false, fork: false };

describe('effectiveCaps', () => {
  it('Claude archives through meta (no native archive flag)', () => {
    const c = effectiveCaps(s('0b6f3c1e-uuid', { agent: 'claude', caps: CLAUDE }));
    expect(c.archive).toBe(true);
    expect(c.archiveVia).toBe('meta');
    expect(c.delete).toBe(true);
  });

  it('an imported source with native archive uses the library', () => {
    expect(effectiveCaps(s('codex-t1', { agent: 'codex', caps: CODEX })).archiveVia).toBe('library');
  });

  it('a read-only imported source offers nothing, archive included', () => {
    const c = effectiveCaps(s('gemini-x', { agent: 'gemini', caps: READONLY }));
    expect(c).toMatchObject({ archive: false, archiveVia: null, delete: false, rename: false, fork: false });
  });

  it('a claude-web-driven agent session (no caps, unprefixed id) archives in meta', () => {
    const c = effectiveCaps(s('7d1e-local-id', { agent: 'gemini' }));
    expect(c.archiveVia).toBe('meta');
    expect(c.delete).toBe(true);
  });

  it('an imported id without caps never gets delete / fork', () => {
    expect(effectiveCaps(s('codex-t9', { agent: 'codex' }))).toMatchObject({ delete: false, fork: false, archive: false });
  });
});

describe('capsIntersection', () => {
  it('only offers what every selected session supports', () => {
    const claude = s('c1', { agent: 'claude', caps: CLAUDE });
    const codex = s('codex-a', { agent: 'codex', caps: CODEX });
    const ro = s('gemini-b', { agent: 'gemini', caps: READONLY });
    expect(capsIntersection([claude, codex])).toEqual({ archive: true, delete: true });
    expect(capsIntersection([claude, ro])).toEqual({ archive: false, delete: false });
    expect(capsIntersection([])).toEqual({ archive: false, delete: false });
  });
});

describe('nativeCliCommand', () => {
  it('maps each agent to its own resume flag with the native id', () => {
    expect(nativeCliCommand(s('abc-123', { agent: 'claude' }))).toBe('claude --resume abc-123');
    expect(nativeCliCommand(s('abc-123'))).toBe('claude --resume abc-123');
    expect(nativeCliCommand(s('codex-019a-x', { agent: 'codex' }))).toBe('codex resume 019a-x');
    expect(nativeCliCommand(s('opencode-ses_1', { agent: 'opencode' }))).toBe('opencode --session ses_1');
  });

  it('hides the item for other agents and for sessions claude-web drove itself', () => {
    expect(nativeCliCommand(s('gemini-x', { agent: 'gemini' }))).toBeNull();
    expect(nativeCliCommand(s('acp_my~agent-1', { agent: 'acp:my-agent' }))).toBeNull();
    expect(nativeCliCommand(s('7d1e-local-id', { agent: 'codex' }))).toBeNull();
  });
});

describe('deleteSummary', () => {
  it('states the count and the per-source split, biggest first', () => {
    const list = [s('c1'), s('codex-1', { agent: 'codex' }), s('codex-2', { agent: 'codex' })];
    expect(deleteSummary(list, (k) => ({ codex: 'Codex', claude: 'Claude Code' })[k] ?? k)).toBe('将删除 3 个会话（Codex 2、Claude Code 1）');
  });
});

describe('deleteTargets', () => {
  const names = (k: string) => ({ codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' })[k] ?? k;
  it('imported sessions are deleted from their source, Claude sessions from Claude Code', () => {
    expect(deleteTargets([s('codex-1', { agent: 'codex', caps: CODEX }), s('c1')], names)).toBe('从 Codex、Claude Code 删除');
  });
  it("claude-web's own agent session is deleted from Claude Web only", () => {
    expect(deleteTargets([s('uuid-own', { agent: 'codex' })], names)).toBe('从 Claude Web 删除');
  });
  it('a merged session (backed by a joined source that can delete) is ALSO deleted from that source', () => {
    expect(deleteTargets([s('uuid-m', { agent: 'codex', caps: CODEX, mergedFrom: 'codex-t1' })], names)).toBe('从 Claude Web 删除，并同时从 Codex 删除它的原始记录');
  });
  it('a merged session whose source cannot delete stays in the source', () => {
    expect(deleteTargets([s('uuid-m', { agent: 'opencode', caps: READONLY, mergedFrom: 'opencode-x' })], names)).toBe('从 Claude Web 删除');
  });
});

describe('sessions on other machines (federation)', () => {
  const B = { id: 'b1', name: 'Box B' };
  const names = (k: string) => ({ codex: 'Codex', claude: 'Claude Code' })[k] ?? k;
  it('an online peer session keeps its caps; an imported one on the peer pages through library.read', () => {
    expect(effectiveCaps(s('peer_b1~uuid', { peer: B })).resume).toBe(true);
    expect(effectiveCaps(s('peer_b1~codex-t', { peer: B, agent: 'codex', caps: CODEX })).archiveVia).toBe('library');
  });
  it('an offline peer session is read-only', () => {
    const c = effectiveCaps(s('peer_b1~uuid', { peer: { ...B, offline: true }, caps: CODEX }));
    expect(c).toMatchObject({ resume: false, rename: false, archive: false, delete: false, fork: false, archiveVia: null });
  });
  it('no native CLI command: the session is not on this machine', () => {
    expect(nativeCliCommand(s('peer_b1~uuid', { peer: B }))).toBeNull();
    expect(nativeCliCommand(s('peer_b1~codex-t', { peer: B, agent: 'codex' }))).toBeNull();
  });
  it('the delete confirm names the machine', () => {
    expect(deleteTargets([s('peer_b1~uuid', { peer: B })], names)).toBe('从 机器「Box B」 删除');
  });
});
