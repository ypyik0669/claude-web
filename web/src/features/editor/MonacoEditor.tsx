import { useEffect, useRef, useState } from 'react';
import type { Monaco } from './monaco';

let loader: Promise<Monaco> | null = null;
export const loadMonaco = () => (loader ??= import('./monaco').then((m) => m.monaco));
/** model → number of mounted editors showing it (models outlive editors and are shared between tiles) */
const liveEditors = new WeakMap<object, number>();

export interface EditorHandle { getValue(): string; setValue(v: string): void; revealLine(n: number): void; focus(): void }

/**
 * Thin Monaco wrapper: one model per path (shared between tiles showing the same file), value pushed in only when
 * `version` changes (disk reload), edits reported through `onChange`, Ctrl+S → `onSave`.
 */
export function MonacoEditor({ path, value, version, language, readOnly, line, onChange, onSave, onReady, onCursor }: {
  path: string;
  value: string;
  version: number;
  language?: string;
  readOnly?: boolean;
  line?: number;
  onChange?: (text: string) => void;
  onSave?: () => void;
  onReady?: (h: EditorHandle) => void;
  onCursor?: (line: number, col: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const editorRef = useRef<any>(null);
  const cb = useRef({ onChange, onSave, onCursor });
  cb.current = { onChange, onSave, onCursor };
  const applied = useRef(-1);

  useEffect(() => {
    let disposed = false;
    let editor: any;
    let mounted: object | undefined;
    let ro: ResizeObserver | undefined;
    loadMonaco().then((monaco) => {
      if (disposed || !ref.current) return;
      const uri = monaco.Uri.file(path.replace(/\\/g, '/'));
      let model = monaco.editor.getModel(uri);
      const shared = !!model && (liveEditors.get(model) ?? 0) > 0;
      if (!model) model = monaco.editor.createModel(value, language, uri);
      // another live tile is editing this file: its unsaved edits are in the shared model — don't
      // reset them to this tile's freshly-read disk text; report them so this tile shows them as dirty
      else if (shared) { if (model.getValue() !== value) queueMicrotask(() => cb.current.onChange?.(model!.getValue())); }
      else if (model.getValue() !== value && applied.current < 0) model.setValue(value);
      liveEditors.set(model, (liveEditors.get(model) ?? 0) + 1);
      mounted = model;
      applied.current = version;
      editor = monaco.editor.create(ref.current, {
        model,
        readOnly: !!readOnly,
        automaticLayout: false,
        fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        wordWrap: 'off',
        smoothScrolling: true,
        padding: { top: 8 },
        bracketPairColorization: { enabled: true },
        tabSize: 2,
        detectIndentation: true,
        unicodeHighlight: { ambiguousCharacters: false },
      });
      editorRef.current = editor;
      editor.onDidChangeModelContent(() => cb.current.onChange?.(model!.getValue()));
      editor.onDidChangeCursorPosition((e: any) => cb.current.onCursor?.(e.position.lineNumber, e.position.column));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cb.current.onSave?.());
      ro = new ResizeObserver(() => editor.layout());
      ro.observe(ref.current);
      editor.layout();
      if (line) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); }
      onReady?.({
        getValue: () => model!.getValue(),
        setValue: (v) => { const pos = editor.getPosition(); model!.setValue(v); if (pos) editor.setPosition(pos); },
        revealLine: (n) => { editor.revealLineInCenter(n); editor.setPosition({ lineNumber: n, column: 1 }); editor.focus(); },
        focus: () => editor.focus(),
      });
    }).catch((e) => setErr(e.message));
    return () => {
      disposed = true;
      if (mounted) { const n = (liveEditors.get(mounted) ?? 1) - 1; if (n > 0) liveEditors.set(mounted, n); else liveEditors.delete(mounted); }
      ro?.disconnect();
      editor?.dispose(); // model is kept (shared / re-opened cheaply)
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // external value change (reload from disk / discard): push into the model, keep the cursor
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || applied.current === version) return;
    applied.current = version;
    const model = ed.getModel();
    if (model && model.getValue() !== value) {
      const pos = ed.getPosition();
      model.setValue(value);
      if (pos) ed.setPosition(pos);
    }
  }, [version, value]);

  useEffect(() => { editorRef.current?.updateOptions({ readOnly: !!readOnly }); }, [readOnly]);
  useEffect(() => { if (line && editorRef.current) { editorRef.current.revealLineInCenter(line); editorRef.current.setPosition({ lineNumber: line, column: 1 }); } }, [line]);

  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>编辑器加载失败：{err}</div>;
  return <div ref={ref} className="monaco-host" />;
}
