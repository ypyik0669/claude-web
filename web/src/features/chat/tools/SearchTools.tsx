import { useMemo } from 'react';
import type { ToolUseBlock } from '@/model/conversation';
import { Expandable } from '../Expandable';
import { FileLink } from './FileTools';
import { ErrorPre } from './McpTool';

export function GlobBody({ t }: { t: ToolUseBlock }) {
  const r = t.result;
  const st = r?.structured as any;
  if (!r) return <div className="tool-meta">搜索中…</div>;
  if (r.isError) return <ErrorPre text={r.content} />;
  const files: string[] = Array.isArray(st?.filenames) ? st.filenames : r.content.split('\n').filter((l) => l && !/^No files found/.test(l));
  return (
    <>
      <div className="tool-meta">{st?.numFiles ?? files.length} 个文件{st?.truncated ? `（已截断${st.totalMatches ? `，共 ${st.totalMatches}${st.countIsComplete === false ? '+' : ''}` : ''}）` : ''}{st?.durationMs ? ` · ${st.durationMs}ms` : ''}</div>
      {files.length ? (
        <Expandable text={files.join('\n')} lines={40} chars={20000}>
          {(v) => <div className="file-list">{v.split('\n').map((f, i) => <FileLink key={i} path={f} />)}</div>}
        </Expandable>
      ) : (
        <div className="tool-meta">没有匹配的文件</div>
      )}
    </>
  );
}

interface GrepLine { file?: string; line?: number; text: string }

/** Parse ripgrep-style "path:line:text" (or "path-line-text" context lines) into rows. */
function parseGrep(content: string): GrepLine[] {
  const out: GrepLine[] = [];
  for (const raw of content.split('\n')) {
    if (!raw) continue;
    const m = /^(.*?):(\d+)[:-](.*)$/.exec(raw) ?? /^([A-Za-z]:[^:]*?):(\d+)[:-](.*)$/.exec(raw);
    if (m) out.push({ file: m[1], line: Number(m[2]), text: m[3] });
    else out.push({ text: raw });
  }
  return out;
}

export function GrepBody({ t }: { t: ToolUseBlock }) {
  const r = t.result;
  const st = r?.structured as any;
  const inp = t.input as any;
  const rows = useMemo(() => (r && !r.isError && (st?.mode ?? inp.output_mode ?? 'files_with_matches') === 'content' ? parseGrep(st?.content ?? r.content) : []), [r, st, inp.output_mode]);
  if (!r) return <div className="tool-meta">搜索中…</div>;
  if (r.isError) return <ErrorPre text={r.content} />;
  const mode = st?.mode ?? inp.output_mode ?? 'files_with_matches';
  const meta = (
    <div className="tool-meta">
      {mode === 'content' ? `${st?.numMatches ?? st?.numLines ?? rows.length} 处匹配` : `${st?.numFiles ?? 0} 个文件`}
      {st?.totalFiles && st.totalFiles !== st.numFiles ? ` / 共 ${st.totalFiles} 个文件` : ''}
      {st?.appliedLimit ? ` · limit ${st.appliedLimit}` : ''}
    </div>
  );
  if (mode === 'content') {
    // group by file
    const groups: { file: string; lines: GrepLine[] }[] = [];
    for (const row of rows) {
      const f = row.file ?? '';
      const g = groups[groups.length - 1];
      if (g && g.file === f) g.lines.push(row);
      else groups.push({ file: f, lines: [row] });
    }
    const text = rows.map((x) => `${x.file ?? ''}:${x.line ?? ''}:${x.text}`).join('\n');
    return (
      <>
        {meta}
        <Expandable text={text} lines={60} chars={30000}>
          {(v) => {
            const n = v.split('\n').length;
            let left = n;
            return (
              <div className="grep">
                {groups.map((g, gi) => {
                  if (left <= 0) return null;
                  const take = g.lines.slice(0, left);
                  left -= take.length;
                  return (
                    <div key={gi} className="grep-file">
                      {g.file && <div className="grep-path"><FileLink path={g.file} /></div>}
                      {take.map((l, i) => (
                        <div key={i} className="grep-line">
                          {l.line !== undefined && <FileLink path={g.file} line={l.line}><span className="ln">{l.line}</span></FileLink>}
                          <span className="tx">{highlightMatch(l.text, inp.pattern, !!inp['-i'])}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          }}
        </Expandable>
      </>
    );
  }
  if (mode === 'count') {
    const lines = r.content.split('\n').filter(Boolean);
    return (
      <>
        {meta}
        <table className="mini-table"><tbody>{lines.map((l, i) => { const m = /^(.*):(\d+)$/.exec(l); return <tr key={i}><td>{m ? <FileLink path={m[1]} /> : l}</td><td className="num">{m?.[2] ?? ''}</td></tr>; })}</tbody></table>
      </>
    );
  }
  const files: string[] = Array.isArray(st?.filenames) && st.filenames.length ? st.filenames : r.content.split('\n').filter((l) => l && !/^No (files|matches)/.test(l));
  return (
    <>
      {meta}
      {files.length ? <Expandable text={files.join('\n')} lines={40} chars={20000}>{(v) => <div className="file-list">{v.split('\n').map((f, i) => <FileLink key={i} path={f} />)}</div>}</Expandable> : <div className="tool-meta">没有匹配</div>}
    </>
  );
}

function highlightMatch(text: string, pattern: unknown, ci: boolean) {
  if (typeof pattern !== 'string' || !pattern) return text;
  let re: RegExp;
  try { re = new RegExp(pattern, ci ? 'gi' : 'g'); } catch { return text; }
  const parts: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, guard = 0;
  while ((m = re.exec(text)) && guard++ < 50) {
    if (m[0] === '') { re.lastIndex++; continue; }
    parts.push(text.slice(last, m.index), <mark key={m.index} className="hit">{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}
