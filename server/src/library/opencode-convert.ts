// OpenCode `GET /session/{id}/message` response → SDK-shaped messages for the transcript view.
// See task-4-brief.md for the wire shape: `[{info:{role,time,id,sessionID,…}, parts:[…]}]`.
import { MessageSynth, mapToolName } from '../agents/normalize.js';

function textOf(parts: any[]): string {
  return (parts ?? []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
}

/**
 * A page of `GET /session/{id}/message` entries, oldest first, → the SDK-shaped messages for the
 * transcript view. Historical replay only wants terminal messages, so `stream_event` scaffolding
 * is filtered out at the end (same convention as `codexTurnsToMessages`).
 */
export function opencodeToMessages(sessionId: string, msgs: { info: any; parts: any[] }[]): any[] {
  const synth = new MessageSynth(sessionId, '');
  const out: any[] = [];
  for (const m of msgs ?? []) {
    const info = m.info ?? {};
    const parts = m.parts ?? [];
    if (info.role === 'user') {
      out.push(synth.user(textOf(parts)));
      continue;
    }
    // assistant
    synth.beginTurn();
    for (const part of parts) {
      switch (part?.type) {
        case 'text': out.push(...synth.text(part.text ?? '')); break;
        case 'reasoning': out.push(...synth.delta('thinking', part.text ?? '')); break;
        case 'tool': {
          const name = mapToolName(undefined, part.tool, part);
          out.push(...synth.toolUse(part.callID, name, part.state?.input ?? {}));
          out.push(synth.toolResult(part.callID, String(part.state?.output ?? part.state?.error ?? ''), part.state?.status === 'error'));
          break;
        }
        default: break;
      }
    }
    out.push(...synth.endTurn({ ok: true }));
  }
  return out.filter((m) => m.type !== 'stream_event');
}
