/**
 * What the built-in browser tells web sites it is. Electron's own user agent names the app and Electron between the
 * engine and Chrome (`… (KHTML, like Gecko) claude-web/0.2.0 Chrome/152.0.0.0 Electron/44.0.0 Safari/537.36`): search
 * engines and sign-in pages treat that as "not a browser" — a challenge, a refusal, or a stripped-down page. Without
 * the two tokens it is the Chrome it is built from.
 */
export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/(\(KHTML, like Gecko\))\s+.*?(?=Chrome\/)/, '$1 ')
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
