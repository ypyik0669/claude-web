// Keyboard hints — Ctrl / ⌘ / Alt / Shift / Tab / Enter / Esc / F-keys, 「/」, 键盘快捷键 — are for a keyboard: a phone
// shows none of them (redesign 2026-11, the phone rules; the plan's phone problem 8). One mechanism for the whole app:
//
//  - markup: a hint goes in `<kbd>`, in `.kbd`, or on anything with `data-kbd` — `html.phone` hides all of them
//    (styles/phone.css). App puts the class on <html> while the layout is the phone's, so what is portalled to <body>
//    (action sheets, menus, cards) follows too. Use this for a hint drawn beside a label (a menu row's 「Ctrl I」).
//  - words: `noKbd(text, phone)` drops the parts of a sentence that only speak of keys — 「（Ctrl+K）」, 「 · Esc 中断」,
//    「，按 Tab 采用」 — for a line shown on both. A phone placeholder that needs other words altogether (「回复…」
//    instead of 「Enter 排到这一轮之后…」) is chosen by the caller.
//
// Pure: no store here (node tests import it). A component asks `useStore((s) => s.mobile)` for `phone`.

/** a word that names a key (Tab and Enter as words, not inside a longer one) */
const KEY = /(?:\b(?:Ctrl|Cmd|Alt|Option|Shift|Tab|Enter|Esc|Escape|PgUp|PgDn|F\d{1,2})\b|⌘|⌥|⇧|↵|⏎|↑↓)/;
/** a bracketed hint: 「（Ctrl+K）」 「(Alt+J)」 「（输入框空着时按 Ctrl+Enter 也是）」 */
const BRACKETED = new RegExp(`\\s*[（(][^（）()]*?${KEY.source}[^（）()]*[）)]`, 'g');
/** one part of a key combination */
const TOKEN = /^(?:Ctrl|Cmd|Alt|Option|Shift|Tab|Enter|Esc|Escape|PageUp|PageDown|PgUp|PgDn|Backspace|Space|Home|End|Delete|Left|Right|Up|Down|F\d{1,2}|⌘|⌥|⇧|↵|[↑↓←→]|\d\.\.\d|.)$/i;

/** Does this text speak of a key? */
export function hasKbd(text: string): boolean {
  return KEY.test(text);
}

/** A string made of a key combination and nothing else — 「Ctrl+K」 「⌘ ,」 「Ctrl+1..9」 「F2」 — what a key column shows. */
export function isKeyCombo(text: string | undefined | null): boolean {
  const t = text?.trim();
  if (!t || t.length > 40) return false;
  const tokens = t.split(/\s*(?:\+|\s|\/)\s*/).filter(Boolean);
  return tokens.length > 0 && tokens.every((x) => TOKEN.test(x)) && (KEY.test(t) || /^F\d{1,2}$/i.test(t));
}

/**
 * The sentence without what only speaks of keys — on a phone; anywhere else it comes back as it is. Bracketed hints go,
 * then the parts of a 「 · 」 list and the clauses (「，」 「；」 「, 」) that name a key. Nothing left → ''.
 */
export function noKbd(text: string, phone = true): string {
  if (!phone || !text) return text;
  let s = text.replace(BRACKETED, '');
  if (s.includes(' · ')) s = s.split(' · ').filter((p) => !KEY.test(p)).join(' · ');
  if (KEY.test(s)) s = s.split(/(?<=[，；;])|(?<=,)\s+/).filter((p) => !KEY.test(p)).join('');
  if (KEY.test(s)) s = '';
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s·，,；;]+|[\s·，,；;]+$/g, '').trim();
}
