import { useEffect, useRef, useState } from 'react';
import { useScopedSession } from '@/store';
import { ws } from '@/ws/client';
import { parsePeerId } from '@shared';

/** Embedded real `claude` CLI via node-pty + xterm.js. Escape hatch for interactive-only commands (/login, /theme…). */
export function TerminalPanel({ cwd, cmd, visible = true }: { cwd?: string; cmd?: string; visible?: boolean }) {
  const active = useScopedSession();
  // a session on another machine: its cwd doesn't exist here — the terminal opens in the default directory
  const dir = cwd ?? (active && !parsePeerId(active.sessionId) ? active.cwd : '');
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [termId, setTermId] = useState<string | null>(null);
  const fitRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let term: any;
    let fit: any;
    let id: string | null = null;
    let off: (() => void) | undefined;
    let ro: ResizeObserver | undefined;
    (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        await import('@xterm/xterm/css/xterm.css');
        if (disposed) return;
        const cs = getComputedStyle(document.documentElement);
        term = new Terminal({ fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace', fontSize: 12.5, theme: { background: cs.getPropertyValue('--bg').trim() || '#000', foreground: cs.getPropertyValue('--fg').trim() || '#eee' }, cursorBlink: true, convertEol: false, allowProposedApi: true });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(ref.current!);
        fit.fit();
        fitRef.current = () => { try { fit.fit(); if (id) void ws.request({ kind: 'terminal.resize', termId: id, cols: term.cols, rows: term.rows }); } catch { /* ignore */ } };
        const r = await ws.request<{ termId: string }>({ kind: 'terminal.open', cwd: dir, cols: term.cols, rows: term.rows });
        // unmounted (or cwd changed) while the pty was spawning: the cleanup ran with no id, so close it here
        if (disposed) { void ws.request({ kind: 'terminal.close', termId: r.termId }).catch(() => {}); return; }
        id = r.termId;
        setTermId(id);
        if (cmd) setTimeout(() => { void ws.request({ kind: 'terminal.input', termId: id!, data: cmd + '\r' }); }, 400);
        term.onData((d: string) => ws.request({ kind: 'terminal.input', termId: id!, data: d }));
        off = ws.on((e) => {
          if (e.kind === 'terminal.data' && e.termId === id) term.write(e.data);
          if (e.kind === 'terminal.exit' && e.termId === id) term.write(`\r\n[进程退出 ${e.code}]`);
        });
        ro = new ResizeObserver(() => fitRef.current());
        ro.observe(ref.current!);
      } catch (e: any) {
        setErr(e.message);
      }
    })();
    return () => {
      disposed = true;
      off?.();
      ro?.disconnect();
      if (id) void ws.request({ kind: 'terminal.close', termId: id }).catch(() => {});
      term?.dispose();
    };
  }, [dir]);

  // re-fit when the tile becomes visible again (hidden tiles have zero size)
  useEffect(() => { if (visible) setTimeout(() => fitRef.current(), 30); }, [visible]);

  if (err)
    return (
      <div className="empty">
        终端不可用：{err}
        <div style={{ marginTop: 8, fontSize: 11.5 }}>在 claude-web 目录运行 <code>npm i -w server node-pty</code>（需要 VS Build Tools）后重启服务。</div>
      </div>
    );
  return <div ref={ref} className="term" style={{ height: '100%', padding: 4 }} data-term={termId ?? ''} />;
}
