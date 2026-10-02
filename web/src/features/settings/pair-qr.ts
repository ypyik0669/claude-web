// The pairing QR image (设置 → 手机与其它电脑): dark on white, what every phone camera reads. A link that names the
// PC's own broker / STUN lists is long (up to core's MAX_PAIR_LINK_BYTES, which the list editor holds them to), so the
// error correction drops to L only when M cannot hold the link, and the image is drawn at several pixels a module and
// shown larger when the code is dense, so it still scans off a screen.
import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode';

/** What a version 40 code holds in bytes at error correction M. */
const M_MAX_BYTES = 2_331;
const MARGIN = 1;
/** Image pixels per module (the image is scaled down to its shown size). */
const PX_PER_MODULE = 4;
/** Shown size: CSS pixels per module, and its bounds (the LAN link and a default anywhere one stay at the minimum). */
const SHOWN_PER_MODULE = 2.4;
export const QR_MIN_PX = 180;
export const QR_MAX_PX = 400;

export interface PairQr {
  /** The image, as a data: URL. */
  src: string;
  /** The size to show it at, in CSS pixels (it is square). */
  size: number;
  /** Modules per side, the margin included. */
  modules: number;
}

export function pairQrOptions(link: string): { errorCorrectionLevel: QRCodeErrorCorrectionLevel; margin: number } {
  const bytes = new TextEncoder().encode(link).length;
  return { errorCorrectionLevel: bytes > M_MAX_BYTES ? 'L' : 'M', margin: MARGIN };
}

/** The QR of a pairing link; rejects when no QR code can hold it (a hand-edited list past the editor's limit). */
export async function pairQr(link: string): Promise<PairQr> {
  const opts = pairQrOptions(link);
  const modules = QRCode.create(link, opts).modules.size + 2 * MARGIN;
  const src = await QRCode.toDataURL(link, { ...opts, width: Math.max(240, modules * PX_PER_MODULE), color: { dark: '#1f1e1a', light: '#ffffff' } });
  const size = Math.round(Math.min(QR_MAX_PX, Math.max(QR_MIN_PX, modules * SHOWN_PER_MODULE)));
  return { src, size, modules };
}
