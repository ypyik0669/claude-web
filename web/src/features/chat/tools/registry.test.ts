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

// Conversations from before 2026-11-01 may have turns on ccb (the Claude Code fork we used to run), which called MCP
// tools without alwaysLoad through ExecuteExtraTool { tool_name, params }: the step row says what the tool inside
// does, not 「ExecuteExtraTool tool_name=mcp__web__browser_open」.
describe('ExecuteExtraTool in an old conversation', () => {
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
