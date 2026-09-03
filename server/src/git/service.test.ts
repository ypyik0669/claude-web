import { describe, expect, it } from 'vitest';
import { classifyGitError } from './service.js';

describe('classifyGitError', () => {
  const cases: [string, string][] = [
    ['fatal: not a git repository (or any of the parent directories): .git', 'not_repo'],
    ['fatal: The current branch feature has no upstream branch.\nTo push the current branch and set the remote as upstream, use', 'no_upstream'],
    ['remote: Invalid username or password.\nfatal: Authentication failed for https://github.com/x/y.git', 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ['! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 'rejected'],
    ['CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.', 'conflict'],
    ['error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.', 'dirty'],
    ['nothing to commit, working tree clean', 'nothing_to_commit'],
    ['Author identity unknown\n*** Please tell me who you are.', 'identity'],
    ["fatal: Unable to create 'C:/x/.git/index.lock': File exists.", 'lock'],
    ['fatal: refusing to merge unrelated histories', 'unrelated'],
    ["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", 'network'],
    ["fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.", 'unknown_rev'],
    ["fatal: a branch named 'feature' already exists", 'exists'],
    ['something completely different', 'unknown'],
  ];
  for (const [stderr, kind] of cases) it(`${kind}`, () => expect(classifyGitError(stderr).kind).toBe(kind));
  it('keeps the tail of the message and adds a hint', () => {
    const e = classifyGitError('line1\nline2\nfatal: The current branch x has no upstream branch.');
    expect(e.message).toContain('no upstream');
    expect(e.hint).toContain('push -u');
  });
});
