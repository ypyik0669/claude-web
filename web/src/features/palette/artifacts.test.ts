import { describe, expect, it } from 'vitest';
import type { ArtifactRef } from '@shared';
import { artifactHits } from './artifacts';

const a = (path: string, title: string, at: number): ArtifactRef => ({ path, title, at, sessionId: `s-${at}` });

describe('artifactHits: what 搜索 finds among the Artifacts (redesign 2026-11 stage 3)', () => {
  const items = [
    a('C:\\work\\claude-web\\docs\\report.html', 'write the weekly report', 3),
    a('C:\\work\\claude-web\\out\\chart.png', 'plot the sales', 5),
    a('/home/me/shop/checkout.html', 'checkout redesign', 4),
    a('/home/me/shop/notes/report-old.md', 'old notes', 1),
  ];
  it('no query: none', () => expect(artifactHits(items, '  ')).toEqual([]));
  it('the file name first, then the conversation, then the folder; newest first in each', () => {
    expect(artifactHits(items, 'report').map((x) => x.at)).toEqual([3, 1]);
    expect(artifactHits(items, 'sales').map((x) => x.at)).toEqual([5]);
    expect(artifactHits(items, 'shop').map((x) => x.at)).toEqual([4, 1]);
  });
  it('not the whole path: a folder far up matches nothing', () => {
    expect(artifactHits(items, 'work')).toEqual([]);
    expect(artifactHits(items, 'home')).toEqual([]);
  });
  it('case-insensitive, capped', () => {
    expect(artifactHits(items, 'CHECKOUT').map((x) => x.at)).toEqual([4]);
    expect(artifactHits(items, 'html', 1).length).toBe(1);
  });
});
