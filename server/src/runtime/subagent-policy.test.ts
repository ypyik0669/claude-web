import { describe, expect, it } from 'vitest';
import { DELEGATED_TOOLS, delegateDecision, subagentModelName, subagentPolicyPrompt } from './subagent-policy.js';

describe('subagent policy (子代理硬绑定)', () => {
  it('names the model of a pick, from another provider too', () => {
    expect(subagentModelName('cw-x:ntuxdq7p:deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(subagentModelName('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('a picked model: a section telling the main model to delegate, without being asked', () => {
    const p = subagentPolicyPrompt('cw-x:ds:deepseek-v4.1-flash');
    expect(p).toMatch(/^# Subagents\n/);
    expect(p).toContain('(deepseek-v4.1-flash)');
    expect(p).toContain('does not need to ask for subagents');
    expect(p).toContain('Agent tool');
  });

  it('same as the main model: nothing', () => {
    expect(subagentPolicyPrompt('')).toBe('');
    expect(subagentPolicyPrompt(undefined)).toBe('');
  });

  it("the main thread's work tools are refused with a pointer to the Agent tool; a subagent's calls and the other tools pass", () => {
    const pick = 'cw-x:ds:deepseek-v4.1-flash';
    for (const t of ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']) {
      const d = delegateDecision(t, undefined, pick);
      expect(d?.reason).toContain('Agent tool');
      expect(d?.reason).toContain('(deepseek-v4.1-flash)');
      expect(delegateDecision(t, 'a1b2c3', pick)).toBeNull(); // a subagent's own call
    }
    for (const t of ['Agent', 'Task', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Skill', 'mcp__web__web_search']) expect(delegateDecision(t, undefined, pick)).toBeNull();
    // 跟主模型一样 picked again (the process not restarted yet): nothing refused any more
    expect(delegateDecision('Read', undefined, '')).toBeNull();
    expect(delegateDecision('Read', undefined, undefined)).toBeNull();
    // the section says so, so the main model does not try first
    expect(subagentPolicyPrompt(pick)).toContain('direct calls of Read, Write');
    expect([...DELEGATED_TOOLS]).toContain('Bash');
  });
});
