// 值班 Bot thread: a routine run's conversation, read only, as a sub-view of the thread column. The live one when this
// window has it open, else read from disk (transcript.load) — again every few seconds while it runs. Read only on
// purpose: opening a run conversation as a session would make it a conversation the user types into, outside its gate.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { applyTranscript, createConversation } from '@/model/conversation';
import { ItemList } from '@/features/chat/ChatView';
import { unwrapHarnessMessage } from '@/features/background/model';
import { tr } from '@/i18n';

const REFRESH_MS = 3000;

function FromDisk({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [msgs, setMsgs] = useState<unknown[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setMsgs(null); setErr('');
    let on = true;
    const read = () => ws.request<unknown[]>({ kind: 'transcript.load', sessionId })
      .then((m) => { if (on) setMsgs(Array.isArray(m) ? m : []); })
      .catch((e: unknown) => { if (on) setErr(String((e as { message?: string })?.message ?? e)); });
    void read();
    const t = live ? setInterval(read, REFRESH_MS) : undefined;
    return () => { on = false; if (t) clearInterval(t); };
  }, [sessionId, live]);
  const conv = useMemo(() => {
    if (!msgs) return null;
    const c = createConversation();
    applyTranscript(c, (msgs as any[]).map(unwrapHarnessMessage), { live });
    return c;
  }, [msgs, live]);
  if (err) return <div className="bt-note">{tr('读不到它的对话：{err}', { err })}</div>;
  if (!conv) return <div className="bt-note">{tr('读取中…')}</div>;
  if (!conv.items.length) return <div className="bt-note">{tr('它还没说话。')}</div>;
  return <ItemList items={conv.items} version={msgs?.length ?? 0} actions="none" />;
}

export function RunView({ sessionId, live }: { sessionId: string; live: boolean }) {
  const open = useStore((s) => s.open[sessionId]);
  if (open) return <ItemList items={open.conv.items} version={open.version} actions="none" />;
  return <FromDisk sessionId={sessionId} live={live} />;
}
