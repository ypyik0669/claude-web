import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react';
import { useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { parsePeerId } from '@shared';
import { NO_MODS, PASTE_DENIED, PASTE_EMPTY, PASTE_NO_API, TERM_KEYS, TERM_KEYS_LABEL, applyMods, pasteBytes, pressKey, type Mods, type TermKeyId, type TermModes } from './term-keys';

/** The bundled mono face first (tokens.css `--mono`), then what the system has. */
const TERM_FONT = "'JetBrains Mono Variable', 'Cascadia Code', Consolas, monospace";
/** The same list written another way: xterm measures a cell again only when the option's value changes. */
const TERM_FONT_AGAIN = `${TERM_FONT}, monospace`;
const TERM_FONT_SIZE = 13;
/** How long opening the terminal waits for the bundled face (it is measured once, when it opens). */
const FONT_WAIT_MS = 1500;

/** Resolves true once the bundled mono face can be drawn; false when the browser cannot say or it fails to load. */
function monoFaceReady(): Promise<boolean> {
  const fonts = (document as any).fonts;
  if (!fonts?.load) return Promise.resolve(false);
  try {
    return Promise.resolve(fonts.load(`${TERM_FONT_SIZE}px 'JetBrains Mono Variable'`, 'Aa0')).then((faces: unknown[]) => faces?.length > 0, () => false);
  } catch { return Promise.resolve(false); }
}

/** Embedded terminal (a shell — server terminalShell(); the bundled `claude` is on its PATH) via node-pty + xterm.js. `cmd` is typed in once it starts. */
export function TerminalPanel({ cwd, cmd, visible = true }: { cwd?: string; cmd?: string; visible?: boolean }) {
  const active = useScopedSession();
  // a session on another machine: its cwd doesn't exist here — the terminal opens in the default directory
  const dir = cwd ?? (active && !parsePeerId(active.sessionId) ? active.cwd : '');
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [termId, setTermId] = useState<string | null>(null);
  const fitRef = useRef<() => void>(() => {});
  // a phone has no Esc / Tab / Ctrl / arrows on its keyboard: a row of them under the terminal (term-keys.ts)
  const mobile = useStore((s) => s.mobile);
  const termRef = useRef<any>(null); // the xterm, for the row: which modes the program asked for, and the focus
  // Ctrl / Alt armed on the row: the ref is what the terminal's input reads, the state is what the row shows
  const [mods, setMods] = useState<Mods>(NO_MODS);
  const modsRef = useRef<Mods>(NO_MODS);
  const hadFocus = useRef(false);

  useEffect(() => {
    let disposed = false;
    let term: any;
    let fit: any;
    let id: string | null = null;
    let off: (() => void) | undefined;
    let ro: ResizeObserver | undefined;
    let raf = 0;
    let sent = ''; // cols x rows the pty last heard about
    (async () => {
      try {
        const face = monoFaceReady();
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        await import('@xterm/xterm/css/xterm.css');
        // xterm measures a cell when it opens: with the bundled face still on its way that would be the fallback's
        // width. It is usually there already; a slow link gets a moment, and a later arrival is measured again below
        const inTime = await Promise.race([face, new Promise<boolean>((r) => setTimeout(() => r(false), FONT_WAIT_MS))]);
        if (disposed) return;
        const cs = getComputedStyle(document.documentElement);
        term = new Terminal({ fontFamily: TERM_FONT, fontSize: TERM_FONT_SIZE, theme: { background: cs.getPropertyValue('--bg').trim() || '#000', foreground: cs.getPropertyValue('--fg').trim() || '#eee' }, cursorBlink: true, convertEol: false, allowProposedApi: true });
        termRef.current = term;
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(ref.current!);
        fit.fit();
        fitRef.current = () => {
          try {
            fit.fit();
            const size = `${term.cols}x${term.rows}`;
            if (id && size !== sent) { sent = size; void ws.request({ kind: 'terminal.resize', termId: id, cols: term.cols, rows: term.rows }); }
          } catch { /* ignore */ }
        };
        if (!inTime) void face.then((ok) => { if (ok && !disposed) { try { term.options.fontFamily = TERM_FONT_AGAIN; } catch { /* ignore */ } fitRef.current(); } });
        sent = `${term.cols}x${term.rows}`;
        const r = await ws.request<{ termId: string }>({ kind: 'terminal.open', cwd: dir, cols: term.cols, rows: term.rows });
        // unmounted (or cwd changed) while the pty was spawning: the cleanup ran with no id, so close it here
        if (disposed) { void ws.request({ kind: 'terminal.close', termId: r.termId }).catch(() => {}); return; }
        id = r.termId;
        setTermId(id);
        fitRef.current(); // the box may have changed size while the pty was starting
        if (cmd) setTimeout(() => { void ws.request({ kind: 'terminal.input', termId: id!, data: cmd + '\r' }); }, 400);
        term.onData((d: string) => {
          // Ctrl / Alt armed on the phone's key row go onto this key press, then let go
          const typed = applyMods(d, modsRef.current);
          if (typed.used) { modsRef.current = NO_MODS; setMods(NO_MODS); }
          return ws.request({ kind: 'terminal.input', termId: id!, data: typed.data });
        });
        off = ws.on((e) => {
          if (e.kind === 'terminal.data' && e.termId === id) term.write(e.data);
          if (e.kind === 'terminal.exit' && e.termId === id) term.write(`\r\n[进程退出 ${e.code}]`);
        });
        // fit() resizes the observed box: defer it a frame, or the browser reports "ResizeObserver loop completed"
        ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => fitRef.current()); });
        ro.observe(ref.current!);
      } catch (e: any) {
        setErr(e.message);
      }
    })();
    return () => {
      disposed = true;
      off?.();
      ro?.disconnect();
      cancelAnimationFrame(raf);
      if (id) void ws.request({ kind: 'terminal.close', termId: id }).catch(() => {});
      if (termRef.current === term) termRef.current = null;
      term?.dispose();
    };
  }, [dir]);

  // re-fit when the tile becomes visible again (hidden tiles have zero size)
  useEffect(() => { if (visible) setTimeout(() => fitRef.current(), 30); }, [visible]);

  // the row is gone (a wider window): nothing may stay armed where it cannot be seen
  useEffect(() => { if (!mobile) { modsRef.current = NO_MODS; setMods(NO_MODS); } }, [mobile]);

  if (err)
    return (
      <div className="empty">
        终端不可用：{err}
        <div style={{ marginTop: 8, fontSize: 12 }}>在 claude-web 目录运行 <code>npm i -w server node-pty</code>（需要 VS Build Tools）后重启服务。</div>
      </div>
    );

  const modes = (): TermModes => ({ appCursor: !!termRef.current?.modes?.applicationCursorKeysMode, bracketedPaste: !!termRef.current?.modes?.bracketedPasteMode });
  const send = (data: string) => {
    if (!termId || !data) return;
    termRef.current?.scrollToBottom?.(); // as typing does
    void ws.request({ kind: 'terminal.input', termId, data }).catch(() => {});
  };
  /** the tap took the focus off the terminal after all (a browser that ignores the cancelled press): give it back */
  const refocus = (had: boolean) => { if (had && !ref.current?.contains(document.activeElement)) termRef.current?.focus?.(); };
  const paste = async (had: boolean) => {
    const toast = (text: string) => useStore.getState().toast(text);
    const clip = navigator.clipboard;
    // no clipboard at all: a page that is not https (a phone on the local network's http address) is not given one
    if (!clip?.readText) { toast(window.isSecureContext ? PASTE_DENIED : PASTE_NO_API); return; }
    let text: string;
    try { text = await clip.readText(); } catch { toast(PASTE_DENIED); return; } finally { refocus(had); }
    if (!text) { toast(PASTE_EMPTY); return; }
    send(pasteBytes(text, modes()));
  };
  const onKey = (id: TermKeyId) => {
    const had = hadFocus.current;
    hadFocus.current = false;
    const r = pressKey(id, modsRef.current, modes());
    modsRef.current = r.mods;
    setMods(r.mods);
    if (r.send) send(r.send);
    if (r.paste) void paste(had);
    refocus(had);
  };
  /** a tap on the row must not blur the terminal — the keyboard would slide away under the finger */
  const keepFocus = (e: SyntheticEvent) => e.preventDefault();
  const onDown = (e: ReactPointerEvent) => { hadFocus.current = !!ref.current?.contains(document.activeElement); e.preventDefault(); };

  // the terminal's own box never moves in this tree (the row comes and goes after it): the pty and the buffer stay
  return (
    <div className="term-wrap">
      <div ref={ref} className="term" style={{ height: '100%', padding: 4 }} data-term={termId ?? ''} />
      {mobile && (
        <div className="term-keys" role="toolbar" aria-label={TERM_KEYS_LABEL} onPointerDown={onDown} onMouseDown={keepFocus}>
          {TERM_KEYS.map((k) => (
            <button key={k.id} type="button" className="term-key" data-key={k.id} aria-label={k.name} aria-pressed={k.id === 'ctrl' || k.id === 'alt' ? mods[k.id] : undefined} onClick={() => onKey(k.id)}>{k.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
