import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexItemMessages, codexTurnsToMessages, type CodexItemState } from './codex-items.js';
import { MessageSynth } from './normalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '__fixtures__', 'codex-turns.json'), 'utf8'));

describe('codexTurnsToMessages', () => {
  it('converts a page of turns (newest-first from the API) into chronological SDK-shaped messages', () => {
    // thread/turns/list returns newest-first; callers reverse into chronological order before converting.
    const turns = [...fixture.data].reverse();
    const msgs = codexTurnsToMessages('codex-x', turns);

    // historical conversion only wants terminal messages, not the streaming scaffolding
    expect(msgs.some((m: any) => m.type === 'stream_event')).toBe(false);

    // first message is the first userMessage's text, verbatim
    const firstUser = msgs.find((m: any) => m.type === 'user' && m.message?.content?.[0]?.type === 'text');
    expect(firstUser).toBeTruthy();
    expect(firstUser.message.content[0].text).toBe('为什么这个函数在输入为空时会报错？');
    expect(msgs[0]).toBe(firstUser);

    // commandExecution -> Bash tool_use + matching tool_result
    const bashUse = msgs.find((m: any) => m.type === 'assistant' && m.message.content.some((c: any) => c.type === 'tool_use' && c.name === 'Bash'));
    expect(bashUse).toBeTruthy();
    const bashId = bashUse.message.content.find((c: any) => c.type === 'tool_use').id;
    const bashResult = msgs.find((m: any) => m.type === 'user' && m.message.content[0]?.type === 'tool_result' && m.message.content[0].tool_use_id === bashId);
    expect(bashResult).toBeTruthy();

    // fileChange -> Edit or Write tool_use
    const fileUse = msgs.find((m: any) => m.type === 'assistant' && m.message.content.some((c: any) => c.type === 'tool_use' && (c.name === 'Edit' || c.name === 'Write')));
    expect(fileUse).toBeTruthy();

    // every turn ends with a result
    const results = msgs.filter((m: any) => m.type === 'result');
    expect(results.length).toBe(2);

    // sessionId is threaded through onto the messages that carry it
    expect(firstUser.session_id).toBe('codex-x');
    expect(results.every((m: any) => m.session_id === 'codex-x')).toBe(true);
  });
});

describe('codexItemMessages (fileChange kind)', () => {
  // PatchChangeKind is an object per `codex app-server generate-ts`, not the bare string 'add' —
  // this is the same function the live CodexDriver.onItem uses, so it covers both paths.
  it('a newly added file (kind: {type: "add"}) renders as a Write tool_use', () => {
    const synth = new MessageSynth('codex-x', '');
    const seen: CodexItemState = new Map();
    const item = { id: 'fc-1', type: 'fileChange', status: 'completed', changes: [{ path: '/work/demo/app/new-file.ts', kind: { type: 'add' }, diff: '+content' }] };
    const msgs = codexItemMessages(synth, seen, item, true);
    const use = msgs.find((m: any) => m.type === 'assistant' && m.message.content.some((c: any) => c.type === 'tool_use'));
    expect(use.message.content[0].name).toBe('Write');
  });

  it('a modified file (kind: {type: "update"}) renders as an Edit tool_use', () => {
    const synth = new MessageSynth('codex-x', '');
    const seen: CodexItemState = new Map();
    const item = { id: 'fc-2', type: 'fileChange', status: 'completed', changes: [{ path: '/work/demo/app/existing.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' }] };
    const msgs = codexItemMessages(synth, seen, item, true);
    const use = msgs.find((m: any) => m.type === 'assistant' && m.message.content.some((c: any) => c.type === 'tool_use'));
    expect(use.message.content[0].name).toBe('Edit');
  });
});
