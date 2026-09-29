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
  it('the discovery hint waits for the checklist to be finished or closed', () => {
    expect(hintReady(undefined)).toBe(false);
    expect(hintReady({ done: ['project', 'send'] })).toBe(false);
    expect(hintReady({ done: [], dismissed: true })).toBe(true);
    expect(hintReady({ done: ['project', 'send', 'review', 'palette'] })).toBe(true);
  });
  it('asks in plain words, every name in the tooltip', () => {
    expect(hintText(['Codex']).text).toBe('把 Codex 里的对话也列在这里？');
    const many = hintText(['Codex', 'OpenCode', 'Qwen Code']);
    expect(many.text).toBe('把 Codex 等工具里的对话也列在这里？');
    expect(many.title).toContain('Codex、OpenCode、Qwen Code');
  });
});
