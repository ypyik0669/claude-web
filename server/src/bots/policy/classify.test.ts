// server/src/bots/policy/classify.test.ts
import { describe, it, expect } from 'vitest';
import { classify, summarize, targetOf } from './classify.js';

describe('classify', () => {
  it('reads: Read / Glob / Grep / WebFetch GET / web.search', () => {
    expect(classify('Read', { file_path: '/a' })).toBe('read');
    expect(classify('Grep', { pattern: 'x' })).toBe('read');
    expect(classify('WebFetch', { url: 'https://x.com' })).toBe('read');
    expect(classify('ExecuteExtraTool', { tool_name: 'web.search', params: {} })).toBe('read');
  });
  it('local writes: Edit / Write / NotebookEdit, and Bash that stays local', () => {
    expect(classify('Edit', { file_path: '/a' })).toBe('write_local');
    expect(classify('Bash', { command: 'npm test' })).toBe('write_local');
    expect(classify('Bash', { command: 'git commit -m x' })).toBe('write_local');
  });
  it('sends: git push, gh pr create, curl POST, IM / mail tools', () => {
    expect(classify('Bash', { command: 'git push origin main' })).toBe('send');
    expect(classify('Bash', { command: 'gh pr create --title x' })).toBe('send');
    expect(classify('Bash', { command: 'curl -X POST https://api.example.com/x' })).toBe('send');
    expect(classify('ExecuteExtraTool', { tool_name: 'mcp__slack__send_message', params: { channel: 'C1' } })).toBe('send');
  });
  it('irreversible deletes: rm -rf, git push --delete, git branch -D, deleting mail', () => {
    expect(classify('Bash', { command: 'rm -rf dist' })).toBe('delete');
    expect(classify('Bash', { command: 'git push origin --delete feature' })).toBe('delete');
    expect(classify('Bash', { command: 'git branch -D x' })).toBe('delete');
    expect(classify('ExecuteExtraTool', { tool_name: 'mcp__gmail__delete_message', params: {} })).toBe('delete');
  });
  it('pay: known payment hosts and amount-bearing form submits', () => {
    expect(classify('Bash', { command: 'curl https://api.stripe.com/v1/charges -d amount=100' })).toBe('pay');
    expect(classify('ExecuteExtraTool', { tool_name: 'browser_click', params: { url: 'https://checkout.stripe.com/pay' } })).toBe('pay');
  });
  it('install: npm i -g, pip install, brew, apt, winget, claude plugin install', () => {
    expect(classify('Bash', { command: 'npm i -g foo' })).toBe('install');
    expect(classify('Bash', { command: 'pip install requests' })).toBe('install');
    expect(classify('Bash', { command: 'claude plugin install x' })).toBe('install');
  });
  it('browser / computer tools are browser', () => {
    expect(classify('ExecuteExtraTool', { tool_name: 'ego_browser', params: {} })).toBe('browser');
    expect(classify('ExecuteExtraTool', { tool_name: 'browser_computer', params: { action: 'left_click' } })).toBe('browser');
    expect(classify('ExecuteExtraTool', { tool_name: 'computer.click', params: {} })).toBe('browser');
  });
  it('unknown tools count as send (the safe side)', () => {
    expect(classify('SomethingNew', {})).toBe('send');
    expect(classify('ExecuteExtraTool', { tool_name: 'mcp__foo__bar', params: {} })).toBe('send');
  });
  it('summarize is one short line', () => {
    expect(summarize('Bash', { command: 'git push origin main' })).toBe('Bash: git push origin main');
    expect(summarize('Edit', { file_path: '/a/b.ts', old_string: 'x'.repeat(500) }).length).toBeLessThanOrEqual(160);
  });
  it('targetOf picks the domain / channel / amount the scope rules match on', () => {
    expect(targetOf('send', 'Bash', { command: 'curl -X POST https://api.example.com/x' })).toEqual({ domain: 'api.example.com' });
    expect(targetOf('send', 'ExecuteExtraTool', { tool_name: 'mcp__slack__send_message', params: { channel: 'C1' } })).toEqual({ channel: 'C1' });
    expect(targetOf('pay', 'Bash', { command: 'curl https://api.stripe.com/v1/charges -d amount=100' })).toEqual({ domain: 'api.stripe.com', amount: 100 });
  });
});
