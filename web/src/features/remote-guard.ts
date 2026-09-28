import { useStore } from '@/store';
import { remoteOpenBlock } from './peers';

/**
 * Call before opening a file that came from a session's context (a tool card path, an attachment, an
 * artifact, the inspector): a session on another machine refers to THAT machine's disk — opening the
 * same path here would show (and the editor would auto-save into) an unrelated local file. Returns
 * true (and tells the user where the file is) when the open must not happen.
 */
export function blockRemoteOpen(sessionId: string | null | undefined, path?: string): boolean {
  const st = useStore.getState();
  const note = remoteOpenBlock(sessionId, st.sessions, path);
  if (!note) return false;
  st.toast(note);
  return true;
}
