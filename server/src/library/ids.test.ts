import { describe, expect, it } from 'vitest';
import { libraryId, parseLibraryId } from './ids.js';

describe('library ids', () => {
  it('prefixes claude.ai ids', () => {
    expect(libraryId('claudeai', 'abc')).toBe('claudeai-abc');
    expect(parseLibraryId('claudeai-a-b')).toEqual({ kind: 'claudeai', nativeId: 'a-b' });
  });

  it('leaves claude ids untouched', () => {
    expect(libraryId('claude', 'u-1')).toBe('u-1');
  });

  it('falls back to claude for an id with no known prefix (e.g. a plain UUID)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseLibraryId(uuid)).toEqual({ kind: 'claude', nativeId: uuid });
  });

  it('an id of a removed agent parses as claude', () => {
    expect(parseLibraryId('codex-019a')).toEqual({ kind: 'claude', nativeId: 'codex-019a' });
  });

  it('round-trips libraryId -> parseLibraryId for every known kind', () => {
    const cases: [import('../protocol.js').AgentKind, string][] = [
      ['claudeai', 'c-1'],
      ['claude', 'u-1'],
    ];
    for (const [kind, nativeId] of cases) {
      expect(parseLibraryId(libraryId(kind, nativeId))).toEqual({ kind, nativeId });
    }
  });
});
