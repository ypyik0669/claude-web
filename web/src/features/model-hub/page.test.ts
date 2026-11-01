import { describe, expect, it } from 'vitest';
import { HUB_PAGES, hubPage } from './page';

describe('the hub pages', () => {
  it('are the four first-level pages, in order', () => {
    expect(HUB_PAGES.map((p) => p.id)).toEqual(['usage', 'privacy', 'control', 'settings']);
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

  it('hubPage falls back to the first page for an unknown id', () => {
    expect(hubPage('usage').id).toBe('usage');
    expect(hubPage('nope' as never).id).toBe('usage');
  });
});
