import { useState } from 'react';
import type { ToolUseBlock } from '@/model/conversation';
import { useStore } from '@/store';
import { CodeBlock } from '../CodeBlock';
import { Expandable } from '../Expandable';
import { Markdown } from '../Markdown';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';

export function ErrorPre({ text }: { text: string }) {
  return <CodeBlock code={text || '(no error text)'} lang="plaintext" title="错误" wrap className="err" maxLines={40} />;
}

export function ImageGrid({ images }: { images: string[] }) {
  const open = useStore((s) => s.openViewer);
  return (
    <div className="img-grid">
      {images.map((src, i) => <img key={i} src={src} alt="" onClick={() => open(images, i)} />)}
    </div>
  );
}

/** Collapsible JSON tree with copy-path. */
export function JsonTree({ value, name, depth = 0, path = '$' }: { value: unknown; name?: string; depth?: number; path?: string }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const entries = isObj ? (Array.isArray(value) ? value.map((v, i) => [String(i), v] as [string, unknown]) : Object.entries(value as object)) : [];
  const copy = (e: React.MouseEvent) => { e.stopPropagation(); void navigator.clipboard.writeText(path); };
  if (!isObj) {
    return (
      <div className="jt-row" style={{ paddingLeft: depth * 14 }}>
        {name !== undefined && <span className="jt-key">{name}: </span>}
        <span className={clsx('jt-val', typeof value)}>{typeof value === 'string' ? (value.length > 300 ? JSON.stringify(value.slice(0, 300)) + '…' : JSON.stringify(value)) : String(value)}</span>
      </div>
    );
  }
  const label = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div>
      <div className="jt-row jt-node" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="chev"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /></span>
        {name !== undefined && <span className="jt-key">{name}: </span>}
        <span className="jt-meta">{label}</span>
        <button className="jt-copy" title={`复制路径 ${path}`} onClick={copy} aria-label="复制路径"><Icon name="copy" size={11} /></button>
      </div>
      {open && entries.slice(0, 500).map(([k, v]) => <JsonTree key={k} name={k} value={v} depth={depth + 1} path={Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`} />)}
      {open && entries.length > 500 && <div className="jt-row" style={{ paddingLeft: (depth + 1) * 14, color: 'var(--fg-3)' }}>… 还有 {entries.length - 500} 项</div>}
    </div>
  );
}

function tryJson(s: string): unknown | undefined {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

const looksMarkdown = (s: string) => /^#{1,6}\s|\n#{1,6}\s|\*\*[^*]+\*\*|^\s*[-*]\s+\S|\n\s*[-*]\s+\S|\[[^\]]+\]\([^)]+\)|```/.test(s);

/** Generic input grid + smart output rendering; used for MCP tools and anything without a dedicated card. */
export function GenericBody({ t }: { t: ToolUseBlock }) {
  const r = t.result;
  const entries = Object.entries(t.input ?? {});
  return (
    <>
      {entries.length > 0 && (
        <div className="kv-grid">
          {entries.map(([k, v]) => (
            <div key={k} className="kv-row">
              <div className="kv-k" title={k}>{k}</div>
              <div className="kv-v">
                {typeof v === 'string' ? (
                  v.length > 200 || v.includes('\n') ? <Expandable text={v} lines={12} chars={1500}>{(x) => <pre className="kv-pre">{x}</pre>}</Expandable> : <span>{v}</span>
                ) : v !== null && typeof v === 'object' ? (
                  <JsonTree value={v} />
                ) : (
                  <span className={clsx('jt-val', typeof v)}>{String(v)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {t.progress?.summary && <div className="tool-meta">{t.progress.summary}</div>}
      {r && <ToolOutput r={r} />}
    </>
  );
}

export function ToolOutput({ r }: { r: NonNullable<ToolUseBlock['result']> }) {
  const json = !r.isError ? tryJson(r.content) : undefined;
  return (
    <>
      {r.images?.length ? <ImageGrid images={r.images} /> : null}
      {r.isError ? (
        <ErrorPre text={r.content} />
      ) : json !== undefined ? (
        <div className="jt"><JsonTree value={json} /></div>
      ) : r.content.trim() ? (
        looksMarkdown(r.content) ? (
          <Expandable text={r.content} lines={30} chars={6000}>{(v) => <div className="tool-md"><Markdown text={v} /></div>}</Expandable>
        ) : (
          <Expandable text={r.content} lines={30} chars={6000}>{(v) => <CodeBlock code={v} lang="plaintext" title="输出" wrap />}</Expandable>
        )
      ) : !r.images?.length ? (
        <div className="tool-meta">（无输出）</div>
      ) : null}
      {r.structured !== undefined && r.structured !== null && typeof r.structured === 'object' && (
        <details className="structured">
          <summary>结构化输出</summary>
          <div className="jt"><JsonTree value={r.structured} /></div>
        </details>
      )}
    </>
  );
}
