import fs from 'node:fs';

export interface TreeWatcher {
  close(): void;
}

/**
 * Watch a directory tree through one native recursive handle (`fs.watch` with `recursive`: ReadDirectoryChangesW on
 * Windows, FSEvents on macOS, inotify per directory on Linux). chokidar watches every file on its own: for
 * ~/.claude/projects (thousands of transcripts, tool results and sub-agent logs) that was ~18 s of synchronous
 * fs.watch calls right after the server started listening, and the desktop window — which waits for the page — stayed
 * invisible for over a minute. `onChange(rel)` gets the changed path relative to `dir` (null when the platform doesn't
 * say, and once when a directory that didn't exist is found). A missing directory is looked for every `pollMs` and
 * watched once it appears; a handle that errors (the tree removed — EPERM on Windows) goes back to looking.
 */
export function watchTree(dir: string, onChange: (rel: string | null) => void, o: { pollMs?: number } = {}): TreeWatcher {
  let w: fs.FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const drop = () => {
    try { w?.close(); } catch { /* already closed */ }
    w = null;
  };
  const start = (): boolean => {
    try {
      w = fs.watch(dir, { recursive: true }, (_ev, file) => onChange(file == null ? null : String(file)));
    } catch {
      return false;
    }
    w.on('error', () => {
      drop();
      if (!closed) poll();
    });
    return true;
  };
  const poll = () => {
    if (timer || closed) return;
    timer = setInterval(() => {
      if (closed || !fs.existsSync(dir) || !start()) return;
      if (timer) clearInterval(timer);
      timer = null;
      onChange(null);
    }, o.pollMs ?? 30_000);
    timer.unref?.();
  };
  if (!start()) poll();
  return {
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      drop();
    },
  };
}
