/**
 * A short tick under the finger on devices that can (UI refresh §8 触感): sending, approving, a long press opening its
 * menu. `navigator.vibrate` exists on Android browsers; iOS has none, so nothing happens there. Off with the setting
 * `ui.haptics` (default on — `applyUiSettings` mirrors it to `<html data-haptics="off">`) and whenever motion is
 * reduced (the setting or the system's).
 */
export type HapticKind = 'tap' | 'confirm' | 'menu';

/** Milliseconds per kind: all the same short tick (the spec's 10ms); a pattern would feel like a notification. */
export const HAPTIC_MS: Record<HapticKind, number> = { tap: 10, confirm: 10, menu: 10 };

export interface HapticEnv {
  /** `navigator.vibrate` is there */
  canVibrate: boolean;
  /** `ui.haptics` is not switched off */
  enabled: boolean;
  /** 减少动态效果 (the setting) or the system's prefers-reduced-motion */
  reduceMotion: boolean;
}

/** Whether a tick is given at all. */
export function hapticAllowed(env: HapticEnv): boolean {
  return env.canVibrate && env.enabled && !env.reduceMotion;
}

function readEnv(): HapticEnv {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return { canVibrate: false, enabled: false, reduceMotion: false };
  const root = document.documentElement;
  let systemReduce = false;
  try { systemReduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { /* no matchMedia */ }
  return {
    canVibrate: typeof navigator.vibrate === 'function',
    enabled: root.dataset.haptics !== 'off',
    reduceMotion: root.dataset.reduceMotion === '1' || systemReduce,
  };
}

/** Give the tick (a no-op wherever it is not allowed; never throws — a browser may refuse outside a user gesture). */
export function haptic(kind: HapticKind = 'tap'): void {
  if (!hapticAllowed(readEnv())) return;
  try { navigator.vibrate(HAPTIC_MS[kind]); } catch { /* refused */ }
}
