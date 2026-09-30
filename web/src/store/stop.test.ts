import { describe, expect, it } from 'vitest';
import { applyMessage, createConversation } from '@/model/conversation';
import { classifyError } from '@/model/health';
import { STALE_STOP_TEXT, staleStopResult, stopFoundNothing } from './stop';

describe('Stop on a conversation the server no longer runs', () => {
  it('only an explicit running:false counts (an older server answers null)', () => {
    expect(stopFoundNothing({ running: false })).toBe(true);
    expect(stopFoundNothing({ running: true })).toBe(false);
    expect(stopFoundNothing(null)).toBe(false);
    expect(stopFoundNothing(undefined)).toBe(false);
  });

  it('the synthetic result ends the turn the window still shows, as an interruption', () => {
    const c = createConversation();
    applyMessage(c, { type: 'user', message: { role: 'user', content: '你好' }, uuid: 'u1' });
    expect(c.turnStartedAt).toBeDefined();
    applyMessage(c, staleStopResult('s1', 1000));
    expect(c.turnStartedAt).toBeUndefined();
    const r = c.items[c.items.length - 1] as any;
    expect(r).toMatchObject({ kind: 'result', isError: true, text: STALE_STOP_TEXT, errorKind: 'aborted' });
  });

  it("the server's forced stop is an interruption too, not an unknown error", () => {
    expect(classifyError({ terminalReason: 'aborted_forced', text: '已强制停止：运行内核没有响应中断' })).toBe('aborted');
  });
});
