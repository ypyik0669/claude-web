import { useEffect, useState } from 'react';
import { desktop } from '@/desktop';
import { tr } from '@/i18n';

/** Windows / Linux: minimise / maximise / close, drawn by the page — compact, with a small rounded hover —
 *  over the window's top-right corner, vertically centred in the row under them (`height`, the page's pixels). */
export function WindowControls({ height }: { height: number }) {
  const d = desktop;
  const [max, setMax] = useState(() => !!d?.isMaximized?.());
  useEffect(() => d?.onMaximized?.((m) => setMax(!!m)), [d]);
  if (!d?.windowControl) return null;
  const act = (a: 'min' | 'max' | 'close') => () => d.windowControl?.(a);
  return (
    <div className="win-ctl" style={{ height }} onDoubleClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={tr('最小化')} title={tr('最小化')} onClick={act('min')}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5.5h8" /></svg>
      </button>
      <button type="button" aria-label={max ? tr('还原') : tr('最大化')} title={max ? tr('还原') : tr('最大化')} onClick={act('max')}>
        {max
          ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5h4.5a1 1 0 0 1 1 1V7" /><rect x="1.5" y="3" width="5.5" height="5.5" rx="1" /></svg>
          : <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1.2" /></svg>}
      </button>
      <button type="button" className="close" aria-label={tr('关闭窗口')} title={tr('关闭窗口')} onClick={act('close')}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" /></svg>
      </button>
    </div>
  );
}
