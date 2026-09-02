import { useEffect, useRef, useState } from 'react';

let seq = 0;
let inited: string | null = null;

async function getMermaid(theme: string) {
  const m = (await import('mermaid')).default;
  if (inited !== theme) {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'light' || theme === 'paper' ? 'default' : 'dark', fontFamily: 'inherit' });
    inited = theme;
  }
  return m;
}

/** Lazy mermaid renderer for ```mermaid fences. Only mounted once the block has finished streaming. */
export default function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    const theme = document.documentElement.dataset.theme ?? 'dark';
    getMermaid(theme)
      .then(async (m) => {
        const id = `mmd-${++seq}`;
        const { svg } = await m.render(id, source);
        if (alive && ref.current) { ref.current.innerHTML = svg; setErr(''); }
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [source]);
  return (
    <div className="mermaid-wrap">
      <div ref={ref} className="mermaid-svg" />
      {err && <pre className="code-body" style={{ color: 'var(--red)' }}>mermaid: {err}{'\n'}{source}</pre>}
    </div>
  );
}
