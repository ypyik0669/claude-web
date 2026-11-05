// A picture in an answer given as a path on this computer — `![x](C:\Users\…\a.gif)`, `C:/…`, `file:///…`, `/Users/…`
// — cannot be loaded by the page as is: react-markdown blanked it (`C:` read as an unsafe scheme) and the browser has
// no access to the disk anyway, so it showed as a broken image (2026-11-05 user report). Such a source goes through the
// server's token-guarded raw-file endpoint (editor/preview.ts fileUrl, what the file preview uses); web URLs, data:
// and blob: stay.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const APP_OWN = /^\/(?:api|assets)\//;

/** The absolute path on this computer a markdown image source names, or null when it is not one. */
export function localImagePath(src: string): string | null {
  let s = src.trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch { return null; }
    // file:///C:/x → /C:/x
    if (/^\/[a-zA-Z]:\//.test(s)) s = s.slice(1);
  } else {
    try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { /* keep it as written */ }
  }
  // Windows: C:\… or C:/…
  if (/^[a-zA-Z]:[\\/]/.test(s)) return IMAGE_EXT.test(s) ? s : null;
  // POSIX absolute (macOS / Linux / Git Bash) — not //host, nor the page's own endpoints / bundled assets
  if (s.startsWith('/') && !s.startsWith('//') && !APP_OWN.test(s)) return IMAGE_EXT.test(s) ? s : null;
  return null;
}
