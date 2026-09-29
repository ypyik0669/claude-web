import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { imeComposing } from './ime';

// Promise-based replacements for window.confirm / prompt / alert, rendered in-app (Electron's native dialogs
// steal focus and look foreign; browsers may block them). One dialog at a time, queued.

export interface DialogSpec {
  kind: 'confirm' | 'prompt' | 'alert';
  title: string;
  message?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  /** a short list shown under the message (e.g. the files a destructive action touches) */
  items?: string[];
  /** a destructive confirm: 取消 has the focus, so an Enter right after the click does not go through */
  focusCancel?: boolean;
}
/** `id`: each dialog is its own element — a queued one must not reuse the buttons (and the focus) of the one before */
interface Pending { id: number; spec: DialogSpec; resolve: (v: any) => void }
let dialogSeq = 0;
interface DialogState { queue: Pending[]; push(p: Pending): void; shift(): void }
export const useDialogStore = create<DialogState>((set) => ({
  queue: [],
  push: (p) => set((s) => ({ queue: [...s.queue, p] })),
  shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

function ask<T>(spec: DialogSpec): Promise<T> {
  return new Promise<T>((resolve) => useDialogStore.getState().push({ id: ++dialogSeq, spec, resolve }));
}
export const dlg = {
  confirm: (title: string, o: Partial<DialogSpec> = {}) => ask<boolean>({ kind: 'confirm', title, okLabel: '确定', cancelLabel: '取消', ...o }),
  prompt: (title: string, defaultValue = '', o: Partial<DialogSpec> = {}) => ask<string | null>({ kind: 'prompt', title, defaultValue, okLabel: '确定', cancelLabel: '取消', ...o }),
  alert: (title: string, o: Partial<DialogSpec> = {}) => ask<void>({ kind: 'alert', title, okLabel: '好', ...o }),
};

export function DialogHost() {
  const cur = useDialogStore((s) => s.queue[0]);
  const shift = useDialogStore((s) => s.shift);
  const [value, setValue] = useState('');
  const inp = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!cur) return;
    setValue(cur.spec.defaultValue ?? '');
    setTimeout(() => { inp.current?.focus(); inp.current?.select(); }, 0);
  }, [cur]);
  if (!cur) return null;
  const { spec } = cur;
  const done = (v: any) => { cur.resolve(v); shift(); };
  const cancel = () => done(spec.kind === 'confirm' ? false : spec.kind === 'prompt' ? null : undefined);
  const ok = () => done(spec.kind === 'confirm' ? true : spec.kind === 'prompt' ? value : undefined);
  return (
    <div key={cur.id} className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && cancel()} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); cancel(); } }}>
      <div className="modal dialog" role="dialog" aria-modal="true">
        <h3>{spec.title}</h3>
        {spec.message && <div className="dialog-msg">{spec.message}</div>}
        {!!spec.items?.length && <ul className="dialog-items">{spec.items.map((it, i) => <li key={i}>{it}</li>)}</ul>}
        {spec.kind === 'prompt' && (spec.multiline ? (
          <textarea ref={inp as any} className="field" rows={4} value={value} placeholder={spec.placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !imeComposing(e.nativeEvent)) ok(); }} />
        ) : (
          <input ref={inp as any} className="field" value={value} placeholder={spec.placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) ok(); }} />
        ))}
        <div className="actions">
          {spec.kind !== 'alert' && <button className="btn" autoFocus={!!spec.focusCancel && spec.kind === 'confirm'} onClick={cancel}>{spec.cancelLabel}</button>}
          <button className={`btn ${spec.danger ? 'danger' : 'primary'}`} autoFocus={spec.kind !== 'prompt' && !(spec.focusCancel && spec.kind === 'confirm')} onClick={ok}>{spec.okLabel}</button>
        </div>
      </div>
    </div>
  );
}
