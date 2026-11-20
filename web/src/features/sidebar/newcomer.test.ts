import { describe, expect, it } from 'vitest';
import { hintReady, hintText, makeProjectSpelled, projectsEmpty } from './newcomer';

describe('the sidebar for someone new (final review §9 #5)', () => {
  it('no project but folders in 其它文件夹: the empty state points at 「设为项目」, without a second 打开文件夹 button', () => {
    expect(projectsEmpty({ projects: 0, otherFolders: 2 })).toEqual({ text: expect.stringContaining('把常用的文件夹设为项目'), openButton: false });
    expect(projectsEmpty({ projects: 0, otherFolders: 0 })).toEqual({ text: expect.stringContaining('打开一个文件夹'), openButton: true });
    expect(projectsEmpty({ projects: 1, otherFolders: 3 })).toBeNull();
  });
  it('设为项目 is written out only while there is no project', () => {
    expect(makeProjectSpelled(0)).toBe(true);
    expect(makeProjectSpelled(1)).toBe(false);
  });
  it('the discovery hint waits out the first screen only: once this computer has a conversation (redesign 2026-11)', () => {
    const local = { sessionId: 's1', title: 'x', cwd: '/p', lastModified: 1 } as any;
    const peer = { ...local, sessionId: 'peer_a~s2', peer: { id: 'a', name: 'A' } } as any;
    expect(hintReady({ listed: false, sessions: [local] })).toBe(false); // the list not in yet: no flash
    expect(hintReady({ listed: true, sessions: [] })).toBe(false); // the first screen (入门清单)
    expect(hintReady({ listed: true, sessions: [peer] })).toBe(false); // another computer's conversations do not count
    expect(hintReady({ listed: true, sessions: [peer, local] })).toBe(true);
  });
  it('asks in plain words, every name in the tooltip', () => {
    expect(hintText(['Codex']).text).toBe('把 Codex 里的对话也列在这里？');
    const many = hintText(['Codex', 'OpenCode', 'Qwen Code']);
    expect(many.text).toBe('把 Codex 等工具里的对话也列在这里？');
    expect(many.title).toContain('Codex、OpenCode、Qwen Code');
  });
});
