import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from '@/util';
import { highlight, normalizeLang } from './highlight';
import { Icon } from '@/ui/icons';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { BLANK_CHECK_MS, BLANK_REPORTS_MAX, blankMessage, blankProblem, browserOf, nextStep, type BlankFix, type BlankInfo, type BlankProblem, type CodeProbe } from './code-blank';

const MermaidBlock = lazy(() => import('./MermaidBlock'));

// ---- blank-block guard (see code-blank.ts) ----
const OWN_TAGS = new Set(['CODE', 'SPAN', 'TABLE', 'TBODY', 'TR', 'TD']);
let blankReports = 0;

/** first background behind the block that is (nearly) opaque: the text colour is judged against it */
function backgroundOf(el: Element | null): string {
  for (let e = el; e; e = e.parentElement) {
    const bg = getComputedStyle(e).backgroundColor;
    const a = /rgba\([^)]*[,/]\s*([\d.]+)\s*\)/.exec(bg);
    if (bg !== 'transparent' && (!a || parseFloat(a[1]) >= 0.95)) return bg;
  }
  return 'transparent';
}

function probe(pre: HTMLPreElement): CodeProbe {
  const box = (pre.firstElementChild as HTMLElement | null) ?? pre;
  const ps = getComputedStyle(pre);
  const lh = parseFloat(ps.lineHeight);
  return {
    textLen: (pre.textContent ?? '').replace(/\s+/g, '').length,
    rendered: pre.getClientRects().length > 0,
    height: box.getBoundingClientRect().height,
    lineHeight: Number.isFinite(lh) ? lh : parseFloat(ps.fontSize) * 1.2,
    color: getComputedStyle(box).color,
    background: backgroundOf(pre),
  };
}

/** what else has been in the block's DOM: read before the redraw replaces it */
function intruders(pre: HTMLPreElement): Pick<BlankInfo, 'translated' | 'foreignTags' | 'foreignAttrs'> {
  const tags = new Set<string>();
  const attrs = new Set<string>();
  const els = [pre, ...Array.from(pre.querySelectorAll('*')).slice(0, 2000)];
  for (const el of els) {
    if (el !== pre && !OWN_TAGS.has(el.tagName)) tags.add(el.tagName.toLowerCase());
    for (const a of Array.from(el.attributes)) if (a.name !== 'class') attrs.add(a.name);
  }
  const html = document.documentElement;
  const translated = /\btranslated-(?:ltr|rtl)\b/.test(html.className) ? 'Google 翻译'
    : html.hasAttribute('_msthash') || attrs.has('_msthash') || attrs.has('_msttexthash') ? '微软翻译'
    : null;
  return { translated, foreignTags: [...tags], foreignAttrs: [...attrs] };
}

function reportBlank(info: BlankInfo) {
  if (blankReports >= BLANK_REPORTS_MAX) return;
  blankReports++;
  const message = blankMessage(info);
  // eslint-disable-next-line no-console
  console.warn(`[code block] ${message}`);
  ws.request({ kind: 'client.log', level: 'warn', area: '代码块', message, url: location.pathname }).catch(() => {});
}

export interface CodeBlockProps {
  code: string;
  lang?: string;
  /** file path shown in the header (also used to guess the language) */
  title?: string;
  /** 1-based number of the first line (Read with offset) */
  startLine?: number;
  lineNumbers?: boolean;
  /** streaming: skip mermaid rendering until the block is complete */
  streaming?: boolean;
  /** wrap long lines by default */
  wrap?: boolean;
  /** collapse beyond this many lines with a "show all" toggle; 0 = never */
  maxLines?: number;
  className?: string;
  footer?: React.ReactNode;
}

/** How long the copy button shows its check (UI refresh §6). */
const COPIED_MS = 1400;

function useCopy() {
  const [ok, setOk] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    ok,
    copy(text: string) {
      void navigator.clipboard.writeText(text).then(() => {
        setOk(true);
        clearTimeout(timer.current); // copied again while the check shows: it stays for its full time
        timer.current = setTimeout(() => setOk(false), COPIED_MS);
      });
    },
  };
}

/** Highlighted code with a header (language, size, copy, wrap) — used by markdown fences and tool cards. */
export const CodeBlock = memo(function CodeBlock({ code, lang, title, startLine = 1, lineNumbers, streaming, wrap: wrap0, maxLines = 0, className, footer }: CodeBlockProps) {
  const [wrap, setWrap] = useState(!!wrap0);
  const [all, setAll] = useState(false);
  const { ok, copy } = useCopy();
  const l = normalizeLang(lang);
  const text = code.endsWith('\n') ? code.slice(0, -1) : code;
  const lines = useMemo(() => text.split('\n'), [text]);
  const truncated = maxLines > 0 && !all && lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines).join('\n') : text;
  const body = useMemo(() => highlight(shown, l), [shown, l]);
  const isMermaid = lang === 'mermaid';
  const label = title ?? (l && l !== 'plaintext' ? l : lang || '');
  // a block with text that shows none: redraw once, then plain text, then say so in server.log (code-blank.ts)
  const preRef = useRef<HTMLPreElement>(null);
  const [fix, setFix] = useState<BlankFix>(0);
  const seen = useRef<(Pick<BlankInfo, 'translated' | 'foreignTags' | 'foreignAttrs'> & { problem: BlankProblem }) | null>(null);
  const settled = useRef(false);
  const guarded = !(isMermaid && !streaming);
  const shownLines = truncated ? maxLines : lines.length;
  useEffect(() => {
    const pre = preRef.current;
    if (!guarded || settled.current || !pre) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const problem = blankProblem(shown, probe(pre), shownLines);
      if (problem && !seen.current) seen.current = { problem, ...intruders(pre) };
      const step = nextStep(fix, problem);
      if (!step) return;
      if ('fix' in step) { setFix(step.fix); return; }
      settled.current = true;
      reportBlank({
        ...seen.current!, outcome: step.report, lang, lines: lines.length, chars: text.length, streaming: !!streaming,
        forcedColors: matchMedia('(forced-colors: active)').matches, desktop: !!desktop, browser: browserOf(navigator.userAgent),
      });
    };
    const schedule = () => { clearTimeout(t); t = setTimeout(check, BLANK_CHECK_MS); };
    schedule();
    // something outside React (a page translator, an extension) can empty the block long after it was drawn
    const watch = new MutationObserver(schedule);
    watch.observe(pre, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => { clearTimeout(t); watch.disconnect(); };
  }, [guarded, shown, shownLines, l, lineNumbers, wrap, fix, streaming, lang, lines.length, text.length]);
  return (
    <div className={clsx('code', wrap && 'wrap', className)}>
      <div className="code-head">
        <span className="code-lang" title={title}>{label}</span>
        <span className="code-meta">{lines.length} 行{text.length > 2000 ? ` · ${(text.length / 1024).toFixed(1)} KB` : ''}</span>
        <span className="grow" />
        {!isMermaid && <button className={clsx('code-btn', wrap && 'on')} title="自动换行" onClick={() => setWrap(!wrap)} aria-label="自动换行" aria-pressed={wrap}><Icon name="refresh" size={14} /></button>}
        {/* the icon turns into a check for a moment (keyed: the check is a new node, so it pops in) */}
        <button className={clsx('code-btn', ok && 'ok')} title={ok ? '已复制' : '复制'} aria-label={ok ? '已复制' : '复制'} onClick={() => copy(text)}><Icon key={ok ? 'ok' : 'copy'} name={ok ? 'check' : 'copy'} size={14} className={ok ? 'pop' : undefined} /></button>
      </div>
      {isMermaid && !streaming ? (
        <Suspense fallback={<pre className="code-body">{text}</pre>}>
          <MermaidBlock source={text} />
        </Suspense>
      ) : (
        <pre className="code-body" key={fix} ref={preRef}>
          {fix === 2 ? (
            <code className="code-plain">{shown}</code>
          ) : lineNumbers ? (
            <table className="code-table">
              <tbody>
                {shown.split('\n').map((ln, i) => (
                  <tr key={i}>
                    <td className="ln">{startLine + i}</td>
                    <td className="lc">{highlight(ln, l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <code className={l ? `language-${l}` : undefined}>{body}</code>
          )}
        </pre>
      )}
      {(truncated || footer) && (
        <div className="code-foot">
          {truncated && <button className="link" onClick={() => setAll(true)}>全部显示（{text.length} 字符，{lines.length} 行）</button>}
          {footer}
        </div>
      )}
    </div>
  );
});
