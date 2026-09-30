import { describe, expect, it } from 'vitest';
import { SNOOZE_MS, promptCopy, promptFor, type UpdateState } from './model';

const NOW = 1_800_000_000_000;

describe('when the update prompt shows', () => {
  it('the Windows installer: once the new version is downloaded, not while it is found or downloading', () => {
    const base: UpdateState = { status: 'available', mode: 'auto', version: '0.1.3', notes: '修复', page: 'p' };
    expect(promptFor(base, {}, NOW)).toBeNull();
    expect(promptFor({ ...base, status: 'downloading', percent: 40 }, {}, NOW)).toBeNull();
    expect(promptFor({ ...base, status: 'downloaded' }, {}, NOW)).toEqual({ kind: 'ready', version: '0.1.3', required: false, notes: '修复', url: undefined, page: 'p' });
  });

  it('macOS / the portable exe: as soon as a new version is found, with its download link', () => {
    expect(promptFor({ status: 'available', mode: 'manual', version: '0.1.3', url: 'u' }, {}, NOW)).toMatchObject({ kind: 'download', url: 'u' });
    expect(promptFor({ status: 'none', mode: 'manual' }, {}, NOW)).toBeNull();
    expect(promptFor({ status: 'error', mode: 'manual', error: 'offline' }, {}, NOW)).toBeNull();
  });

  it('稍后 puts it off for a day (and the next start asks again: the snooze lives in memory)', () => {
    const s: UpdateState = { status: 'downloaded', mode: 'auto', version: '0.1.3' };
    expect(promptFor(s, { '0.1.3': NOW - 1000 }, NOW)).toBeNull();
    expect(promptFor(s, { '0.1.3': NOW - SNOOZE_MS - 1 }, NOW)).not.toBeNull();
    // putting off 0.1.3 does not hide 0.1.4
    expect(promptFor({ ...s, version: '0.1.4' }, { '0.1.3': NOW - 1000 }, NOW)).not.toBeNull();
  });

  it('a required release cannot be put off; if its download failed, it asks for a manual download', () => {
    const s: UpdateState = { status: 'downloaded', mode: 'auto', version: '0.1.3', required: true };
    expect(promptFor(s, { '0.1.3': NOW - 1000 }, NOW)).toMatchObject({ kind: 'ready', required: true });
    expect(promptFor({ ...s, status: 'error', error: 'net', url: 'installer' }, {}, NOW)).toMatchObject({ kind: 'download', url: 'installer' });
    // not required: a failed download waits for the next automatic try
    expect(promptFor({ ...s, required: false, status: 'error', error: 'net', url: 'installer' }, {}, NOW)).toBeNull();
  });
});

describe('what the prompt says', () => {
  const ready = { kind: 'ready' as const, version: '0.1.3', required: false };
  it('ready: restart now, or it installs when the app quits; running conversations are named', () => {
    const c = promptCopy(ready, { platform: 'win32', mode: 'auto', running: 2 });
    expect(c).toMatchObject({ title: '新版本 v0.1.3 已准备好', primary: '立即重启更新' });
    expect(c.later).toMatch(/退出软件时会自动装好/);
    expect(c.warn).toMatch(/2 个对话正在运行/);
    expect(promptCopy(ready, { platform: 'win32', mode: 'auto', running: 0 }).warn).toBeUndefined();
  });

  it('required: says so in the title and offers no 稍后', () => {
    const c = promptCopy({ ...ready, required: true }, { platform: 'win32', mode: 'auto', running: 0 });
    expect(c.title).toBe('这一版必须更新：v0.1.3');
    expect(c.later).toBeUndefined();
  });

  it('download: macOS drags the app into Applications, the portable exe is replaced, the installer is run', () => {
    const dl = { kind: 'download' as const, version: '0.1.3', required: false, url: 'u' };
    expect(promptCopy(dl, { platform: 'darwin', mode: 'manual', running: 0 }).after).toMatch(/拖进「应用程序」/);
    expect(promptCopy(dl, { platform: 'win32', mode: 'manual', portable: true, running: 0 }).after).toMatch(/替换现在这个/);
    expect(promptCopy(dl, { platform: 'win32', mode: 'auto', running: 0 }).lead).toMatch(/自动下载没有成功/);
  });
});
