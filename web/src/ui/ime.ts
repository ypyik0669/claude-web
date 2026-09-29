/**
 * Is this keydown part of an IME composition (pinyin, kana…), so Enter / Escape belong to the input method?
 *
 * On macOS the Enter that commits pinyin (or the Escape that drops it) reaches the page as `key: 'Enter'` /
 * `'Escape'` — Windows reports `'Process'`, which is why a Windows-only check never saw this — so every text
 * field that acts on those keys must ask first. `isComposing` alone misses Safari: WebKit fires `compositionend`
 * *before* that keydown, which then reports `isComposing: false`; only its `keyCode` 229 ("an IME is processing
 * this key") gives it away. Chrome and Firefox set both. Every IME check goes through here (`ime.test.ts`
 * enforces it, and that inline Enter / Escape handlers of <input> / <textarea> use it).
 */
export function imeComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}
