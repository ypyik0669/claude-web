import { MessageSynth } from './normalize.js';

/** Per-item running state, keyed by item id: what tool it became and its aggregated output so far. */
export type CodexItemState = Map<string, { type: string; toolName?: string; output: string }>;

/**
 * One `item/started` or `item/completed` notification (or, for history replay, an already-`completed`
 * item straight off a turn) → the SDK-shaped messages it produces. Shared by the live driver
 * (`CodexDriver.onItem`) and the history converter (`codexTurnsToMessages`) so both read Codex's item
 * shapes the same way.
 */
export function codexItemMessages(synth: MessageSynth, seen: CodexItemState, item: any, completed: boolean): any[] {
  if (!item) return [];
  const known = seen.get(item.id);
  const out: any[] = [];
  switch (item.type) {
    case 'commandExecution': {
      if (!known) { seen.set(item.id, { type: item.type, toolName: 'Bash', output: '' }); out.push(...synth.toolUse(item.id, 'Bash', { command: item.command, description: item.commandActions?.map((a: any) => a.type).join(', ') })); }
      if (completed) { const outp = item.aggregatedOutput ?? seen.get(item.id)?.output ?? ''; out.push(synth.toolResult(item.id, outp, item.status === 'failed' || (item.exitCode ?? 0) !== 0, { stdout: outp, stderr: '', interrupted: item.status === 'interrupted', exitCode: item.exitCode })); }
      break;
    }
    case 'fileChange': {
      // PatchChangeKind (per `codex app-server generate-ts`) is `{type:'add'}|{type:'delete'}|{type:'update',move_path}`,
      // not the bare string 'add' — accept either shape so a genuine kind object is recognized.
      if (!known) { seen.set(item.id, { type: item.type, toolName: 'Edit', output: '' }); for (const ch of item.changes ?? []) { const kind = typeof ch.kind === 'string' ? ch.kind : ch.kind?.type; out.push(...synth.toolUse(`${item.id}:${ch.path}`, kind === 'add' ? 'Write' : 'Edit', { file_path: ch.path, diff: ch.diff })); } }
      if (completed) for (const ch of item.changes ?? []) out.push(synth.toolResult(`${item.id}:${ch.path}`, ch.diff ?? 'applied', item.status === 'failed', { filePath: ch.path, unified: ch.diff }));
      break;
    }
    case 'mcpToolCall': {
      const name = `mcp__${item.server}__${item.tool}`;
      if (!known) { seen.set(item.id, { type: item.type, toolName: name, output: '' }); out.push(...synth.toolUse(item.id, name, (item.arguments as any) ?? {})); }
      if (completed) out.push(synth.toolResult(item.id, JSON.stringify(item.result ?? item.error ?? null, null, 2), !!item.error, item.result));
      break;
    }
    case 'dynamicToolCall': {
      const name = item.tool ?? 'Tool';
      if (!known) { seen.set(item.id, { type: item.type, toolName: name, output: '' }); out.push(...synth.toolUse(item.id, name, (item.arguments as any) ?? {})); }
      if (completed) out.push(synth.toolResult(item.id, (item.contentItems ?? []).map((c: any) => c.text ?? JSON.stringify(c)).join('\n'), item.success === false));
      break;
    }
    case 'plan': if (completed && item.text) out.push(...synth.delta('text', `\n\n**计划**\n${item.text}\n`)); break;
    case 'webSearch': {
      if (!known) { seen.set(item.id, { type: item.type, toolName: 'WebSearch', output: '' }); out.push(...synth.toolUse(item.id, 'WebSearch', { query: item.query })); }
      if (completed) out.push(synth.toolResult(item.id, item.query ?? 'done'));
      break;
    }
    default: break;
  }
  return out;
}

/**
 * A page of `thread/turns/list` turns, already reversed into chronological order, → the SDK-shaped
 * messages for the transcript view. Historical replay only wants terminal messages (no
 * `stream_event` streaming scaffolding), so every item is treated as already `completed`.
 */
export function codexTurnsToMessages(sessionId: string, turns: any[], model?: string): any[] {
  const synth = new MessageSynth(sessionId, model ?? '');
  const seen: CodexItemState = new Map();
  const out: any[] = [];
  for (const turn of turns ?? []) {
    synth.beginTurn();
    for (const item of turn.items ?? []) {
      switch (item.type) {
        case 'userMessage': {
          const text = (item.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
          out.push(synth.user(text));
          break;
        }
        case 'agentMessage': out.push(...synth.text(item.text ?? '')); break;
        case 'reasoning': out.push(...synth.delta('thinking', [...(item.summary ?? []), ...(item.content ?? [])].join('\n'))); break;
        default: out.push(...codexItemMessages(synth, seen, item, true)); break;
      }
    }
    out.push(...synth.endTurn({ ok: turn.status === 'completed' || turn.status === 'interrupted', error: turn.error?.message }));
  }
  return out.filter((m) => m.type !== 'stream_event');
}
