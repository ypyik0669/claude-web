import { describe, expect, it } from 'vitest';
import { REQUIRED_MARK, firstLine, isRequired, manualDownloadUrl, notesText, releasePage, updateMode } from './update-policy';

describe('which builds update themselves', () => {
  it('only the Windows installer downloads and installs; portable, macOS (unsigned) and Linux get a download link', () => {
    expect(updateMode('win32', {})).toBe('auto');
    expect(updateMode('win32', { PORTABLE_EXECUTABLE_FILE: 'D:\\apps\\ClaudeWeb-0.1.2-portable.exe' })).toBe('manual');
    expect(updateMode('darwin', {})).toBe('manual');
    expect(updateMode('linux', {})).toBe('manual');
  });
});

describe('release notes', () => {
  it('GitHub gives the body as HTML: paragraphs, list items and line breaks survive as lines, entities are decoded', () => {
    const html = '<h2>修复</h2>\n<ul>\n<li><strong>停止</strong>一定能停下来。</li>\n<li>A &amp; B &lt;ok&gt; &#x4e2d;&#25991;</li>\n</ul>\n<p>第一行<br>第二行</p>';
    expect(notesText(html)).toBe('修复\n\n• 停止一定能停下来。\n• A & B <ok> 中文\n\n第一行\n第二行');
  });

  it('full changelogs come as an array; nothing usable is undefined', () => {
    expect(notesText([{ version: '0.1.3', note: '<p>三</p>' }, { version: '0.1.2', note: null }, { version: '0.1.1', note: '二' }])).toBe('三\n\n二');
    expect(notesText(undefined)).toBeUndefined();
    expect(notesText('   ')).toBeUndefined();
    expect(notesText({})).toBeUndefined();
  });

  it('a release marked 必须更新 in its notes cannot be put off', () => {
    expect(isRequired(notesText(`<p><strong>${REQUIRED_MARK}</strong> 修复了会丢数据的问题</p>`))).toBe(true);
    expect(isRequired('必须更新')).toBe(false); // only the exact mark, not the words in passing
    expect(isRequired(undefined)).toBe(false);
  });
});

describe('where a build that cannot update itself downloads from', () => {
  const repo = 'ypyik0669/claude-web';
  it('its own kind of file, for this machine', () => {
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'darwin', arch: 'arm64' })).toBe('https://github.com/ypyik0669/claude-web/releases/download/v0.1.3/ClaudeWeb-0.1.3-mac-arm64.dmg');
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'darwin', arch: 'x64' })).toBe('https://github.com/ypyik0669/claude-web/releases/download/v0.1.3/ClaudeWeb-0.1.3-mac-x64.dmg');
    // the Intel build running under Rosetta on Apple Silicon: offer the native one
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'darwin', arch: 'x64', arm64Translated: true })).toMatch(/mac-arm64\.dmg$/);
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'win32', arch: 'x64', portable: true })).toMatch(/\/ClaudeWeb-0\.1\.3-portable\.exe$/);
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'win32', arch: 'x64' })).toMatch(/\/ClaudeWeb-0\.1\.3-win-x64\.exe$/);
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'linux', arch: 'x64' })).toBe(releasePage(repo, '0.1.3'));
    expect(manualDownloadUrl({ repo, version: '9.9.9', platform: 'darwin', arch: 'arm64', feed: 'http://127.0.0.1:5000/feed' })).toBe('http://127.0.0.1:5000/feed/ClaudeWeb-9.9.9-mac-arm64.dmg');
  });
});

it('errors keep their first line only', () => {
  expect(firstLine(new Error('HttpError: 404\n"method: GET url: …"\nheaders…'))).toBe('HttpError: 404');
});
