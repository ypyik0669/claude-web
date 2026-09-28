import type { ServerEvent } from '@shared';

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** `p` is one of `bases` or inside one of them (slash style, case and trailing slashes ignored). */
export function pathUnder(p: string, bases: (string | null | undefined)[]): boolean {
  const q = norm(p);
  return bases.some((b) => {
    if (!b) return false;
    const base = norm(b);
    return q === base || q.startsWith(`${base}/`);
  });
}

/**
 * Does this event change the git status of the repo a view shows? Both forms of its location count: the cwd
 * the session was opened with (fs.changed paths use it) and the root git resolved (git.changed uses it) —
 * they differ for a workspace reached through a junction / symlink / subst drive.
 */
export function gitEventConcerns(e: ServerEvent, scope: { cwd: string; root: string | null }): boolean {
  const bases = [scope.root, scope.cwd];
  if (e.kind === 'git.changed') return pathUnder(e.cwd, bases) || pathUnder(scope.cwd, [e.cwd]);
  if (e.kind === 'fs.changed') return pathUnder(e.path, bases);
  return false;
}

/**
 * Run `fn` once after `wait` ms without another trigger — but no later than `maxWait` ms after the first
 * trigger of a burst, so a steady stream of events (a build, an agent writing files) still refreshes.
 */
export function coalesce(fn: () => void, wait: number, maxWait: number): { trigger(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  const fire = () => { timer = undefined; first = 0; fn(); };
  return {
    trigger() {
      const now = Date.now();
      if (!first) first = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(wait, first + maxWait - now)));
    },
    cancel() { if (timer) clearTimeout(timer); timer = undefined; first = 0; },
  };
}
