// Everything the PC (AnywhereService) and the phone shell use from core/. Web-standard APIs only. Internal pieces
// stay out: the handshake helpers (handshake.ts) and the direct link's class and helpers (made only by dial() and
// Acceptor), so that what is listed here is what callers may rely on.
import type { BrokerDef } from './mqtt.js';

export * from './keys.js';
export * from './envelope.js';
export * from './frames.js';
export * from './mqtt.js';
export * from './signal.js';
export * from './link.js';
export * from './relay-link.js';
export {
  P2P_CHANNEL,
  P2P_DISCONNECT_GRACE_MS,
  P2P_FLAG,
  P2P_PIECE_BYTES,
  PAIR_KIND_TIMEOUT_MS,
  type RtcCandidate,
  type RtcConfig,
  type RtcCtor,
  type RtcDataChannelLike,
  type RtcDescription,
  type RtcPeerConnectionLike,
  type RtcSdpType,
  type RtcStatsLike,
} from './p2p-link.js';
export * from './dial.js';
export * from './accept.js';
export * from './mux.js';

/**
 * Signaling brokers, in order of preference (the settings' "more options" can replace the list). Only the ones marked
 * `relay` carry the slow relay: the emqx pair rate-limits bursts (in the field test about half of a 30-message burst
 * came back), which signaling survives and the relay would not.
 */
export const DEFAULT_BROKERS: BrokerDef[] = [
  { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
  { name: 'emqx-cn', url: 'wss://broker-cn.emqx.io:8084/mqtt' },
  { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt', relay: true },
  { name: 'shiftr', url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public', relay: true },
  { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt', relay: true },
];

/** STUN servers for ICE; the first four answer from mainland China, Google's does not. */
export const DEFAULT_STUN: string[] = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.hitv.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.l.google.com:19302',
];
