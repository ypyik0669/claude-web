import { describe, expect, it } from 'vitest';
import { strip, trialResult } from './trial-report';

describe('the opening-pack skill\'s trial run: what goes back to the server', () => {
  it('the page\'s report, flattened: errors as text, the frame times, no picture where nothing can draw one', async () => {
    const r = await trialResult({ end: 'cut', at: 12.01, errors: ['ReferenceError: x is not defined', 3], stats: { avgMs: 16.7, maxMs: 40, frames: 700 }, snaps: [{ at: 1, png: 'data:image/png;base64,AAAA' }] });
    expect(r).toEqual({ end: 'cut', at: 12.01, errors: ['ReferenceError: x is not defined', '3'], avgMs: 16.7, maxMs: 40, frames: 700 });
  });
  it('a report with nothing in it is still an answer', async () => {
    expect(await trialResult({})).toEqual({ errors: [] });
    expect(await trialResult({ end: 'done', at: 3.4, stats: null })).toEqual({ end: 'done', at: 3.4, errors: [] });
  });
  it('no pictures, no strip', async () => {
    expect(await strip([])).toBeUndefined();
  });
});
