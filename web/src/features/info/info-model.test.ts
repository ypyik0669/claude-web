import { describe, expect, it } from 'vitest';
import { connectorSummary, contextBreakdown, contextTitle, ctxCanRefresh, ctxLive, fmtTokens, fmtWindow, moveCard, normInfoLayout, nudgeCard, toggleCard, toneOf } from './info-model';

describe('上下文 card title (A7)', () => {
  it('a window: whole K, M from 1M (a decimal only when it is not whole)', () => {
    expect(fmtWindow(1_000_000)).toBe('1M');
    expect(fmtWindow(200_000)).toBe('200K');
    expect(fmtWindow(272_000)).toBe('272K');
    expect(fmtWindow(650_000)).toBe('650K');
    expect(fmtWindow(128_000)).toBe('128K');
    expect(fmtWindow(1_500_000)).toBe('1.5M');
    expect(fmtWindow(2_000_000)).toBe('2M');
    expect(fmtWindow(1_048_576)).toBe('1M');
    expect(fmtWindow(999_800)).toBe('1M');
  });
  it('the window, and where it compacts when that is below it', () => {
    expect(contextTitle(1_000_000, 700_000)).toBe('窗口 1M · 700K 内压缩');
    expect(contextTitle(272_000, 200_000)).toBe('窗口 272K · 200K 内压缩');
    expect(contextTitle(1_000_000)).toBe('窗口 1M');
    expect(contextTitle(200_000, 200_000)).toBe('窗口 200K');
    expect(contextTitle(200_000, 700_000)).toBe('窗口 200K');
    expect(contextTitle()).toBe('');
    expect(contextTitle(undefined, 700_000)).toBe('');
    expect(contextTitle(0, 0)).toBe('');
  });
});

describe('信息栏 layout', () => {
  it('a stored layout is repaired: unknown dropped, duplicates gone, new cards appended; context folded by default', () => {
    expect(normInfoLayout(undefined)).toEqual({ order: ['env', 'context', 'connectors', 'changes', 'background', 'pins'], collapsed: ['context'] });
    expect(normInfoLayout({ order: ['changes', 'bogus', 'changes', 'env'], collapsed: ['env', 'x'] })).toEqual({ order: ['changes', 'env', 'context', 'connectors', 'background', 'pins'], collapsed: ['env'] });
  });
  it('drag to before another card, or to the end; Alt+arrows swap neighbours', () => {
    const l = normInfoLayout(undefined);
    expect(moveCard(l, 'background', 'env').order).toEqual(['background', 'env', 'context', 'connectors', 'changes', 'pins']);
    expect(moveCard(l, 'env', null).order).toEqual(['context', 'connectors', 'changes', 'background', 'pins', 'env']);
    expect(nudgeCard(l, 'context', -1).order.slice(0, 2)).toEqual(['context', 'env']);
    expect(nudgeCard(l, 'env', -1)).toBe(l);
    expect(toggleCard(toggleCard(l, 'env'), 'env').collapsed).toEqual(['context']);
  });
});

describe('上下文 breakdown', () => {
  it('rows by kind with their share of the window; the deferred ones apart', () => {
    const b = contextBreakdown({
      totalTokens: 89_000, rawMaxTokens: 700_000, percentage: 13,
      categories: [
        { name: 'Messages', tokens: 19_600, color: 'x', kind: 'used' },
        { name: 'System tools', tokens: 16_100, color: 'y', kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
        { name: 'Free space', tokens: 578_000, kind: 'free' },
        { name: 'MCP tools (deferred)', tokens: 102_900, isDeferred: true },
      ],
      mcpTools: [{ name: 'mcp__web__search', serverName: 'web', tokens: 900 }],
      memoryFiles: [{ path: 'CLAUDE.md', type: 'Project', tokens: 2200 }],
      agents: [{ agentType: 'Explore', source: 'built-in', tokens: 300 }],
    })!;
    expect(b.percentage).toBe(13);
    expect(b.used.map((c) => [c.name, c.tone])).toEqual([['Messages', 'messages'], ['System tools', 'tools']]);
    expect(b.used[0].pct).toBeCloseTo(2.8, 1);
    expect(b.buffer[0].name).toBe('Autocompact buffer');
    expect(b.free[0].pct).toBeCloseTo(82.6, 1);
    expect(b.deferred.map((c) => c.name)).toEqual(['MCP tools (deferred)']);
    expect(b.mcpTools[0]).toEqual({ name: 'mcp__web__search', server: 'web', tokens: 900 });
    expect(b.agents[0].name).toBe('Explore');
    expect(contextBreakdown(null)).toBeNull();
  });
  it('token counts read short', () => {
    expect(fmtTokens(300)).toBe('300');
    expect(fmtTokens(19_600)).toBe('19.6k');
    expect(fmtTokens(578_000)).toBe('578k');
    expect(fmtTokens(1_000_000)).toBe('1.0M');
  });
  it('connectors: failed or waiting for a login need a hand', () => {
    expect(connectorSummary([{ name: 'a', status: 'connected' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'needs-auth' }, { name: 'd' }]).broken).toBe(2);
    expect(connectorSummary(undefined).rows).toEqual([]);
  });
});

describe('context colours (A5)', () => {
  it('each category always has its own colour; unknown names are grey', () => {
    expect(toneOf('Messages')).toBe('messages');
    expect(toneOf('System tools')).toBe('tools');
    expect(toneOf('[ANT-ONLY] System tools')).toBe('tools');
    expect(toneOf('MCP tools')).toBe('mcp');
    expect(toneOf('Skills')).toBe('skills');
    expect(toneOf('System prompt')).toBe('other');
    expect(toneOf('Something new')).toBe('other');
  });
  it('used categories biggest first; buffer / free / deferred kept apart', () => {
    const b = contextBreakdown({
      rawMaxTokens: 700_000, totalTokens: 520_000,
      categories: [
        { name: 'System prompt', tokens: 8600 },
        { name: 'Messages', tokens: 482_300 },
        { name: 'System tools', tokens: 16_500 },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
        { name: 'Free space', tokens: 89_500, kind: 'free' },
        { name: 'MCP tools (deferred)', tokens: 194_700, kind: 'deferred' },
      ],
    })!;
    expect(b.used.map((c) => c.name)).toEqual(['Messages', 'System tools', 'System prompt']);
    expect(b.used.map((c) => c.tone)).toEqual(['messages', 'tools', 'other']);
    expect(b.buffer.map((c) => c.name)).toEqual(['Autocompact buffer']);
    expect(b.deferred.map((c) => c.name)).toEqual(['MCP tools (deferred)']);
  });
  it('a CLI that leaves `kind` out (seen live): free space and the compact buffer still kept apart', () => {
    const b = contextBreakdown({
      rawMaxTokens: 200_000, totalTokens: 25_200,
      categories: [
        { name: 'System prompt', tokens: 7100, color: 'promptBorder' },
        { name: 'System tools', tokens: 15_300, color: 'inactive' },
        { name: 'Messages', tokens: 554, color: 'purple' },
        { name: 'Free space', tokens: 141_000, color: 'promptBorder' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive' },
        { name: 'MCP tools (deferred)', tokens: 4100, color: 'cyan', isDeferred: true },
      ],
    })!;
    expect(b.used.map((c) => c.name)).toEqual(['System tools', 'System prompt', 'Messages']);
    expect(b.free.map((c) => c.name)).toEqual(['Free space']);
    expect(b.buffer.map((c) => c.name)).toEqual(['Autocompact buffer']);
    expect(b.deferred.map((c) => c.name)).toEqual(['MCP tools (deferred)']);
  });
});

// 2026-10-24 review M3: 刷新 on a closed conversation's last count asked the engine, failed and said nothing
describe('context card: when it can count', () => {
  it('only a conversation running here (idle / running / waiting) is counted or offers 刷新', () => {
    for (const s of ['idle', 'running', 'waiting']) expect(ctxLive(s)).toBe(true);
    for (const s of ['history', 'closed', 'error', 'starting', undefined]) expect(ctxLive(s)).toBe(false);
  });
  it('刷新 shows only when live and not already counting', () => {
    expect(ctxCanRefresh('idle', false)).toBe(true);
    expect(ctxCanRefresh('idle', true)).toBe(false);
    expect(ctxCanRefresh('history', false)).toBe(false);
    expect(ctxCanRefresh('closed', false)).toBe(false);
    expect(ctxCanRefresh(undefined, false)).toBe(false);
  });
});
