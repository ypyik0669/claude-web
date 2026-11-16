import { describe, expect, it } from 'vitest';
import { MIME_FILE, filePayload, hasType, setFileDrag } from './dnd';

/** Enough of a DataTransfer for the helpers (vitest runs in node: no real one). */
function fakeDt() {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none',
    setData: (t: string, v: string) => { data.set(t, v); },
    getData: (t: string) => data.get(t) ?? '',
    get types() { return [...data.keys()]; },
  } as unknown as DataTransfer;
}

describe('文件树 → 对话 drag payload', () => {
  it('carries the paths as JSON and the plain text for drops outside the app', () => {
    const dt = fakeDt();
    setFileDrag(dt, ['C:\\work\\shop\\src', 'C:\\work\\shop\\a b.ts']);
    expect(hasType(dt, MIME_FILE)).toBe(true);
    expect(filePayload(dt)).toEqual(['C:\\work\\shop\\src', 'C:\\work\\shop\\a b.ts']);
    expect(dt.getData('text/plain')).toBe('C:\\work\\shop\\src\nC:\\work\\shop\\a b.ts');
  });

  it('nothing for other drags, junk, or no transfer at all', () => {
    const dt = fakeDt();
    dt.setData('text/plain', 'hello');
    expect(filePayload(dt)).toEqual([]);
    dt.setData(MIME_FILE, '{not json');
    expect(filePayload(dt)).toEqual([]);
    dt.setData(MIME_FILE, JSON.stringify([1, '', 'C:\\x']));
    expect(filePayload(dt)).toEqual(['C:\\x']);
    expect(filePayload(null)).toEqual([]);
  });
});
