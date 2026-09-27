import { messagesToEvents, type CanonicalLog } from '../session/canonical.js';
import { renderBriefing } from '../session/handoff.js';

/**
 * Referencing another session's history from inside a conversation.
 *
 * The composer inserts a marker (`<session-ref id="…" title="…" />`) when the user picks a session
 * from the library to reference; this module expands it server-side, right before the text reaches
 * the agent, into the same handoff briefing `swapAgent` uses — a structured summary, not a raw
 * transcript dump. A failed read becomes an `error=` attribute rather than vanishing silently: the
 * agent (and the user, if they look) needs to know the reference didn't resolve.
 */

// tolerant of attribute order; each attribute value is captured raw (still HTML-attribute-escaped)
const SESSION_REF_RE = /<session-ref\s+([^>]*?)\/>/g;

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m?.[1];
}

/** Undo the escaping the composer applies to attribute values (&quot; &amp; &lt; &gt;). */
function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace every `<session-ref id="…" title="…" />` marker in `text` with a rendered briefing of
 * that session's native history (fetched via `readAll`), wrapped in `<referenced-session>`. A
 * reference whose history can't be read becomes `<referenced-session … error="无法读取：…" />`
 * rather than being dropped — the caller (and eventually the user) should know it didn't resolve.
 * Text with no marker is returned unchanged.
 */
export async function expandSessionRefs(text: string, readAll: (id: string) => Promise<any[]>): Promise<string> {
  if (!text.includes('<session-ref ')) return text;
  const matches = [...text.matchAll(SESSION_REF_RE)];
  if (!matches.length) return text;

  // assembled by position, never String.replace: a briefing is arbitrary text and `$&`, `$'`, `` $` ``,
  // `$$` in it would be read as replacement patterns (and an earlier briefing could contain a marker)
  let out = '';
  let last = 0;
  for (const m of matches) {
    const whole = m[0];
    const attrs = m[1];
    const idRaw = attr(attrs, 'id') ?? '';
    const titleRaw = attr(attrs, 'title') ?? '';
    const id = unescapeAttr(idRaw);

    let replacement: string;
    try {
      const messages = await readAll(id);
      const events = messagesToEvents(messages);
      const briefing = renderBriefing(events).text;
      replacement = `<referenced-session id="${idRaw}" title="${titleRaw}">\n${briefing}\n</referenced-session>`;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      replacement = `<referenced-session id="${idRaw}" title="${titleRaw}" error="无法读取：${escapeAttr(reason)}" />`;
    }
    const at = m.index ?? text.indexOf(whole, last);
    out += text.slice(last, at) + replacement;
    last = at + whole.length;
  }
  return out + text.slice(last);
}

/**
 * Mirror a native transcript into the canonical log, one message at a time — used by `swapAgent`
 * to seed a session's canonical timeline from library history when nothing was ever observed
 * locally (an imported session being handed to a different agent for the first time).
 */
export async function seedCanonical(canonical: CanonicalLog, sessionId: string, messages: any[]): Promise<void> {
  for (const m of messages) canonical.observe(sessionId, m);
  await canonical.settled(sessionId);
}
