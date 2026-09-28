import { describe, expect, it } from 'vitest';
import type { AssistantItem, Item, ToolUseBlock } from './conversation';
import { sessionDiffStat } from './diffstat';

let n = 0;
const tool = (name: string, input: Record<string, unknown>, structured?: unknown, extra: Partial<ToolUseBlock> = {}): ToolUseBlock => ({
  type: 'tool_use', id: `tu${++n}`, name, input, children: [], status: 'done', result: { content: 'ok', isError: false, structured }, ...extra,
});
const turn = (...blocks: ToolUseBlock[]): AssistantItem => ({ kind: 'assistant', id: `m${++n}`, blocks, streaming: false, parentToolUseId: null });

describe('sessionDiffStat', () => {
  it('counts +/− lines from structuredPatch and unique files', () => {
    const items: Item[] = [
      turn(
        tool('Edit', { file_path: 'C:\\w\\src\\todos.js', old_string: 'a', new_string: 'b' }, { structuredPatch: [{ oldStart: 9, newStart: 9, lines: [' ctx', '-todo.done = true;', '+if (!todo) {', '+  throw new Error();', '+}', '+todo.done = true;', ' ctx'] }] }),
        tool('Edit', { file_path: 'c:/w/src/todos.js', old_string: 'x', new_string: 'y' }, { structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-x', '+y'] }] }),
      ),
    ];
    expect(sessionDiffStat(items)).toEqual({ files: 1, added: 5, removed: 2 });
  });

  it('a created file counts its content as added', () => {
    const items = [turn(tool('Write', { file_path: '/w/new.ts', content: 'a\nb\nc\n' }, { type: 'create', structuredPatch: [], content: 'a\nb\nc\n' }))];
    expect(sessionDiffStat(items)).toEqual({ files: 1, added: 3, removed: 0 });
  });

  it('falls back to old / new strings when there is no structured output (other agents)', () => {
    const items = [turn(
      tool('Edit', { file_path: '/w/a.ts', old_string: 'keep\nold1\nold2\ntail', new_string: 'keep\nnew\ntail' }),
      tool('MultiEdit', { file_path: '/w/b.ts', edits: [{ old_string: 'a', new_string: 'a\nb' }, { old_string: 'c\nd', new_string: '' }] }),
    )];
    expect(sessionDiffStat(items)).toEqual({ files: 2, added: 2, removed: 4 });
  });

  it('ignores failed, running and non-editing tools; includes subagents', () => {
    const child = turn(tool('Edit', { file_path: '/w/sub.ts', old_string: 'a', new_string: 'b' }, { structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] }));
    const items = [turn(
      tool('Edit', { file_path: '/w/x.ts', old_string: 'a', new_string: 'b' }, undefined, { status: 'error', result: { content: 'no', isError: true } }),
      tool('Edit', { file_path: '/w/y.ts', old_string: 'a', new_string: 'b' }, undefined, { status: 'running', result: undefined }),
      tool('Read', { file_path: '/w/z.ts' }),
      tool('Agent', { prompt: 'x' }, undefined, { children: [child] }),
    )];
    expect(sessionDiffStat(items)).toEqual({ files: 1, added: 1, removed: 1 });
  });

  it('nothing edited → zeros', () => {
    expect(sessionDiffStat([])).toEqual({ files: 0, added: 0, removed: 0 });
  });
});
