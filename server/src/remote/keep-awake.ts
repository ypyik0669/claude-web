// 不让电脑睡眠: the desktop shell holds a powerSaveBlocker while remote access is on (desktop/src/keep-awake.ts). The
// server owns the settings, so it tells the shell: once at startup, then whenever the answer changes.

/** Same rule as desktop/src/keep-awake.ts (the server can't import from desktop/): remote access on, `remote.keepAwake` not false. */
export function keepAwakeWanted(s: { remoteEnabled: boolean; keepAwake: boolean | undefined }): boolean {
  return s.remoteEnabled && s.keepAwake !== false;
}

interface SettingsSource {
  settings(): Record<string, unknown>;
  on(ev: 'changed', fn: () => void): unknown;
  off(ev: 'changed', fn: () => void): unknown;
}

/**
 * Calls `post` with the current answer now, then after every meta save that flips it (MetaStore emits 'changed'
 * after each non-quiet save — `remote.set`, `settings.set` of `remote.enabled` / `remote.keepAwake`, any other path).
 * "Remote access on" is the `remote.enabled` setting (RemoteService.enabled()), not whether the listener came up.
 * Returns a function that stops listening.
 */
export function reportKeepAwake(meta: SettingsSource, post: (on: boolean) => void): () => void {
  let last: boolean | undefined;
  const check = () => {
    const s = meta.settings();
    const on = keepAwakeWanted({ remoteEnabled: !!s['remote.enabled'], keepAwake: s['remote.keepAwake'] as boolean | undefined });
    if (on === last) return;
    // runs inside MetaStore's emit('changed'): a throw here would fail the save that triggered it
    try {
      post(on);
      last = on;
    } catch (e) {
      console.warn(`[keep-awake] cannot tell the desktop shell: ${(e as Error)?.message ?? e}`);
    }
  };
  check();
  meta.on('changed', check);
  return () => { meta.off('changed', check); };
}
