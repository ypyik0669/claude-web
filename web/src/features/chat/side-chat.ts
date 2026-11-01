// 旁聊 (spec 2026-10-16 chat-input §1): one side chat at a time, over the conversation it asks about. It lives here,
// in memory only — closing it forgets it (the official app does the same); nothing goes into the transcript.
import { create } from 'zustand';
import { useStore } from '@/store';
import { resumeParams } from '@/store/reopen';
import { ws } from '@/ws/client';
import { tr } from '@/i18n';
import { sideHistory, type SideQA } from './side-chat-model';

const genUuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

interface SideChatState {
  /** the conversation it is about; null = closed */
  sessionId: string | null;
  qas: SideQA[];
  /** bumped to put the focus in the card's own input line */
  focusTick: number;
  /** text to put in the card's input line when it opens (a quoted selection); taken once */
  draft: string;
}

export const useSideChat = create<SideChatState>(() => ({ sessionId: null, qas: [], focusTick: 0, draft: '' }));

/**
 * Opens the side chat on a conversation (a different one starts afresh), and asks `question` if there is one.
 * `draft`: put in the card's input line, not sent (the selection menu's 旁聊: the quote, the user adds the question).
 */
export function openSideChat(sessionId: string, question?: string, draft?: string): void {
  const cur = useSideChat.getState();
  useSideChat.setState({ sessionId, qas: cur.sessionId === sessionId ? cur.qas : [], focusTick: cur.focusTick + 1, draft: draft ?? '' });
  if (question) void askSide(question);
}

export function closeSideChat(): void {
  useSideChat.setState({ sessionId: null, qas: [], draft: '' });
}

const patch = (id: string, p: Partial<SideQA>) =>
  useSideChat.setState((s) => ({ qas: s.qas.map((x) => (x.id === id ? { ...x, ...p } : x)) }));

/** Stops waiting for a question: its answer, if it still comes, is dropped. */
export function dropSide(id: string): void {
  useSideChat.setState((s) => ({ qas: s.qas.filter((x) => x.id !== id) }));
}

export async function askSide(question: string): Promise<void> {
  const { sessionId, qas } = useSideChat.getState();
  if (!sessionId || !question.trim()) return;
  const id = genUuid();
  const history = sideHistory(qas);
  useSideChat.setState({ qas: [...qas, { id, question: question.trim() }] });
  const ask = () => ws.request({ kind: 'session.side', sessionId, question: question.trim(), history }) as Promise<{ text?: string | null; error?: string }>;
  try {
    let r = await ask();
    if (r.error === 'not-open') {
      // closed / reclaimed / opened from history: start it again (nothing is sent to it) and ask once more
      const st = useStore.getState();
      const o = st.open[sessionId];
      if (!o) throw new Error(tr('这个对话没有打开'));
      await st.openSession({ sessionId, cwd: o.cwd, ...resumeParams(o, st.sessionMeta[sessionId]) }, 'none');
      r = await ask();
    }
    if (r.error) throw new Error(r.error === 'unsupported' ? tr('这个对话不支持旁聊') : tr('这个对话没在运行，没法旁聊'));
    if (useSideChat.getState().sessionId !== sessionId) return;
    patch(id, { response: r.text ?? null });
  } catch (e: any) {
    if (useSideChat.getState().sessionId !== sessionId) return;
    patch(id, { error: String(e?.message ?? e) });
  }
}
