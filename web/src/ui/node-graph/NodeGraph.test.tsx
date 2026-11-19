import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/ui/Select', () => ({ Select: () => null }));   // Select → Popover → ActionSheet pulls the store; not needed for markup
import { NodeGraph } from './NodeGraph';
import { normalizeNodeGraph } from './schema';
import { initialPicks } from './marks';
import { ACCESS_SAMPLE } from './sample';

const g = (() => { const r = normalizeNodeGraph(ACCESS_SAMPLE); if (!r.ok) throw new Error(r.error); return r.graph; })();
const html = (extra: Partial<Parameters<typeof NodeGraph>[0]> = {}) => renderToStaticMarkup(<NodeGraph graph={g} ariaLabel="t" {...extra} />);

describe('NodeGraph markup', () => {
  it('cards, edges with their styles, title and badge', () => {
    const h = html({ picks: initialPicks(g) });
    expect(h.match(/class="ng-card[ "]/g)).toHaveLength(5);
    expect(h).toContain('data-edge="e-open" data-style="error"');
    expect(h).toContain('data-edge="e-backup" data-style="dashed"');
    expect(h).toContain('Access settings');
    expect(h).toMatch(/class="ng-badge" data-tone="error"[^>]*>[^<]*1 open path/);
    expect(h).toContain('class="ng-zoom-pct"');
  });
  it('a pick re-marks the edge and recomputes the badge', () => {
    const h = html({ picks: { ...initialPicks(g), 'link/read': 'Admin' } });
    expect(h).toContain('data-edge="e-open" data-style="dashed"');
    expect(h).toContain('data-tone="ok"');
  });
  it('the travelling dot on error / strong edges, none above 150 cards', () => {
    expect(html()).toContain('<animateMotion');
    const big = { ...g, nodes: Array.from({ length: 151 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, rows: [] })), edges: [{ id: 'x', from: 'n0', to: 'n1', style: 'strong' as const }] };
    const h = renderToStaticMarkup(<NodeGraph graph={big} ariaLabel="t" />);
    expect(h).not.toContain('<animateMotion');
    expect(h).toContain('data-motion="off"');
  });
  it('no travelling dots above 300 edges (review D3)', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, rows: [] }));
    const edges = Array.from({ length: 301 }, (_, i) => ({ id: `e${i}`, from: `n${i % 30}`, to: `n${(i * 7 + 1) % 30}`, style: 'strong' as const }));
    expect(renderToStaticMarkup(<NodeGraph graph={{ nodes, edges }} ariaLabel="t" />)).toContain('data-motion="off"');
  });
  it('only cards that can be picked are Tab stops (review D-minor)', () => {
    const h = html({ onSelect: () => {}, canSelect: (id) => id === 'link' });
    expect(h.match(/class="ng-card[^"]*"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(h).toMatch(/data-node="link"[^>]*tabindex="0"/);
    expect(h.match(/tabindex="-1"/g)).toHaveLength(4);
    expect(html().match(/tabindex="-1"/g)).toHaveLength(5);
  });
  it('the ok badge carries a ✓ (review D-minor)', () => {
    const h = html({ picks: { ...initialPicks(g), 'link/read': 'Admin' } });
    expect(h).toMatch(/class="ng-badge" data-tone="ok"[^>]*><svg/);
  });
  it('a card whose id is a name on every object still renders (review D1)', () => {
    const tricky = normalizeNodeGraph({ nodes: [{ id: 'constructor', title: 'C' }, { id: '__proto__', title: 'P' }], edges: [{ from: 'constructor', to: '__proto__', label: 'x' }] });
    if (!tricky.ok) throw new Error(tricky.error);
    const h = renderToStaticMarkup(<NodeGraph graph={tricky.graph} ariaLabel="t" />);
    expect(h).toContain('data-node="__proto__"');
    expect(h).toContain('data-edge="constructor&gt;__proto__"');
    expect(h).not.toContain('NaN');
  });
  it('rows without onPick are plain text', () => {
    expect(html()).toMatch(/data-row="read"[^]*?class="v">Anyone</);
  });
  it('全屏查看 only where the owner offers it, right after 适应窗口: the 后台 / 编排 graphs keep their bar (issue #17)', () => {
    expect(html()).not.toContain('ng-full');
    expect(html({ onFullscreen: () => {} })).toMatch(/class="ng-fit"[^]*?<\/button><button type="button" class="ng-full" aria-label="全屏查看"[^>]*aria-haspopup="dialog"/);
  });
  it('a CSS height is passed through: the fullscreen viewer fills its stage (issue #17)', () => {
    expect(html({ height: '100%' })).toMatch(/class="ng"[^>]*style="height:100%;/);
    expect(html()).toMatch(/class="ng"[^>]*style="height:360px;/);
  });
});
