import { describe, expect, it } from 'vitest';
import { createConversation, type AssistantItem, type Conversation, type ToolUseBlock } from '@/model/conversation';
import { lastScreen } from './profile-model';

const tool = (id: string, name: string, images?: string[], ts?: string, input: Record<string, unknown> = {}): ToolUseBlock => ({
  type: 'tool_use', id, name, input, children: [], status: 'done', result: { content: '', isError: false, images, ts },
});
const asst = (id: string, blocks: ToolUseBlock[], ts?: string): AssistantItem => ({ kind: 'assistant', id, blocks, streaming: false, parentToolUseId: null, ts });
const conv = (items: AssistantItem[]): Conversation => ({ ...createConversation(), items });

describe('lastScreen', () => {
  it('the newest image a browser / computer tool returned, with its time', () => {
    const c = conv([
      asst('1', [tool('t1', 'mcp__web__browser_screenshot', ['data:image/png;base64,AAA'], '2026-10-31T09:00:00Z')]),
      asst('2', [tool('t2', 'mcp__computer__screenshot', ['data:image/png;base64,BBB', 'data:image/png;base64,CCC'], '2026-10-31T09:05:00Z'), tool('t3', 'Read', ['data:image/png;base64,DDD'])]),
      asst('3', [tool('t4', 'mcp__web__browser_click')]),
    ]);
    expect(lastScreen(c)).toEqual({ src: 'data:image/png;base64,CCC', at: Date.parse('2026-10-31T09:05:00Z'), tool: 'mcp__computer__screenshot' });
  });
  it('a call wrapped in ExecuteExtraTool counts by its inner name; the item time stands in for a missing result time', () => {
    const c = conv([asst('1', [tool('t1', 'ExecuteExtraTool', ['data:image/png;base64,EEE'], undefined, { tool_name: 'mcp__web__browser_computer' })], '2026-10-31T10:00:00Z')]);
    expect(lastScreen(c)).toEqual({ src: 'data:image/png;base64,EEE', at: Date.parse('2026-10-31T10:00:00Z'), tool: 'mcp__web__browser_computer' });
  });
  it('none: undefined (no conversation, no images, only other tools)', () => {
    expect(lastScreen(undefined)).toBeUndefined();
    expect(lastScreen(conv([asst('1', [tool('t1', 'Read', ['data:image/png;base64,X']), tool('t2', 'mcp__web__browser_navigate')])]))).toBeUndefined();
  });
});
