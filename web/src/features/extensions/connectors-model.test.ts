import { describe, expect, it } from 'vitest';
import { MCP_CATALOG } from '@/features/settings/mcp-catalog';
import { connectorNeeds, connectorStatus, filterCatalog } from './connectors-model';
import { brandColor, connectorLook, luminance } from './brands';

describe('a connected entry says one thing', () => {
  it('reads the three outcomes of the status line the CLI printed', () => {
    expect(connectorStatus({ name: 'a', status: '✓ Connected' })).toEqual({ tone: 'ok', text: '已连接' });
    expect(connectorStatus({ name: 'a', status: '⚠ Needs authentication' }).tone).toBe('warn');
    expect(connectorStatus({ name: 'a', status: '✗ Failed to connect' })).toEqual({ tone: 'err', text: '连不上：Failed to connect' });
    expect(connectorStatus({ name: 'a' })).toEqual({ tone: '', text: '已添加' });
    // "not connected" is not "connected"
    expect(connectorStatus({ name: 'a', status: 'Not connected' }).tone).not.toBe('ok');
  });
  it('a health check that just ran wins over the old line', () => {
    expect(connectorStatus({ name: 'a', status: '✗ Failed to connect' }, { name: 'a', status: 'connected', detail: '' })).toEqual({ tone: 'ok', text: '已连接' });
    expect(connectorStatus({ name: 'a', status: '✓ Connected' }, { name: 'a', status: 'failed', detail: 'ECONNREFUSED' })).toEqual({ tone: 'err', text: '连不上：ECONNREFUSED' });
    expect(connectorStatus({ name: 'a' }, { name: 'a', status: 'needs-auth', detail: '' }).text).toContain('/mcp');
  });
});

describe('what adding asks for', () => {
  it('a login, keys, or nothing', () => {
    expect(connectorNeeds({ oauth: true })?.label).toBe('要登录');
    expect(connectorNeeds({ env: ['A_KEY', 'B_ID'] })).toEqual({ label: '要密钥', title: '添加时要填：A_KEY、B_ID' });
    expect(connectorNeeds({})).toBeNull();
    expect(connectorNeeds({ env: [] })).toBeNull();
  });
});

describe('filtering the directory', () => {
  it('by category and by every word typed', () => {
    expect(filterCatalog(MCP_CATALOG, { cat: '全部', query: '' })).toHaveLength(MCP_CATALOG.length);
    const dev = filterCatalog(MCP_CATALOG, { cat: '开发', query: '' });
    expect(dev.length).toBeGreaterThan(0);
    expect(dev.every((c) => c.cat === '开发')).toBe(true);
    expect(filterCatalog(MCP_CATALOG, { cat: '全部', query: 'GITHUB' }).map((c) => c.id)).toEqual(['github']);
    expect(filterCatalog(MCP_CATALOG, { cat: '全部', query: 'git 仓库' }).map((c) => c.id)).toEqual(['github']);
    expect(filterCatalog(MCP_CATALOG, { cat: '设计', query: 'github' })).toEqual([]);
  });
});

describe('how a connector looks', () => {
  it('every catalog entry gets a tile: a mark, or one of our icons', () => {
    for (const c of MCP_CATALOG) {
      const look = connectorLook(c.id);
      expect(look.icon, c.id).toBeTruthy();
      if (look.brand) expect(look.brand.path.length, c.id).toBeGreaterThan(20);
    }
    // an unknown name (a server added by hand) still gets one
    expect(connectorLook('my-own-server')).toEqual({ icon: 'mcp', tint: 'ink' });
  });
  it('a mark too dark or too light for a tile is drawn in the text colour', () => {
    expect(luminance('000000')).toBe(0);
    expect(luminance('ffffff')).toBeCloseTo(1);
    expect(brandColor('181717')).toBe('var(--ink-1)');
    expect(brandColor('ffffff')).toBe('var(--ink-1)');
    expect(brandColor('f24e1e')).toBe('#f24e1e');
  });
});
