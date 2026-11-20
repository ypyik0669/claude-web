import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestSections, readChangelog } from './changelog.js';

const LOG = '# Changelog\r\n\r\nIntro text.\r\n\r\n## [0.3.0] — 2026-10-20\r\n\r\n- three\r\n\r\n## [0.2.0] — 2026-10-10\r\n\r\n- two\r\n\r\n## [0.1.0]\r\n\r\n- one\r\n';

describe('changelog', () => {
  it('the newest N versions, without the heading and intro, line endings normalised', () => {
    expect(latestSections(LOG, 2)).toBe('## [0.3.0] — 2026-10-20\n\n- three\n\n## [0.2.0] — 2026-10-10\n\n- two');
    expect(latestSections(LOG, 9)).toContain('## [0.1.0]');
    expect(latestSections('no versions here', 3)).toBe('');
  });
  it('leaves out the section not released yet (Unreleased / 未发布 on top, renamed when it ships)', () => {
    const next = LOG.replace('## [0.3.0]', '## [Unreleased]\r\n\r\n- next\r\n\r\n## [0.3.0]');
    expect(latestSections(next, 1)).toBe('## [0.3.0] — 2026-10-20\n\n- three');
    expect(latestSections(next.replace('[Unreleased]', '[未发布]'), 2)).toBe('## [0.3.0] — 2026-10-20\n\n- three\n\n## [0.2.0] — 2026-10-10\n\n- two');
    expect(latestSections('# Changelog\n\n## [未发布]\n\n- next\n', 3)).toBe('');
  });
  it('the interface language picks the file, English is the fallback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-log-'));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## [1.0.0]\n\n- english\n');
    expect(readChangelog('zh-CN', 5, root)).toContain('english');
    fs.writeFileSync(path.join(root, 'CHANGELOG.zh-CN.md'), '## [1.0.0]\n\n- 中文\n');
    expect(readChangelog('zh-CN', 5, root)).toContain('中文');
    expect(readChangelog('en', 5, root)).toContain('english');
    expect(readChangelog('en', 5, path.join(root, 'missing'))).toBe('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('the repository has both files with a version section', () => {
    expect(readChangelog('en')).toMatch(/^## \[/);
    expect(readChangelog('zh-CN')).toMatch(/^## \[/);
  });
});
