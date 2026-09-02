import { useMemo, useState, type ReactNode } from 'react';

/** Clamp long text; renders `children(visibleText, truncated)` and a "show all" toggle. */
export function Expandable({ text, lines = 30, chars = 4000, children, openByDefault }: { text: string; lines?: number; chars?: number; openByDefault?: boolean; children: (visible: string, truncated: boolean) => ReactNode }) {
  const [all, setAll] = useState(!!openByDefault);
  const { visible, truncated, lineCount } = useMemo(() => {
    const ls = text.split('\n');
    const over = ls.length > lines || text.length > chars;
    if (!over || all) return { visible: text, truncated: false, lineCount: ls.length };
    let v = ls.slice(0, lines).join('\n');
    if (v.length > chars) v = v.slice(0, chars);
    return { visible: v, truncated: true, lineCount: ls.length };
  }, [text, lines, chars, all]);
  return (
    <>
      {children(visible, truncated)}
      {(truncated || (all && (lineCount > lines || text.length > chars))) && (
        <div className="expand-row">
          <button className="link" onClick={() => setAll(!all)}>{all ? '收起' : `全部显示（${text.length.toLocaleString()} 字符，${lineCount} 行）`}</button>
        </div>
      )}
    </>
  );
}
