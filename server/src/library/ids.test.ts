import { describe, expect, it } from 'vitest';
import { libraryId, parseLibraryId } from './ids.js';

describe('library ids', () => {
  it('prefixes codex ids', () => {
    expect(libraryId('codex', '019a')).toBe('codex-019a');
  });

  it('leaves claude ids untouched', () => {
    expect(libraryId('claude', 'u-1')).toBe('u-1');
  });

  it('maps acp:<id> to acp_<id>- to avoid colons', () => {
    expect(libraryId('acp:demo', 's1')).toBe('acp_demo-s1');
  });

  it('parses an opencode-prefixed id', () => {
    expect(parseLibraryId('opencode-ses_x')).toEqual({ kind: 'opencode', nativeId: 'ses_x' });
  });

  it('parses an acp-prefixed id back to acp:<id>', () => {
    expect(parseLibraryId('acp_demo-s1')).toEqual({ kind: 'acp:demo', nativeId: 's1' });
  });

  it('falls back to claude for an id with no known prefix (e.g. a plain UUID)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseLibraryId(uuid)).toEqual({ kind: 'claude', nativeId: uuid });
  });

  it('escapes "-" in a hyphenated ACP agent id so the native id boundary stays unambiguous', () => {
    expect(libraryId('acp:my-agent', 's-1-2')).toBe('acp_my~agent-s-1-2');
    expect(parseLibraryId('acp_my~agent-s-1')).toEqual({ kind: 'acp:my-agent', nativeId: 's-1' });
  });

  it('round-trips libraryId -> parseLibraryId for every known kind', () => {
    const cases: [import('../protocol.js').AgentKind, string][] = [
      ['codex', '019a'],
      ['opencode', 'ses_x'],
      ['acp:demo', 's1'],
      ['acp:my-agent', 's-1-2'],
      ['claude', 'u-1'],
    ];
    for (const [kind, nativeId] of cases) {
      expect(parseLibraryId(libraryId(kind, nativeId))).toEqual({ kind, nativeId });
    }
  });
});
