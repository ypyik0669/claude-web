import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { useStore } from '@/store';
import { desktop } from '@/desktop';
import { arrive, rehypeStreamFade, type FadeState } from './stream-fade';
import { reducedMotion } from './Fold';

export { DiffView } from './DiffView';

const MATH_RE = /\$\$[\s\S]+?\$\$|\\\(|\\\[|^\s*\$[^$\n]+\$\s*$/m;
type MathPlugins = { remark: any; rehype: any } | null;
let mathCache: MathPlugins = null;
let mathPromise: Promise<MathPlugins> | null = null;
function loadMath(): Promise<MathPlugins> {
  if (mathCache) return Promise.resolve(mathCache);
  mathPromise ??= Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css' as any)]).then(([rm, rk]) => (mathCache = { remark: rm.default, rehype: rk.default }));
  return mathPromise;
}

function openLink(href: string) {
  if (desktop) void desktop.openExternal(href);
  else window.open(href, '_blank', 'noopener,noreferrer');
}

const components: Components = {
  pre({ children }) {
    // fenced code: unwrap the <pre><code class="language-x"> pair into CodeBlock
    const child: any = Array.isArray(children) ? children[0] : children;
    const props = child?.props ?? {};
    const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1];
    const code = typeof props.children === 'string' ? props.children : Array.isArray(props.children) ? props.children.join('') : '';
    return <CodeBlock code={code} lang={lang} streaming={(props as any)['data-streaming']} maxLines={400} />;
  },
  code({ className, children, ...rest }: ComponentProps<'code'>) {
    return <code className={className} {...rest}>{children}</code>;
  },
  a({ href, children }) {
    return (
      <a href={href} onClick={(e) => { if (href && /^https?:/i.test(href)) { e.preventDefault(); openLink(href); } }} title={href}>
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const s = typeof src === 'string' ? src : '';
    return <img src={s} alt={alt ?? ''} className="md-img" onClick={() => useStore.getState().openViewer([s], 0)} />;
  },
};

/**
 * `streaming`: the text is still arriving. What arrives fades in (stream-fade.ts: the new end of the last block is
 * wrapped in `<span class="w">` for the length of its fade); when the stream ends the text is plain again.
 */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const needMath = useMemo(() => MATH_RE.test(text), [text]);
  const [math, setMath] = useState<MathPlugins>(mathCache);
  useEffect(() => {
    if (needMath && !math) void loadMath().then(setMath);
  }, [needMath, math]);
  // where each delta started, and when — kept only while the text streams (the same text again changes nothing, so
  // a second render of the same props is harmless)
  const fade = useRef<FadeState | null>(null);
  const fades = !!streaming && !reducedMotion();
  fade.current = fades ? arrive(fade.current, text, performance.now()) : null;
  const remark = useMemo(() => (needMath && math ? [remarkGfm, [math.remark, { singleDollarTextMath: false }]] : [remarkGfm]), [needMath, math]);
  const rehype = useMemo(() => [...(needMath && math ? [[math.rehype, { throwOnError: false, strict: false }]] : []), ...(fades ? [[rehypeStreamFade, fade]] : [])], [needMath, math, fades]);
  return (
    <div className="md" data-streaming={streaming || undefined}>
      <ReactMarkdown remarkPlugins={remark as any} rehypePlugins={rehype as any} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
