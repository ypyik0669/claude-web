import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request() { return null; } },
}));
let getToolDef: typeof import('./registry').getToolDef;
beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ getToolDef } = await import('./registry'));
});

// Our engine (ccb) runs MCP tools without alwaysLoad through ExecuteExtraTool { tool_name, params }: the step row says
// what the tool inside does, not 「ExecuteExtraTool tool_name=mcp__web__browser_open」.
describe('ExecuteExtraTool in the conversation', () => {
  it('labels the call as the tool inside', () => {
    expect(getToolDef('ExecuteExtraTool').label({ tool_name: 'mcp__web__browser_open', params: { url: 'https://example.com/' } })).toEqual(getToolDef('mcp__web__browser_open').label({ url: 'https://example.com/' }));
    expect(getToolDef('ExecuteExtraTool').label({ tool_name: 'Bash', params: { command: 'ls' } })).toEqual(getToolDef('Bash').label({ command: 'ls' }));
  });
  it('another server\'s tool: its server and name as the verb, its first argument as the target', () => {
    expect(getToolDef('ExecuteExtraTool').label({ tool_name: 'mcp__github__create_issue', params: { title: 'x' } })).toEqual({ verb: 'github · create_issue', arg: 'title=x' });
  });
  it('malformed → the generic label of the input', () => {
    expect(getToolDef('ExecuteExtraTool').label({ tool_name: 5, params: {} })).toEqual({ verb: '', arg: '' });
    expect(getToolDef('ExecuteExtraTool').label({ tool_name: 'mcp__web__browser_open', params: 'x' })).toEqual({ verb: '', arg: 'tool_name=mcp__web__browser_open' });
    expect(getToolDef('ExecuteExtraTool').label({ tool_name: 'ExecuteExtraTool', params: { tool_name: 'x' } })).toEqual({ verb: '', arg: 'tool_name=ExecuteExtraTool' });
  });
  it('SearchExtraTools reads as looking a tool up', () => {
    expect(getToolDef('SearchExtraTools').label({ query: 'select:mcp__web__browser_open' })).toEqual({ verb: '查找工具:', arg: 'select:mcp__web__browser_open' });
  });
});

// 2026-11-14 user report: a model sent AskUserQuestion's questions as a string — "e.questions?.map is not a function"
// took the whole conversation down, and again on every reopen (the call is in the transcript)
describe('a tool input that is not what the tool expects', () => {
  it('AskUserQuestion: questions as a JSON string, one bare object, or nonsense — a label, never a throw', () => {
    const label = getToolDef('AskUserQuestion').label;
    expect(label({ questions: JSON.stringify([{ question: 'A?' }, { question: 'B?' }]) }).arg).toBe('A? / B?');
    expect(label({ questions: { question: 'A?' } }).arg).toBe('A?');
    for (const questions of ['not json', 7, true, null, undefined, [null, 3, { header: 'x' }]]) expect(label({ questions }).arg).toBe('');
  });
  it('no label throws on a wrong-typed or missing input, for any tool', () => {
    const bad = [undefined, null, {}, { questions: 'x', todos: 'x', edits: 'x', file_path: 7, command: {}, tool_name: 5, params: 'x', url: [], prompt: null }];
    for (const name of ['AskUserQuestion', 'TodoWrite', 'MultiEdit', 'Edit', 'Read', 'Bash', 'Agent', 'Task', 'Skill', 'WebFetch', 'ExitPlanMode', 'ExecuteExtraTool', 'SearchExtraTools', 'mcp__web__browser_open', 'mcp__computer__left_click', 'mcp__x__y', 'Nope']) {
      for (const i of bad) expect(() => getToolDef(name).label(i as any), name).not.toThrow();
    }
  });
  it('the same def comes back each time (a new Body component would remount the card on every render)', () => {
    expect(getToolDef('AskUserQuestion')).toBe(getToolDef('AskUserQuestion'));
    expect(getToolDef('AskUserQuestion').Body).toBe(getToolDef('AskUserQuestion').Body);
  });
});
