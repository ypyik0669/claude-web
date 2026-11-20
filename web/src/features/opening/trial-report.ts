// A trial run's report (trial.ts), made ready for the server: pure, no app state — the opening page's pictures go in
// one strip, its errors become text, its frame times go flat.
import type { OpeningTrialResult } from '@shared';

/** What the opening page reports (desktop/src/opening.ts `trialEnd`). */
export interface TrialReport { end?: 'done' | 'cut' | 'skip'; at?: number; errors?: unknown[]; stats?: { avgMs: number; maxMs: number; frames: number } | null; snaps?: { at: number; png: string }[] }

/** The pictures, left to right in time, each with its second under it; base64 PNG, or undefined when there are none. */
export async function strip(snaps: { at: number; png: string }[]): Promise<string | undefined> {
  if (!snaps.length || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return undefined;
  const list = [...snaps].sort((a, b) => a.at - b.at).slice(0, 5);
  const bitmaps = (await Promise.all(list.map(async (s) => {
    try { return await createImageBitmap(await (await fetch(s.png)).blob()); } catch { return null; }
  })));
  const TW = 320, LABEL = 22;
  const items = list.map((s, i) => ({ s, b: bitmaps[i] })).filter((x): x is { s: { at: number; png: string }; b: ImageBitmap } => !!x.b);
  if (!items.length) return undefined;
  const TH = Math.round(TW * Math.min(1.2, Math.max(0.4, items[0].b.height / Math.max(1, items[0].b.width))));
  const c = new OffscreenCanvas(TW * items.length + 8 * (items.length + 1), TH + LABEL + 16);
  const g = c.getContext('2d')!;
  g.fillStyle = '#16140f';
  g.fillRect(0, 0, c.width, c.height);
  g.font = '12px ui-monospace, Consolas, monospace';
  g.textBaseline = 'top';
  items.forEach(({ s, b }, i) => {
    const x = 8 + i * (TW + 8);
    g.drawImage(b, x, 8, TW, TH);
    g.fillStyle = '#b8b0a4';
    g.fillText(`${s.at.toFixed(1)} s`, x, 12 + TH);
    b.close();
  });
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let out = '';
  for (let i = 0; i < buf.length; i += 0x8000) out += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(out);
}

/** The page's report → what goes back to the server. */
export async function trialResult(r: TrialReport): Promise<OpeningTrialResult> {
  let png: string | undefined;
  let note: string | undefined;
  try { png = await strip(Array.isArray(r.snaps) ? r.snaps.filter((s) => s && typeof s.png === 'string') : []); } catch (e) { note = `picture: ${(e as Error).message}`; }
  return {
    ...(r.end ? { end: r.end } : {}),
    ...(typeof r.at === 'number' ? { at: r.at } : {}),
    errors: Array.isArray(r.errors) ? r.errors.map((e) => String(e)) : [],
    ...(r.stats ? { avgMs: r.stats.avgMs, maxMs: r.stats.maxMs, frames: r.stats.frames } : {}),
    ...(png ? { png } : {}),
    ...(note ? { note } : {}),
  };
}
