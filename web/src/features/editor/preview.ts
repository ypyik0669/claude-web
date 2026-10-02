import { authToken } from '@/ws/client';
import { appUrl } from '@/util/app-url';
export type PreviewKind = 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'binary';

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const PDF = /\.pdf$/i;
const VIDEO = /\.(mp4|webm|mov|mkv)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a|flac)$/i;
const BIN = /\.(zip|7z|rar|gz|tar|exe|dll|so|dylib|bin|class|jar|pyc|wasm|ttf|otf|woff2?|eot|docx?|xlsx?|pptx?|sqlite|db)$/i;

export function previewKind(p: string): PreviewKind {
  if (IMG.test(p)) return 'image';
  if (PDF.test(p)) return 'pdf';
  if (VIDEO.test(p)) return 'video';
  if (AUDIO.test(p)) return 'audio';
  if (BIN.test(p)) return 'binary';
  return 'text';
}

/** URL of the server's raw-file endpoint (token forwarded from the page URL). */
export function fileUrl(p: string): string {
  const token = authToken();
  const q = new URLSearchParams({ path: p });
  if (token) q.set('token', token);
  return appUrl(`api/file?${q}`);
}
