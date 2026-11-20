// 扫码配对 (2026-11-20, the user: 做成类似 app 的话，为什么不直接把扫码加在里面): the shell's own QR scanner, so a PC
// is paired from inside the app — the system camera opens a QR in Safari, never in the home-screen app. The camera
// comes through getUserMedia (https; a home-screen app on iOS too); the code is read by the browser's BarcodeDetector
// where it has one that reads QR codes (Android's Chrome) and by jsQR where it has not (iOS), loaded the first time.

export type ScanFailure = 'denied' | 'nocamera' | 'other';

export interface ScanSession {
  stop(): void;
}

interface Detector {
  detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type DetectorCtor = { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

/** This browser can give the shell a camera at all (what decides whether 扫码配对 is offered). */
export function canScan(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/** What a getUserMedia refusal means for the person holding the phone. */
export function scanFailure(e: unknown): ScanFailure {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return 'nocamera';
  return 'other';
}

/** The size a frame is read at: its long side at most `max` px (a QR on a screen reads well at 720). */
export function readSize(w: number, h: number, max = 720): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(1, w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

async function nativeDetector(): Promise<Detector | null> {
  const BD = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (!BD) return null;
  try {
    const formats = (await BD.getSupportedFormats?.()) ?? [];
    return formats.includes('qr_code') ? new BD({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

/**
 * Opens the back camera into `video` and reads its frames (about 8 a second) until `found` returns true — it took the
 * text — or stop(). A camera that does not open goes to `failed` (with the browser's own words, for the 原文 line).
 */
export async function scanQr(video: HTMLVideoElement, found: (text: string) => boolean, failed: (why: ScanFailure, raw: string) => void): Promise<ScanSession> {
  let stream: MediaStream | null = null;
  let stopped = false;
  let timer = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const t of stream?.getTracks() ?? []) t.stop();
    video.srcObject = null;
  };
  if (!canScan()) {
    failed('nocamera', 'navigator.mediaDevices.getUserMedia is missing');
    return { stop };
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    failed(scanFailure(e), `${(e as { name?: string })?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`);
    return { stop };
  }
  // closed while the permission was being asked for
  if (stopped) {
    stop();
    return { stop };
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  const native = await nativeDetector();
  const jsqr = native ? null : (await import('jsqr')).default;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (stopped) return;
    let text: string | null = null;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        if (native) text = (await native.detect(video))[0]?.rawValue ?? null;
        else if (jsqr && ctx) {
          const { w, h } = readSize(video.videoWidth, video.videoHeight);
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          // both ways round: the settings page's code is dark on light, a phone's photo of it may not be
          text = jsqr(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;
        }
      }
    } catch {
      // a frame that did not read: the next one
    }
    if (stopped) return;
    if (text && found(text)) return stop();
    timer = window.setTimeout(() => void tick(), 120);
  };
  void tick();
  return { stop };
}
