import { describe, expect, it } from 'vitest';
import { handOverConfirmText, handOverMessage, turnRunning } from './handover-text';

describe('the hand-over confirm (re-review 3 Minor 2 / 3)', () => {
  it('running: this window\'s state, else the session list\'s live (IM, a schedule, another window)', () => {
    expect(turnRunning('running', undefined)).toBe(true);
    expect(turnRunning(undefined, 'waiting')).toBe(true); // not open here, driven elsewhere
    expect(turnRunning('history', 'running')).toBe(true); // only its transcript is loaded here
    expect(turnRunning('idle', 'running')).toBe(false); // this window's own runner state is the fresher one
    expect(turnRunning(undefined, undefined)).toBe(false);
    expect(turnRunning(undefined, 'idle')).toBe(false);
  });
  it('says 对话 throughout, the model as the menu shows it, the interruption only while running', () => {
    const t = handOverConfirmText({ sessionId: '5d1c1c1c-0000-4000-8000-000000000001', agentName: 'Codex', modelLabel: 'Codex 5.6 Sol', running: true });
    expect(t.title).toBe('把这个对话交给 Codex（Codex 5.6 Sol）？');
    expect(t.message.startsWith('对话正在运行，当前这一轮会被中断。')).toBe(true);
    expect(`${t.title}${t.message}`).not.toMatch(/会话/);
    const idle = handOverConfirmText({ sessionId: '5d1c1c1c-0000-4000-8000-000000000001', agentName: 'Codex', running: false });
    expect(idle.title).toBe('把这个对话交给 Codex？');
    expect(idle.message).not.toMatch(/中断/);
  });
  it('an imported conversation becomes a new one — also worded as 对话', () => {
    expect(handOverMessage('codex-abc')).toMatch(/^这是从其它 agent 导入的对话：交接会新建一个对话/);
    expect(handOverMessage('codex-abc')).not.toMatch(/会话/);
  });
});
