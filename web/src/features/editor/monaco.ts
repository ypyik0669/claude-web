// Lazy-loaded Monaco bootstrap: workers wired for Vite, themes derived from the app's CSS variables.
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// keep the TS service quiet on loose project files (no tsconfig context in the editor)
const tsLang = (monaco.languages as any).typescript;
tsLang?.typescriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });
tsLang?.javascriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDarkTheme = () => {
  const bg = cssVar('--bg') || '#1f1e1b';
  const m = /^#([0-9a-f]{6})$/i.exec(bg);
  if (!m) return true;
  const v = parseInt(m[1], 16);
  const lum = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
  return lum < 128;
};

/** (Re)define the `cw` theme from the current CSS variables and apply it. Call again after a theme switch. */
export function applyTheme() {
  const dark = isDarkTheme();
  const colors: Record<string, string> = {};
  const set = (k: string, v: string) => { if (/^#[0-9a-f]{6,8}$/i.test(v)) colors[k] = v; };
  set('editor.background', cssVar('--bg'));
  set('editor.foreground', cssVar('--fg'));
  set('editorLineNumber.foreground', cssVar('--fg-3'));
  set('editorLineNumber.activeForeground', cssVar('--fg-1'));
  set('editor.lineHighlightBackground', cssVar('--bg-1'));
  set('editorGutter.background', cssVar('--bg'));
  set('editor.selectionBackground', cssVar('--bg-3'));
  set('editorIndentGuide.background1', cssVar('--line'));
  set('editorWidget.background', cssVar('--bg-1'));
  set('input.background', cssVar('--bg-2'));
  set('focusBorder', cssVar('--accent'));
  set('editorCursor.foreground', cssVar('--accent'));
  monaco.editor.defineTheme('cw', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors });
  monaco.editor.setTheme('cw');
}
applyTheme();
new MutationObserver(() => applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

export { monaco };
export type Monaco = typeof monaco;
