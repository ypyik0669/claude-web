import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexTurnsToMessages } from './codex-items.js';

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

    // sessionId is threaded through
    expect(msgs.every((m: any) => m.session_id === 'codex-x' || m.session_id === undefined)).toBe(true);
  });
});
