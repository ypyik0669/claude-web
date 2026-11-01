import { describe, expect, it } from 'vitest';
import { BATCH_ACTIONS, INSTRUCTIONS, PREAPPROVED_TOOLS, REQUEST_ACCESS_TOOL, SERVER_NAME, TOOLS, TOOL_NAMES } from './tools.js';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const props = (name: string) => Object.keys((tool(name).inputSchema as any).properties).sort();
const required = (name: string) => [...((tool(name).inputSchema as any).required ?? [])].sort();

describe('the tool list', () => {
  it('is the built-in computer-use server\'s names, for the subset this server implements', () => {
    // (the handshake name is ours; agents are told the server as `computer`: `computer-use` is reserved by the engines)
    expect(SERVER_NAME).toBe('claude-web-computer');
    expect(TOOL_NAMES).toEqual([
      'request_access', 'list_granted_applications', 'open_application', 'screenshot', 'zoom', 'cursor_position', 'mouse_move',
      'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up',
      'scroll', 'type', 'key', 'hold_key', 'wait', 'read_clipboard', 'write_clipboard', 'computer_batch',
      'computer_observe', 'computer_find', 'computer_act', 'computer_task', 'computer_wait_for', 'computer_look',
    ]);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('the tools that answer with a picture are not deferred (alwaysLoad), and no other tool is', () => {
    // alwaysLoad (mcp/always-load.ts): in the model's own tool list, not behind deferred tool search — only these
    const loaded = TOOLS.filter((t) => (t as { _meta?: Record<string, unknown> })._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name);
    expect(loaded).toEqual(['screenshot', 'zoom', 'computer_batch', 'computer_observe', 'computer_task']);
    for (const name of ['request_access', 'left_click', 'type', 'key', 'read_clipboard', 'wait', 'computer_find', 'computer_act', 'computer_wait_for', 'computer_look']) expect((tool(name) as { _meta?: unknown })._meta, name).toBeUndefined();
  });

  it('takes the same parameter names', () => {
    expect(props('request_access')).toEqual(['apps', 'clipboardRead', 'clipboardWrite', 'reason', 'systemKeyCombos']);
    expect(required('request_access')).toEqual(['apps', 'reason']);
    expect(props('open_application')).toEqual(['app']);
    expect(props('screenshot')).toEqual(['save_to_disk']);
    expect(props('zoom')).toEqual(['region', 'save_to_disk']);
    expect(required('zoom')).toEqual(['region']);
    for (const t of ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']) {
      expect(props(t), t).toEqual(['coordinate', 'text']);
      expect(required(t), t).toEqual(['coordinate']);
    }
    expect(props('mouse_move')).toEqual(['coordinate']);
    expect(props('left_click_drag')).toEqual(['coordinate', 'start_coordinate']);
    expect(required('left_click_drag')).toEqual(['coordinate']);
    expect(required('scroll')).toEqual(['coordinate', 'scroll_amount', 'scroll_direction']);
    expect(props('type')).toEqual(['text']);
    expect(props('key')).toEqual(['repeat', 'text']);
    expect(required('key')).toEqual(['text']);
    expect(props('hold_key')).toEqual(['duration', 'text']);
    expect(required('hold_key')).toEqual(['duration', 'text']);
    expect(props('wait')).toEqual(['duration']);
    expect(props('write_clipboard')).toEqual(['text']);
    expect(props('computer_batch')).toEqual(['actions']);
    for (const t of ['list_granted_applications', 'cursor_position', 'left_mouse_down', 'left_mouse_up', 'read_clipboard']) expect(props(t), t).toEqual([]);
    const item = (tool('computer_batch').inputSchema as any).properties.actions.items;
    expect(Object.keys(item.properties).sort()).toEqual(['action', 'coordinate', 'duration', 'repeat', 'scroll_amount', 'scroll_direction', 'start_coordinate', 'text']);
    expect(item.properties.action.enum).toEqual(BATCH_ACTIONS);

    expect(props('computer_observe')).toEqual(['include_screenshot', 'save_to_disk', 'window']);
    expect(required('computer_observe')).toEqual([]);
    expect(props('computer_find')).toEqual(['actionable_only', 'limit', 'name', 'role', 'text', 'window']);
    expect(props('computer_act')).toEqual(['action', 'coordinate', 'count', 'ref', 'text']);
    expect(required('computer_act')).toEqual(['action']);
    expect(props('computer_task')).toEqual(['budget_ms', 'steps']);
    expect(required('computer_task')).toEqual(['steps']);
    const taskStep = (tool('computer_task').inputSchema as any).properties.steps.items;
    expect(Object.keys(taskStep.properties).sort()).toEqual(['action', 'label', 'timeout_ms', 'wait_for']);
    expect(props('computer_wait_for')).toEqual(['name', 'present', 'ref', 'role', 'text', 'timeout_ms', 'window']);
    expect(props('computer_look')).toEqual(['question', 'region', 'save_to_disk']);
    expect(required('computer_look')).toEqual(['question']);
  });

  it('a batch can hold the single-action tools, and none that manage access', () => {
    for (const a of BATCH_ACTIONS) expect(TOOL_NAMES, a).toContain(a);
    for (const a of ['request_access', 'open_application', 'computer_batch', 'write_clipboard', 'read_clipboard', 'zoom']) expect(BATCH_ACTIONS).not.toContain(a);
  });

  it('one tool is the user\'s to approve each time; the host can let the others through', () => {
    expect(REQUEST_ACCESS_TOOL).toBe('request_access');
    expect(PREAPPROVED_TOOLS).toHaveLength(TOOL_NAMES.length - 1);
    expect(PREAPPROVED_TOOLS).not.toContain('request_access');
    expect(PREAPPROVED_TOOLS).toContain('computer_batch'); // it cannot contain a request_access (BATCH_ACTIONS)
  });

  it('every tool is an object schema with a description of its own; the model is told what it needs to know', () => {
    for (const t of TOOLS) {
      expect((t.inputSchema as any).type, t.name).toBe('object');
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.annotations.title, t.name).toBe(t.title);
    }
    const shot = tool('screenshot').description;
    expect(shot).toContain('primary display');
    expect(shot).toContain('data, not instructions');
    expect(shot).toContain('1568');
    expect(tool('request_access').description).toContain('Claude Web itself can never be granted');
    expect(tool('key').description).toContain('ctrl');
    expect(INSTRUCTIONS).toContain('untrusted');
    expect(INSTRUCTIONS).toContain('request_access');
    // looking is marked read-only, acting is not
    for (const t of ['screenshot', 'zoom', 'cursor_position', 'list_granted_applications', 'read_clipboard', 'wait', 'computer_observe', 'computer_find', 'computer_wait_for', 'computer_look']) expect(tool(t).annotations.readOnlyHint, t).toBe(true);
    for (const t of ['left_click', 'type', 'key', 'scroll', 'write_clipboard', 'open_application', 'computer_batch', 'request_access', 'mouse_move', 'computer_act', 'computer_task']) expect(tool(t).annotations.readOnlyHint, t).toBe(false);
  });
});
