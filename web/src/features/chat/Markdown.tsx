import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

/** Render a unified diff / old-new pair with add/del highlighting. */
export function DiffView({ oldText, newText, unified }: { oldText?: string; newText?: string; unified?: string }) {
  if (unified) {
    return (
      <div className="diff">
        {unified.split('\n').map((l, i) => (
          <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'}>
            {l || ' '}
          </span>
        ))}
      </div>
    );
  }
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  const rows = lcsDiff(a, b);
  return (
    <div className="diff">
      {rows.map((r, i) => (
        <span key={i} className={r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx'}>
          {r.t} {r.s || ' '}
        </span>
      ))}
    </div>
  );
}

function lcsDiff(a: string[], b: string[]): { t: ' ' | '+' | '-'; s: string }[] {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: a[i++] });
    else out.push({ t: '+', s: b[j++] });
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}
