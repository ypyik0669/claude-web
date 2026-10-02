import { describe, expect, it } from 'vitest';
import { DEFAULT_BROKERS, DEFAULT_STUN, MAX_LIST_ENTRIES, MAX_PAIR_LINK_BYTES, MAX_PAIR_PC_NAME, b64u, pairLink, pairLinkBytes, type BrokerDef } from '@anywhere';
import { pairLinkProblem } from './anywhere';
import { QR_MAX_PX, QR_MIN_PX, pairQr } from './pair-qr';

const SHELL = 'https://claude-web-shell.github.io/';
const PS = b64u(new Uint8Array(16).fill(255));
/** The phone shell's paste field takes no longer link (web/src/shell/pair-link.ts). */
const SHELL_MAX_LINK_CHARS = 4096;

/**
 * The longest lists the editor lets through: 16 brokers (each ticked 用于转发, the first with a sign-in) and 16 STUN
 * servers, the first broker's address grown one character at a time until one more would be refused.
 */
function longestLists(): { brokers: BrokerDef[]; stun: string[] } {
  const stun = Array.from({ length: MAX_LIST_ENTRIES }, (_, i) => `stun:stun-${i}.example.com:3478`);
  const brokers: BrokerDef[] = Array.from({ length: MAX_LIST_ENTRIES }, (_, i) => ({ name: `b${i}`, url: `wss://b${i}.example.com/mqtt`, relay: true }));
  brokers[0] = { ...brokers[0], username: 'public', password: 'public' };
  let grow = '';
  const at = (g: string) => [{ ...brokers[0], url: `wss://${g}b0.example.com/mqtt` }, ...brokers.slice(1)];
  while (pairLinkBytes(SHELL, at(`${grow}x`), stun) <= MAX_PAIR_LINK_BYTES) grow += 'x';
  return { brokers: at(grow), stun };
}

describe('the pairing QR (F2: the lists go into it)', () => {
  it('a default link is a small code at the smallest size', async () => {
    const q = await pairQr(pairLink(SHELL, { ps: PS, code: '123456', pc: 'DESKTOP-ABC123', brokers: DEFAULT_BROKERS, stun: DEFAULT_STUN }));
    expect(q.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(q.size).toBe(QR_MIN_PX);
  });

  it(`the longest link a full custom list can make (${MAX_LIST_ENTRIES} + ${MAX_LIST_ENTRIES} entries) still encodes`, async () => {
    const { brokers, stun } = longestLists();
    // at the limit, and one character more is refused by the editor
    expect(pairLinkProblem(SHELL, brokers, stun)).toBeNull();
    const over = [{ ...brokers[0], url: brokers[0].url.replace('wss://', 'wss://x') }, ...brokers.slice(1)];
    expect(pairLinkProblem(SHELL, over, stun)).toMatch(/二维码装不下/);
    // the worst link of these lists: the PC's name at its cap, in three-byte characters
    const link = pairLink(SHELL, { ps: PS, code: '999999', pc: '电'.repeat(MAX_PAIR_PC_NAME * 2), brokers, stun });
    const bytes = new TextEncoder().encode(link).length;
    expect(bytes).toBeGreaterThan(MAX_PAIR_LINK_BYTES - 120);
    expect(bytes).toBeLessThanOrEqual(MAX_PAIR_LINK_BYTES);
    expect(link.length).toBeLessThanOrEqual(SHELL_MAX_LINK_CHARS);
    const q = await pairQr(link);
    expect(q.src.startsWith('data:image/png;base64,')).toBe(true);
    // a dense code is shown larger
    expect(q.size).toBeGreaterThan(QR_MIN_PX);
    expect(q.size).toBeLessThanOrEqual(QR_MAX_PX);
  });

  it('a link past what one QR code can hold is refused (the page says so instead of showing nothing)', async () => {
    // lower case: bytes, as base64url is (upper case alone would pack as alphanumerics)
    await expect(pairQr(`${SHELL}#p=${'a'.repeat(3_200)}`)).rejects.toThrow();
  });
});
