// Everything the PC (AnywhereService) and the phone shell use from core/. Web-standard APIs only.
import type { BrokerDef } from './mqtt.js';

export * from './keys.js';
export * from './envelope.js';
export * from './frames.js';
export * from './mqtt.js';
export * from './signal.js';
export * from './link.js';
export * from './relay-link.js';
export * from './p2p-link.js';
export * from './dial.js';
export * from './accept.js';

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
