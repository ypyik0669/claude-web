import { describe, expect, it } from 'vitest';
import { tidyZoom, zoomChoices, zoomNotice, zoomPercent } from './zoom-math';

describe('界面缩放 · what the page shows', () => {
  it('a reported factor is tidied to two decimals; anything unreadable is 100%', () => {
    expect(tidyZoom(1.2500000000000002)).toBe(1.25);
    expect(tidyZoom(0.6700000000000001)).toBe(0.67);
    expect(tidyZoom(1)).toBe(1);
    for (const bad of [undefined, null, '1.5', NaN, 0, -1, Infinity]) expect(tidyZoom(bad), String(bad)).toBe(1);
  });

  it('reads as a percentage', () => {
    expect(zoomPercent(1)).toBe('100%');
    expect(zoomPercent(1.25)).toBe('125%');
    expect(zoomPercent(0.67)).toBe('67%');
    expect(zoomPercent(3)).toBe('300%');
  });

  it('a change says the new size; a request that did nothing says why', () => {
    const at = (zoom: number, max = 3) => ({ zoom, max, min: 0.5 });
    expect(zoomNotice({ ...at(1.25), changed: true, ask: 'in' })).toBe('界面缩放 125%');
    expect(zoomNotice({ ...at(1), changed: true, ask: 'reset' })).toBe('界面缩放 100%');
    expect(zoomNotice({ ...at(1.5), changed: true, ask: 'set' })).toBe('界面缩放 150%');
    // the top of the list, and the top of what this screen can take, are different sentences
    expect(zoomNotice({ ...at(3), changed: false, ask: 'in' })).toBe('已经放到最大了（300%）');
    expect(zoomNotice({ ...at(1.5, 1.5), changed: false, ask: 'in' })).toBe('已经放到最大了（150%）：再大，窗口就放不进这块屏幕');
    expect(zoomNotice({ ...at(0.5), changed: false, ask: 'out' })).toBe('已经缩到最小了（50%）');
    expect(zoomNotice({ ...at(1), changed: false, ask: 'reset' })).toBe('界面缩放已经是 100%');
    expect(zoomNotice({ ...at(1.25), changed: false, ask: 'set' })).toBeNull(); // picked the value it already has
  });

  it('the control lists the steps this screen can take, and always the current one', () => {
    const steps = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    expect(zoomChoices(steps, { zoom: 1, max: 3 })).toEqual(steps);
    expect(zoomChoices(steps, { zoom: 1.25, max: 1.5 })).toEqual([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5]);
    // chosen on a bigger screen: still listed, so the select shows what is in use
    expect(zoomChoices(steps, { zoom: 2, max: 1.5 })).toEqual([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2]);
    // an older shell that does not send its steps
    expect(zoomChoices(undefined, { zoom: 1.25, max: 3 })).toEqual([1.25]);
  });
});
