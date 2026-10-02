/**
 * A URL for one of the server's own endpoints (api/file, api/attachments …), relative to the page.
 * The app is built with Vite `base: './'` so the same files also work below a folder: the phone shell
 * opens them at app/index.html and serves app/api/… through the tunnel, and a root-absolute
 * /api/… URL would leave that folder. Call sites write the path without the leading slash
 * (app-url.test.ts rejects string literals that start with /api/); a path that arrives with
 * leading slashes is made relative too.
 */
export function appUrl(path: string): string {
  return path.replace(/^\/+/, '');
}
