import { describe, expect, it } from 'vitest';
import { localImagePath } from './local-image';

describe('localImagePath (a picture given as a path on this computer)', () => {
  it('Windows paths, both slashes, with CJK (as micromark percent-encodes it)', () => {
    expect(localImagePath('C:\\Users\\YPY\\Downloads\\claude-web-3d网吧.gif')).toBe('C:\\Users\\YPY\\Downloads\\claude-web-3d网吧.gif');
    expect(localImagePath('C:%5CUsers%5CYPY%5CDownloads%5Cclaude-web-3d%E7%BD%91%E5%90%A7.gif')).toBe('C:\\Users\\YPY\\Downloads\\claude-web-3d网吧.gif');
    expect(localImagePath('D:/shots/a.PNG')).toBe('D:/shots/a.PNG');
  });
  it('file:// and POSIX absolute paths', () => {
    expect(localImagePath('file:///C:/tmp/x.png')).toBe('C:/tmp/x.png');
    expect(localImagePath('file:///Users/me/a%20b.jpg')).toBe('/Users/me/a b.jpg');
    expect(localImagePath('/tmp/shot.webp')).toBe('/tmp/shot.webp');
  });
  it('web pictures, the app\'s own paths and non-images stay as they are', () => {
    for (const s of ['https://x.io/a.png', 'data:image/png;base64,AAAA', 'blob:http://x/1', '/api/file?path=x.png', '//cdn.x/a.png', 'a.png', 'C:\\notes.txt', '']) expect(localImagePath(s)).toBeNull();
  });
});
