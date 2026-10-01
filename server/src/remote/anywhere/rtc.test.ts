import { describe, expect, it } from 'vitest';
import { loadRtc } from './rtc.js';

describe('loadRtc', () => {
  it('loads the native WebRTC polyfill once and caches it', async () => {
    const rtc = await loadRtc();
    expect('error' in rtc ? rtc.error : '').toBe('');
    if ('error' in rtc) return;
    expect(typeof rtc.RTCPeerConnection).toBe('function');
    expect(await loadRtc()).toBe(rtc);
  });

  it('two loopback peers open a data channel and pass a message', async () => {
    const rtc = await loadRtc();
    if ('error' in rtc) throw new Error(rtc.error);
    // host candidates only: no STUN, no network beyond this machine
    const a = new rtc.RTCPeerConnection({ iceServers: [] });
    const b = new rtc.RTCPeerConnection({ iceServers: [] });
    try {
      a.onicecandidate = (e) => { if (e.candidate) void b.addIceCandidate(e.candidate); };
      b.onicecandidate = (e) => { if (e.candidate) void a.addIceCandidate(e.candidate); };

      const received = new Promise<string>((resolve) => {
        b.ondatachannel = (e) => { e.channel.onmessage = (m) => resolve(String(m.data)); };
      });
      const ch = a.createDataChannel('t');
      const opened = new Promise<void>((resolve) => { ch.onopen = () => resolve(); });

      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(a.localDescription!);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(b.localDescription!);

      const timeout = <T>(p: Promise<T>, what: string) => {
        let t: NodeJS.Timeout | undefined;
        return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), 10_000); })])
          .finally(() => clearTimeout(t));
      };
      await timeout(opened, 'data channel open');
      ch.send('ping');
      expect(await timeout(received, 'message')).toBe('ping');
    } finally {
      a.close();
      b.close();
    }
  }, 15_000);
});
