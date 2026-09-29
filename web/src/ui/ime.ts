/**
 * Is this keydown part of an IME composition (pinyin, kana…), so Enter / Escape belong to the input method?
 *
 * `isComposing` alone misses Safari: WebKit fires `compositionend` *before* the keydown of the Enter that commits
 * the text, so that keydown reports `isComposing: false` — only its `keyCode` 229 ("an IME is processing this
 * key") gives it away. Without this, in Safari on macOS the Enter that turns typed pinyin into text also sent the
 * message. Chrome and Firefox set `isComposing` (and 229) on that keydown, so the check is the same there.
 * Every Enter / Escape handler that has to leave an IME alone goes through here (`ime.test.ts` enforces it).
 */
export function imeComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}
