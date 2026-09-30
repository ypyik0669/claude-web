import { describe, expect, it } from 'vitest';
import { codexRolloutId } from './service.js';

describe('the Codex thread a rollout file belongs to (live refresh of an open Codex conversation)', () => {
  it('rollout-<date>T<time>-<uuid>.jsonl, with either separator; anything else is none', () => {
    const id = '01a0f133-d017-7e81-829d-fa7a91fd3158';
    expect(codexRolloutId(`2026/09/30/rollout-2026-09-30T15-24-59-${id}.jsonl`)).toBe(id);
    expect(codexRolloutId(`2026\\09\\30\\rollout-2026-09-30T15-24-59-${id}.jsonl`)).toBe(id);
    expect(codexRolloutId(`rollout-2026-01-27T14-59-44-${id.toUpperCase()}.jsonl`)).toBe(id);
    expect(codexRolloutId('2026/09/30')).toBeNull();
    expect(codexRolloutId(`2026/09/30/rollout-2026-09-30T15-24-59-${id}.jsonl.tmp`)).toBeNull();
    expect(codexRolloutId('session_index.jsonl')).toBeNull();
  });
});
