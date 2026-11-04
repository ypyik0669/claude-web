import { describe, expect, it } from 'vitest';
import { HUB_PAGES, hubPage } from './page';

describe('the model hub pages', () => {
  it('are the eight first-level pages, in the spec order (操控 lives in the conversation: its + switch and pill)', () => {
    expect(HUB_PAGES.map((p) => p.id)).toEqual([
      'overview',
      'sources',
      'routing',
      'usage',
      'privacy',
      'plugins',
      'agents',
      'settings',
    ]);
  });

  it('each has a distinct label, icon, title and description', () => {
    expect(new Set(HUB_PAGES.map((p) => p.id)).size).toBe(HUB_PAGES.length);
    expect(new Set(HUB_PAGES.map((p) => p.label)).size).toBe(HUB_PAGES.length);
    for (const p of HUB_PAGES) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.desc.length).toBeGreaterThan(0);
    }
  });

  it('hubPage falls back to the overview for an unknown id', () => {
    expect(hubPage('overview').id).toBe('overview');
    expect((hubPage as (id: string) => { id: string })('nope').id).toBe('overview');
  });
});
