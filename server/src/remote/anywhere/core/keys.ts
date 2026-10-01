// Rooms: the MQTT topic and AES-GCM key a phone and the PC both derive from a shared secret.
// Shared by the Node server and the phone shell, so Web-standard APIs only (no node:*, no Buffer).

const enc = new TextEncoder();

const DEVICE_SALT = 'cw-anywhere-v1';
const PAIR_SALT = 'cw-pair-v1';
const PAIR_SECRET_BYTES = 16;
const RELAY_NONCE_BYTES = 16;

export interface Room {
  /** `cw1/<32 hex>`; also the AAD of every envelope sealed in this room. */
  topic: string;
  /** AES-256-GCM key for signaling envelopes. */
  key: CryptoKey;
  /** K the room was derived from; relay keys are derived from it again with both sides' nonces. */
  ikm: Uint8Array;
}

/** Copy into a fresh ArrayBuffer-backed array: WebCrypto's BufferSource rejects SharedArrayBuffer views. */
function own(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b);
}

export function b64u(bytes: Uint8Array): string {
  let s = '';
  // chunked: spreading a large array into fromCharCode overflows the argument stack
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('invalid base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey('raw', own(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: enc.encode(info) }, base, bytes * 8);
  return new Uint8Array(bits);
}

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function room(ikm: Uint8Array, salt: string): Promise<Room> {
  const s = enc.encode(salt);
  const topic = `cw1/${hex(await hkdf(ikm, s, 'topic', 16))}`;
  const key = await aesKey(await hkdf(ikm, s, 'signal', 32));
  return { topic, key, ikm: own(ikm) };
}

/** Phone side: K = sha256(UTF-8 device token). */
export async function deviceRoom(token: string): Promise<Room> {
  const k = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(token)));
  return room(k, DEVICE_SALT);
}

/** PC side: meta.json only keeps the hex sha256 of each device token (`tokenHash`), which is K. */
export async function deviceRoomFromHash(hashHex: string): Promise<Room> {
  if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) throw new Error('device token hash must be 64 hex chars');
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  return room(k, DEVICE_SALT);
}

/** Pairing: K = P, the one-time 16 random bytes in the QR code. */
export async function pairRoom(p: Uint8Array): Promise<Room> {
  if (p.length !== PAIR_SECRET_BYTES) throw new Error(`pairing secret must be ${PAIR_SECRET_BYTES} bytes`);
  return room(p, PAIR_SALT);
}

/** Slow-relay key for one session: fresh per hello/ack, so an old session's frames never decrypt in a new one. */
export async function relayKey(r: Room, phoneNonce: Uint8Array, pcNonce: Uint8Array): Promise<CryptoKey> {
  if (phoneNonce.length !== RELAY_NONCE_BYTES || pcNonce.length !== RELAY_NONCE_BYTES) {
    throw new Error(`relay nonces must be ${RELAY_NONCE_BYTES} bytes each`);
  }
  const salt = new Uint8Array(RELAY_NONCE_BYTES * 2);
  salt.set(phoneNonce);
  salt.set(pcNonce, RELAY_NONCE_BYTES);
  return aesKey(await hkdf(r.ikm, salt, 'relay', 32));
}
