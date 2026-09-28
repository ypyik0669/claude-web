/**
 * The welcome page's login check (`config.auth`). The server shares one `claude auth status` run for 30 s;
 * mounting uses that. A fresh run (`force`) is for when the answer may have changed under us: the user
 * clicked 重新检查, or came back to the window while the page says "not logged in" and there is nothing else
 * to work with (`recheckOnFocus`, e.g. no provider profile) — typically after `/login` in a terminal. The
 * focus case at most once per `focusGapMs`: every forced check is an engine start.
 */
export function authChecker<R>(o: {
  request: (force: boolean) => Promise<R>;
  onResult: (r: R | { loggedIn: false; error: true }) => void;
  /** given the last answer (null before the first one): is a forced check on focus worth it? */
  recheckOnFocus: (last: R | { loggedIn: false; error: true } | null) => boolean;
  focusGapMs: number;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  let last = -Infinity;
  let result: R | { loggedIn: false; error: true } | null = null;
  const check = async (force = false) => {
    last = now();
    try { result = await o.request(force); } catch { result = { loggedIn: false, error: true }; }
    o.onResult(result);
  };
  return {
    check,
    onFocus: () => (result !== null && now() - last >= o.focusGapMs && o.recheckOnFocus(result) ? check(true) : Promise.resolve()),
  };
}
