import { authToken } from '@/ws/client';
// Attachment helpers for the composer: image compression, long-paste → text attachment, folder traversal, upload.
import type { AttachmentRef } from '@shared';
import { skipDirName } from './attachment-filter';
import { appUrl } from '@/util/app-url';

export const LONG_PASTE_CHARS = 3000;
export const LONG_PASTE_LINES = 60;
export const IMAGE_MAX_EDGE = 1568;
export const IMAGE_KEEP_PNG_BYTES = 300 * 1024;

export interface PendingImage { mediaType: string; data: string; url: string; name?: string }

/** Downscale to the model's max edge and re-encode unless it is already a small PNG. Returns base64 without the prefix. */
export async function compressImage(file: File | Blob, name?: string): Promise<PendingImage> {
  const type = file.type || 'image/png';
  const small = type === 'image/png' && file.size < IMAGE_KEEP_PNG_BYTES;
  const raw = await blobToDataUrl(file);
  if (small || type === 'image/gif') return { mediaType: type, data: raw.split(',')[1], url: raw, name };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1024 * 1024) return { mediaType: type, data: raw.split(',')[1], url: raw, name };
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const hasAlpha = type === 'image/png' || type === 'image/webp';
    const out = c.toDataURL(hasAlpha ? 'image/webp' : 'image/jpeg', 0.85);
    return { mediaType: hasAlpha ? 'image/webp' : 'image/jpeg', data: out.split(',')[1], url: out, name };
  } catch {
    return { mediaType: type, data: raw.split(',')[1], url: raw, name };
  }
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
}

export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split('\n').length > LONG_PASTE_LINES;
}

/** A pasted blob of text becomes an inline text attachment (kept in the message as <attached kind="text">…). */
export function pasteAsAttachment(text: string): AttachmentRef {
  const first = text.trim().split('\n')[0].replace(/[^\w.-]+/g, '_').slice(0, 24) || 'paste';
  return { kind: 'text', name: `${first}.txt`, size: text.length, text };
}

export interface DroppedFile { file: File; rel: string }

/** Expand a DataTransfer (files and folders via webkitGetAsEntry) into files with relative paths. */
export async function expandDataTransfer(dt: DataTransfer, max = 500): Promise<{ files: DroppedFile[]; folders: string[]; truncated: boolean }> {
  const files: DroppedFile[] = [];
  const folders: string[] = [];
  let truncated = false;
  const items = Array.from(dt.items ?? []);
  const entries = items.map((it) => (it as any).webkitGetAsEntry?.() ?? null);
  if (!entries.some(Boolean)) {
    for (const f of Array.from(dt.files)) files.push({ file: f, rel: f.name });
    return { files, folders, truncated };
  }
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (files.length >= max) { truncated = true; return; }
    if (entry.isFile) {
      const f: File = await new Promise((res, rej) => entry.file(res, rej));
      files.push({ file: f, rel: prefix + f.name });
    } else if (entry.isDirectory) {
      if (!prefix) folders.push(entry.name);
      const reader = entry.createReader();
      const batch = async (): Promise<any[]> => new Promise((res, rej) => reader.readEntries(res, rej));
      let list: any[];
      do {
        list = await batch();
        for (const e of list) {
          if (e.isDirectory && skipDirName(e.name)) continue;
          await walk(e, prefix + entry.name + '/');
        }
      } while (list.length && files.length < max);
    }
  };
  for (const e of entries) if (e) await walk(e, '');
  return { files, folders, truncated };
}

export function apiToken(): string | null {
  return authToken();
}

/** Upload one file for a session; returns the absolute path the CLI can Read. */
export async function uploadAttachment(sessionId: string, file: Blob, rel: string, onProgress?: (p: number) => void): Promise<{ path: string; size: number }> {
  const tok = apiToken();
  const url = appUrl(`api/attachments?sessionId=${encodeURIComponent(sessionId)}&rel=${encodeURIComponent(rel)}${tok ? `&token=${encodeURIComponent(tok)}` : ''}`);
  return new Promise((res, rej) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status === 200 ? res(JSON.parse(xhr.responseText)) : rej(new Error(`上传失败 ${xhr.status}: ${xhr.responseText}`)));
    xhr.onerror = () => rej(new Error('上传失败：网络错误'));
    xhr.send(file);
  });
}

export function fmtSize(n: number | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
