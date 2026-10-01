// node-datachannel is a native addon (libdatachannel): loaded on first use so a missing / broken prebuilt binary
// for this platform only turns off the direct link instead of taking the whole server down at startup.
// The server tsconfig has no DOM lib, so the constructor type is the polyfill's own (it implements the W3C interface).
export type RtcPeerConnectionCtor = typeof import('node-datachannel/polyfill').RTCPeerConnection;
export type RtcModule = { RTCPeerConnection: RtcPeerConnectionCtor };

let loading: Promise<RtcModule | { error: string }> | null = null;

/** The W3C-style RTCPeerConnection from node-datachannel, or why it could not be loaded. Never throws; cached. */
export function loadRtc(): Promise<RtcModule | { error: string }> {
  loading ??= import('node-datachannel/polyfill').then(
    (m): RtcModule | { error: string } =>
      typeof m.RTCPeerConnection === 'function' ? { RTCPeerConnection: m.RTCPeerConnection } : { error: 'node-datachannel/polyfill has no RTCPeerConnection' },
    (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
  );
  return loading;
}
