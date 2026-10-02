import type { LinkKind } from '@shared';

/**
 * One WebSocket stream over the phone shell's tunnel to the computer: the part of a WebSocket the app uses.
 * `readyState` takes the WebSocket values (0 connecting, 1 open, 3 closed); `onopen` fires once the computer's
 * /ws has accepted the stream, `onclose` once when it ends (or never opened: computer unreachable, token refused).
 */
export interface TunnelSocket {
  readyState: number;
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}

/**
 * What the phone shell puts on its own window as `window.__cwTunnel`, before it loads the app in its
 * same-origin iframe (app/index.html). One tunnel link serves the whole session: each `connect()` opens one
 * WebSocket stream over it. The shell holds the device token, so `connect()` takes none.
 */
export interface CwTunnel {
  connect(): TunnelSocket;
  /** how the link to the computer runs right now, for the UI to show; null while there is none */
  kind(): LinkKind | null;
}

/**
 * The shell's tunnel when this page runs inside it: a frame (`window.parent !== window`) whose parent is on the
 * same origin and has `__cwTunnel`. Anything else — a top-level page, a cross-origin parent (reading its
 * location or properties throws), no window at all (node tests) — is null.
 */
export function tunnelHost(): CwTunnel | null {
  try {
    if (typeof window === 'undefined') return null;
    const parent = window.parent as (Window & { __cwTunnel?: CwTunnel }) | null | undefined;
    if (!parent || parent === window) return null;
    if (parent.location.origin !== window.location.origin) return null;
    const tunnel = parent.__cwTunnel;
    return tunnel && typeof tunnel.connect === 'function' ? tunnel : null;
  } catch {
    return null;
  }
}
