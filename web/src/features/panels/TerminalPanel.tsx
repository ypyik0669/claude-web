import { useEffect, useRef, useState } from 'react';
import { useActive } from '@/store';
import { ws } from '@/ws/client';

/** Embedded real `claude` CLI via node-pty + xterm.js. Escape hatch for interactive-only commands (/login, /theme…). */
export function TerminalPanel() {
  const active = useActive();
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [termId, setTermId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let term: any;
    let fit: any;
    let id: string | null = null;
    let off: (() => void) | undefined;
    (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        await import('@xterm/xterm/css/xterm.css');
        if (disposed) return;
        term = new Terminal({ fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace', fontSize: 12.5, theme: { background: '#000000' }, cursorBlink: true, convertEol: false });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(ref.current!);
        fit.fit();
        const r = await ws.request<{ termId: string }>({ kind: 'terminal.open', cwd: active?.cwd || 'C:\\', cols: term.cols, rows: term.rows });
        id = r.termId;
        setTermId(id);
        term.onData((d: string) => ws.request({ kind: 'terminal.input', termId: id!, data: d }));
        off = ws.on((e) => {
          if (e.kind === 'terminal.data' && e.termId === id) term.write(e.data);
          if (e.kind === 'terminal.exit' && e.termId === id) term.write(`\r\n[进程退出 ${e.code}]`);
        });
        const ro = new ResizeObserver(() => {
          fit.fit();
          void ws.request({ kind: 'terminal.resize', termId: id!, cols: term.cols, rows: term.rows });
        });
        ro.observe(ref.current!);
      } catch (e: any) {
        setErr(e.message);
      }
    })();
    return () => {
      disposed = true;
      off?.();
      if (id) void ws.request({ kind: 'terminal.close', termId: id });
      term?.dispose();
    };
  }, []);

  if (err)
    return (
      <div className="empty">
        终端不可用：{err}
        <div style={{ marginTop: 8, fontSize: 11.5 }}>在 claude-web 目录运行 <code>npm i -w server node-pty</code>（需要 VS Build Tools）后重启服务。</div>
      </div>
    );
  return <div ref={ref} className="term" style={{ height: '100%', padding: 4 }} data-term={termId ?? ''} />;
}
