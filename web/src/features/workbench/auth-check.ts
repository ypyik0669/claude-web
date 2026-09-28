/**
 * The welcome page's login check (`config.auth`). The server shares one `claude auth status` run for 30 s;
 * mounting uses that. A fresh run (`force`) is for when the answer may have changed under us: the user
 * clicked 重新检查, or came back to the window (typically after `/login` in a terminal) — the latter at
 * most once per `focusGapMs`, since every forced check is an engine start.
 */
export function authChecker<R>(o: { request: (force: boolean) => Promise<R>; onResult: (r: R | { loggedIn: false; error: true }) => void; focusGapMs: number; now?: () => number }) {
  const now = o.now ?? Date.now;
  let last = -Infinity;
  const check = async (force = false) => {
    last = now();
    try { o.onResult(await o.request(force)); } catch { o.onResult({ loggedIn: false, error: true }); }
  };
  return {
    check,
    onFocus: () => (now() - last >= o.focusGapMs ? check(true) : Promise.resolve()),
  };
}
