import { lazy, memo, Suspense, useMemo, useState } from 'react';
import { clsx } from '@/util';
import { highlight, normalizeLang } from './highlight';

const MermaidBlock = lazy(() => import('./MermaidBlock'));

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

function useCopy() {
  const [ok, setOk] = useState(false);
  return {
    ok,
    copy(text: string) {
      void navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); });
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
  return (
    <div className={clsx('code', wrap && 'wrap', className)}>
      <div className="code-head">
        <span className="code-lang" title={title}>{label}</span>
        <span className="code-meta">{lines.length} 行{text.length > 2000 ? ` · ${(text.length / 1024).toFixed(1)} KB` : ''}</span>
        <span className="grow" />
        {!isMermaid && <button className={clsx('code-btn', wrap && 'on')} title="自动换行" onClick={() => setWrap(!wrap)}>↩</button>}
        <button className="code-btn" title="复制" onClick={() => copy(text)}>{ok ? '✓ 已复制' : '⧉ 复制'}</button>
      </div>
      {isMermaid && !streaming ? (
        <Suspense fallback={<pre className="code-body">{text}</pre>}>
          <MermaidBlock source={text} />
        </Suspense>
      ) : (
        <pre className="code-body">
          {lineNumbers ? (
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
