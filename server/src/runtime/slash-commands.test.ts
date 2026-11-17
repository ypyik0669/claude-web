import { describe, expect, it } from 'vitest';
import { engineOwnRows, normalizeCommands } from './slash-commands.js';

// rows as the two engines sent them (supportedCommands(), 2026-11-17), cut down
const OFFICIAL = [
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', builtin: true },
  { name: 'usage', description: "Show session cost, plan usage, and what's contributing to your limits", argumentHint: '', aliases: ['cost', 'stats'], builtin: true },
  { name: 'agents', description: '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/', argumentHint: '', builtin: true },
  { name: 'deep-research', description: 'Deep research harness — fan-out web search (dynamic workflow)', argumentHint: '', builtin: true },
  { name: '__remote-workflow', description: 'Run the workflow script delivered in this session', argumentHint: '', builtin: true },
  { name: 'template-skill', description: 'Replace with description of the skill and when Claude should use it. (user)', argumentHint: '', aliases: ['template'] },
  { name: 'superpowers:brainstorming', description: '(superpowers) You MUST use this before any creative work', argumentHint: '', aliases: ['brainstorming'] },
  { name: 'cctool:install', description: '(cctool) Wire the cctool statusline into settings.json', argumentHint: '' },
  { name: 'rea:trace_crash (MCP)', description: 'Correlate a crash symptom with static call and reference evidence', argumentHint: '' },
  { name: 'hud', description: '工作 HUD：打开面板', argumentHint: '[game|status]' },
];
const CCB = [
  { name: 'update-config', description: 'Use this skill to configure the Claude Code harness. (bundled)', argumentHint: '' },
  { name: 'compact', description: 'Clear conversation history but keep a summary in context.', argumentHint: '<optional custom summarization instructions>' },
  { name: 'brand-guidelines', description: "Applies Anthropic's official brand colors and typography. (user)", argumentHint: '' },
  { name: 'cctool:install', description: '(cctool) Wire the cctool statusline into settings.json', argumentHint: '' },
  { name: 'brand-guidelines', description: "(anthropic-skills) Applies Anthropic's official brand colors and typography.", argumentHint: '' },
  { name: 'dispatching-parallel-agents', description: '(superpowers) Use when facing 2+ independent tasks', argumentHint: '' },
  { name: 'craft-anything:core_feature_explain (MCP)', description: 'Find out how a feature works', argumentHint: '' },
];

const by = (list: ReturnType<typeof normalizeCommands>, name: string) => list.find((c) => c.name === name);

describe('normalizeCommands', () => {
  it('official binary: builtin flag, aliases, the source markers taken off the description', () => {
    const l = normalizeCommands(OFFICIAL);
    expect(by(l, 'compact')).toEqual({ name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', source: 'builtin' });
    expect(by(l, 'usage')?.aliases).toEqual(['cost', 'stats']);
    // a builtin's own bracket is not a plugin
    expect(by(l, 'agents')).toMatchObject({ source: 'builtin', description: '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/' });
    expect(by(l, 'deep-research')?.description).toContain('(dynamic workflow)');
    expect(by(l, '__remote-workflow')).toBeUndefined();
    expect(by(l, 'template-skill')).toMatchObject({ source: 'user', description: 'Replace with description of the skill and when Claude should use it.', aliases: ['template'] });
    expect(by(l, 'superpowers:brainstorming')).toMatchObject({ source: 'plugin', owner: 'superpowers', description: 'You MUST use this before any creative work', aliases: ['brainstorming'] });
    expect(by(l, 'cctool:install')).toMatchObject({ source: 'plugin', owner: 'cctool' });
    expect(by(l, 'rea:trace_crash (MCP)')).toMatchObject({ source: 'mcp', owner: 'rea' });
    // unmarked by an engine that marks its own: not its own
    expect(by(l, 'hud')?.source).toBe('other');
  });

  it('ccb: unmarked rows are its own, a plugin skill gets its namespaced name (no two rows of one name)', () => {
    const l = normalizeCommands(CCB);
    expect(by(l, 'update-config')).toMatchObject({ source: 'bundled', description: 'Use this skill to configure the Claude Code harness.' });
    expect(by(l, 'compact')?.source).toBe('builtin');
    expect(by(l, 'brand-guidelines')).toMatchObject({ source: 'user' });
    expect(by(l, 'anthropic-skills:brand-guidelines')).toMatchObject({ source: 'plugin', owner: 'anthropic-skills', aliases: ['brand-guidelines'] });
    expect(by(l, 'superpowers:dispatching-parallel-agents')).toMatchObject({ source: 'plugin', owner: 'superpowers', aliases: ['dispatching-parallel-agents'] });
    expect(by(l, 'cctool:install')?.aliases).toBeUndefined();
    expect(by(l, 'craft-anything:core_feature_explain (MCP)')?.source).toBe('mcp');
    expect(new Set(l.map((c) => c.name.toLowerCase())).size).toBe(l.length);
  });

  it('project suffixes with a folder, managed ones, the old snake_case hint, garbage rows', () => {
    const l = normalizeCommands([
      { name: 'component', description: 'Make a component (project:frontend)', argument_hint: '<name>' },
      { name: 'policy-thing', description: 'From the admin (managed)' },
      null, 3, { description: 'no name' }, { name: '  ' },
    ]);
    expect(l).toEqual([
      { name: 'component', description: 'Make a component', argumentHint: '<name>', source: 'project' },
      { name: 'policy-thing', description: 'From the admin', argumentHint: '', source: 'other' },
    ]);
  });

  it('first row of a name wins, case-insensitively; normalizing twice changes nothing', () => {
    const once = normalizeCommands([...OFFICIAL, { name: 'Compact', description: 'again', builtin: true }]);
    expect(once.filter((c) => c.name.toLowerCase() === 'compact')).toHaveLength(1);
    expect(normalizeCommands(once)).toEqual(once);
    expect(normalizeCommands(undefined)).toEqual([]);
  });

  it('engineOwnRows keeps what is the same in every folder', () => {
    expect(engineOwnRows(normalizeCommands(CCB)).map((c) => c.name)).toEqual(['update-config', 'compact']);
  });
});
