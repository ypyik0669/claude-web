import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { FIRST_RUN, currentStep, firstRunSteps, onboardingSteps, recentFolders } from './steps';

const S = (id: string, cwd: string, lastModified: number, peer = false): SessionSummary => ({ sessionId: id, title: id, cwd, lastModified, ...(peer ? { peer: { id: 'm', name: 'm' } } : {}) });

describe('first-run wizard: two steps (spec §5.8)', () => {
  it('log in, then pick a project folder — the login step only when there is nothing to work with', () => {
    expect(onboardingSteps({ auth: null, providers: 0 })).toEqual(['login', 'project']);
    expect(onboardingSteps({ auth: { loggedIn: false }, providers: 0 })).toEqual(['login', 'project']);
    expect(onboardingSteps({ auth: { loggedIn: true }, providers: 0 })).toEqual(['project']);
    expect(onboardingSteps({ auth: { loggedIn: false }, providers: 1 })).toEqual(['project']);
  });
  it('the step shown: login until it is done or skipped; logging in elsewhere moves it on by itself', () => {
    expect(currentStep(['login', 'project'], false)).toBe('login');
    expect(currentStep(['login', 'project'], true)).toBe('project');
    expect(currentStep(['project'], false)).toBe('project');
  });
  it('no theme step, no shortcuts page (appearance follows the system; shortcuts are in the 入门清单)', () => {
    expect(onboardingSteps({ auth: null, providers: 0 })).not.toContain('theme' as never);
  });
});

describe('cold start → first message in ≤ 3 steps (spec §7 phase 7)', () => {
  it('the declared path: skip / log in, pick the folder, send', () => {
    expect(FIRST_RUN.map((s) => s.id)).toEqual(['login', 'project', 'send']);
    expect(firstRunSteps({ loggedIn: false }).length).toBeLessThanOrEqual(3);
    expect(firstRunSteps({ loggedIn: true }).map((s) => s.id)).toEqual(['project', 'send']);
  });
});

describe('recent folders to pick from (conversations already on this machine, e.g. from the CLI)', () => {
  it('local, newest first, each folder once, at most four', () => {
    const list = [S('a', 'C:/x', 5), S('b', 'C:/y', 9), S('c', 'C:/x', 7), S('p', '/remote', 10, true), S('d', 'C:/z', 1), S('e', 'C:/w', 2), S('f', 'C:/v', 3)];
    expect(recentFolders(list)).toEqual(['C:/y', 'C:/x', 'C:/v', 'C:/w']);
    expect(recentFolders(list, ['c:/y'])).toEqual(['C:/x', 'C:/v', 'C:/w', 'C:/z']);
  });
});
