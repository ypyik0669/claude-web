// The message a fork is cut at, as the transcript on disk names it.
//
// The CLI gives a message with several content blocks one uuid per block on the wire: the first 24 characters of the
// message's own uuid, then the block's index as 12 hex digits (`8c1139cb-e3ed-41d3-a1a8-000000000001`). The transcript
// keeps the message under its own uuid only, so `forkSession({ upToMessageId })` with what a live conversation showed
// failed "Message … not found in session …" (2026-11-13 user report). A conversation loaded from disk has the real ones.
import fs from 'node:fs';

const PREFIX = 24;

/** `uuid` when the transcript has it (or cannot be read); else the message whose uuid starts the same way; else `uuid`. */
export function forkAnchor(file: string | null, uuid: string | undefined): string | undefined {
  if (!uuid || uuid.length <= PREFIX || !file) return uuid;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return uuid; }
  if (text.includes(`"uuid":"${uuid}"`)) return uuid;
  const head = `"uuid":"${uuid.slice(0, PREFIX)}`;
  let found: string | undefined;
  for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + 1)) {
    const end = text.indexOf('"', at + 8);
    const id = end > 0 ? text.slice(at + 8, end) : '';
    // the last one: a message rewritten later in the file (a repaired leaf) is the one the chain ends on
    if (id.length === uuid.length) found = id;
  }
  return found ?? uuid;
}
