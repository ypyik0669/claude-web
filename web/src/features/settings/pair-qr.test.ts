import { describe, expect, it } from 'vitest';
import { QR_MAX_PX, QR_MIN_PX, pairQr } from './pair-qr';

describe('the pairing QR', () => {
  it('a LAN pairing link is a small code at the smallest size', async () => {
    const q = await pairQr('http://192.168.1.20:3091/pair#123456');
    expect(q.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(q.size).toBe(QR_MIN_PX);
  });

  it('a dense code is shown larger, within the bounds', async () => {
    const q = await pairQr(`https://example.com/#${'a'.repeat(2_000)}`);
    expect(q.size).toBeGreaterThan(QR_MIN_PX);
    expect(q.size).toBeLessThanOrEqual(QR_MAX_PX);
  });

  it('a link past what one QR code can hold is refused (the page says so instead of showing nothing)', async () => {
    // lower case: bytes, as base64url is (upper case alone would pack as alphanumerics)
    await expect(pairQr(`https://example.com/#p=${'a'.repeat(3_200)}`)).rejects.toThrow();
  });
});
