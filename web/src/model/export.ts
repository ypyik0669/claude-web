// Self-contained HTML export of a conversation (or one turn): clone the rendered DOM, inline our CSS, embed nothing external.
import cssText from '../styles.css?raw';

export interface ExportOptions {
  title: string;
  /** root element to clone (the .chat-inner, or a wrapper around one turn's nodes) */
  root: HTMLElement;
  theme?: string;
  meta?: string;
}

const EXTRA = `
  body { overflow: auto !important; padding: 24px 0; }
  .export-wrap { max-width: 900px; margin: 0 auto; padding: 0 20px; }
  .export-head { border-bottom: 1px solid var(--line); margin-bottom: 20px; padding-bottom: 10px; }
  .export-head h1 { font-size: 20px; margin: 0 0 4px; }
  .export-head .meta { color: var(--fg-2); font-size: 12px; }
  .hover-actions, .msg-actions, .icon-btn, .code-btn, .jt-copy, .tool-head .icon-btn, .expand-row, .find-bar, .perm { display: none !important; }
  .code-body, .diff-lines, .diff-grid, .jt, .kv-pre, .thinking-body, .tool-body pre { max-height: none !important; }
  .msg.user .bubble { max-width: 100%; }
  .step-body, .tool-body { display: block !important; }
  a { color: var(--accent); }
`;

export function buildHtml(o: ExportOptions): string {
  const clone = o.root.cloneNode(true) as HTMLElement;
  // drop interactive leftovers and force collapsed content open
  clone.querySelectorAll('button.link, .hover-actions, .msg-actions, .find-bar').forEach((n) => n.remove());
  clone.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
  clone.querySelectorAll('textarea, input').forEach((n) => n.remove());
  const theme = o.theme ?? document.documentElement.dataset.theme ?? 'dark';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>${cssText}\n${EXTRA}</style>
</head>
<body>
<div class="export-wrap">
  <div class="export-head"><h1>${esc(o.title)}</h1><div class="meta">${esc(o.meta ?? '')} · 由 Claude Web 导出 ${new Date().toLocaleString()}</div></div>
  <div class="chat-inner">${clone.innerHTML}</div>
</div>
</body>
</html>`;
}

export function downloadHtml(name: string, html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'conversation'}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
