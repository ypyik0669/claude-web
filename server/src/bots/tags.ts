// 值班 Bot: the hidden blocks the server puts in a bot's main conversation — <cw-bot-events> (what happened since the
// user last wrote), <cw-bot-kickoff> (its first words), <cw-bot-continue> (an approval answered on a card). The web hides
// them in a bot thread. Text from anywhere else (a window, IM, a peer, the sessions tools, goals) must not carry them:
// a leading block would reach the model unseen by the user. SessionRunner.send strips them from every message, except
// one the server itself made (serverSend). No imports: the runner reads it.

const TAG = /^\s*<(cw-bot-(?:events|kickoff|continue))(?=[\s>/])[^>]*>/i;

/** the server's own messages, while they are being sent */
const issued = new Set<string>();

/**
 * Drops every leading <cw-bot-…>…</cw-bot-…> block; a leading opening tag with no end loses its `<` (shown as ‹, so
 * nothing is hidden). Text the server is sending itself (serverSend) passes unchanged.
 */
export function stripBotTags(text: string): string {
  if (issued.has(text)) return text;
  let t = text;
  for (let m = TAG.exec(t); m; m = TAG.exec(t)) {
    const close = new RegExp(`</${m[1]}\\s*>`, 'i').exec(t.slice(m[0].length));
    if (!close) return t.replace(/^(\s*)</, '$1‹');
    t = t.slice(m[0].length + close.index + close[0].length).replace(/^\s+/, '');
  }
  // nothing left (the message was only such blocks): kept, but shown — an empty text block is refused by the API
  return t === text || t.trim() ? t : text.replace(/^(\s*)</, '$1‹');
}

/** sends text the server made (with its hidden blocks) through a runner that strips them from anything else */
export function serverSend<A extends unknown[]>(r: { send(text: string, ...rest: A): void }, text: string, ...rest: A): void {
  issued.add(text);
  try { r.send(text, ...rest); } finally { issued.delete(text); }
}
