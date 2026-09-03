import { describe, expect, it } from 'vitest';
import { VcsService } from './service.js';

const fakeGit = (url: string) => ({ remotes: async () => [{ name: 'origin', url }] }) as any;

describe('VcsService.target', () => {
  it('parses github https / ssh / git@ remotes', async () => {
    expect(await new VcsService(fakeGit('https://github.com/ypyik0669/claude-web.git')).target('x')).toEqual({ provider: 'github', host: 'github.com', owner: 'ypyik0669', repo: 'claude-web' });
    expect(await new VcsService(fakeGit('git@github.com:owner/repo.git')).target('x')).toEqual({ provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' });
    expect(await new VcsService(fakeGit('ssh://git@github.com:22/owner/repo')).target('x')).toEqual({ provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' });
    expect(await new VcsService(fakeGit('https://user@ghe.corp.com/team/tool')).target('x')).toEqual({ provider: 'github', host: 'ghe.corp.com', owner: 'team', repo: 'tool' });
  });
  it('parses gitlab remotes incl. nested groups', async () => {
    expect(await new VcsService(fakeGit('git@gitlab.com:group/sub/project.git')).target('x')).toEqual({ provider: 'gitlab', host: 'gitlab.com', owner: 'group/sub', repo: 'project' });
    expect(await new VcsService(fakeGit('https://gitlab.example.com/a/b/c/d.git')).target('x')).toEqual({ provider: 'gitlab', host: 'gitlab.example.com', owner: 'a/b/c', repo: 'd' });
  });
  it('accepts explicit owner/repo[@host] and urls', async () => {
    const s = new VcsService(fakeGit(''));
    expect(await s.target('x', 'anthropics/claude-code')).toEqual({ provider: 'github', host: 'github.com', owner: 'anthropics', repo: 'claude-code' });
    expect(await s.target('x', 'https://gitlab.com/gitlab-org/gitlab')).toEqual({ provider: 'gitlab', host: 'gitlab.com', owner: 'gitlab-org', repo: 'gitlab' });
    expect(await s.target('x', 'team/tool@ghe.corp.com')).toEqual({ provider: 'github', host: 'ghe.corp.com', owner: 'team', repo: 'tool' });
    await expect(s.target('x', 'nonsense')).rejects.toThrow();
  });
  it('errors without a remote', async () => {
    await expect(new VcsService({ remotes: async () => [] } as any).target('x')).rejects.toThrow('没有 git remote');
  });
});
