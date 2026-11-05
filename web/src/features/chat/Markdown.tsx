import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock, type CodeRunContext } from './CodeBlock';
import { useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { followLink, routeLink } from './link-route';
import { arrive, rehypeStreamFade, settledCuts, type FadeState } from './stream-fade';
import { reducedMotion } from './Fold';
import { localImagePath } from './local-image';
import { fileUrl } from '@/features/editor/preview';

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

/** Only the conversation's own view provides this; a code block elsewhere gets no 运行 button. */
const CodeRunCtx = createContext<CodeRunContext | undefined>(undefined);

/**
 * react-markdown's default blanks every href that is not http(s) / mailto / … — `file:///…`, `C:/…` (read as scheme
 * `C`), `C:\…` (→ `C:%5C…`), `tel:` — and a blank link opens nothing (2026-10-24 review I1). Those hrefs pass through;
 * routeLink is what decides (and refuses) where a link goes. `src` and everything else keep the default.
 */
const urlTransform: UrlTransform = (url, key) => (key === 'href' && /^(file:|tel:|[a-zA-Z]:)/i.test(url) ? url : key === 'src' && localImagePath(url) ? url : defaultUrlTransform(url));

type LinkMouse = { button: number; ctrlKey?: boolean; metaKey?: boolean; preventDefault(): void };

/**
 * A click — and a middle click, which the browser / Electron would otherwise open as a new window on the href
 * resolved against the app's own address (2026-10-24 review I2) — goes where routeLink says. A page opens in the
 * built-in browser; with Ctrl / Cmd held, in the system's. A plain click on an in-page `#anchor` is the page's own
 * (it scrolls); a middle click on one would open the app page again in a second window (stage B): it does nothing.
 */
export function linkHandlers(href: string | undefined, cwd: string | undefined, sid: string | null) {
  const go = (e: LinkMouse, aux: boolean) => {
    const r = routeLink(href ?? '', cwd);
    if (r.to === 'anchor') { if (aux) e.preventDefault(); return; }
    e.preventDefault();
    followLink(r, sid ?? useStore.getState().activeId, { external: !!(e.ctrlKey || e.metaKey) });
  };
  return { onClick: (e: LinkMouse) => go(e, false), onAuxClick: (e: LinkMouse) => { if (e.button === 1) go(e, true); } };
}

const components: Components = {
  pre({ children }) {
    // fenced code: unwrap the <pre><code class="language-x"> pair into CodeBlock
    const child: any = Array.isArray(children) ? children[0] : children;
    const props = child?.props ?? {};
    const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1];
    const code = typeof props.children === 'string' ? props.children : Array.isArray(props.children) ? props.children.join('') : '';
    const run = useContext(CodeRunCtx);
    return <CodeBlock code={code} lang={lang} streaming={(props as any)['data-streaming']} maxLines={400} run={run} />;
  },
  code({ className, children, ...rest }: ComponentProps<'code'>) {
    return <code className={className} {...rest}>{children}</code>;
  },
  a({ href, children }) {
    const ctx = usePaneCtx();
    const sid = ctx?.sessionId ?? null;
    const cwd = useStore((s) => (sid ? s.open[sid]?.cwd : undefined));
    return (
      <a href={href} title={href} {...linkHandlers(href, cwd, sid)}>
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const raw = typeof src === 'string' ? src : '';
    // a path on this computer: through the server's raw-file endpoint (local-image.ts)
    const local = localImagePath(raw);
    const s = local ? fileUrl(local) : raw;
    return <img src={s} alt={alt ?? ''} title={local ?? undefined} className="md-img" onClick={() => useStore.getState().openViewer([s], 0)} />;
  },
};

/**
 * `streaming`: the text is still arriving. What arrives fades in (stream-fade.ts: the new end of the last block is
 * wrapped in `<span class="w">` for the length of its fade); when the stream ends the text is plain again, parsed
 * whole. While a long one streams, the blocks that stopped changing are parsed once each (memo) and only the last
 * one again per frame: a long thinking parsed whole for every frame was most of a frame (2026-10-19, DeepSeek).
 */
export const Markdown = memo(function Markdown({ text, streaming, run }: { text: string; streaming?: boolean; run?: CodeRunContext }) {
  const cuts = streaming && text.length > 2000 ? settledCuts(text) : [];
  return (
    <div className="md" data-streaming={streaming || undefined}>
      <CodeRunCtx.Provider value={run}>
        {cuts.length
          ? [0, ...cuts].map((at, i) => <MarkdownBody key={i} text={text.slice(at, cuts[i] ?? text.length)} streaming={i === cuts.length} />)
          : <MarkdownBody text={text} streaming={streaming} />}
      </CodeRunCtx.Provider>
    </div>
  );
});

const MarkdownBody = memo(function MarkdownBody({ text, streaming }: { text: string; streaming?: boolean }) {
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
    <ReactMarkdown remarkPlugins={remark as any} rehypePlugins={rehype as any} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});
