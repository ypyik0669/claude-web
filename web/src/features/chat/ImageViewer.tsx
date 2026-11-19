import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { Viewer } from '@/ui/Viewer';
import { tr } from '@/i18n';

/**
 * Full-screen image viewer: fit / 1:1 / wheel zoom / drag pan / copy / download / thumbnails. The frame (the dark layer,
 * the bar and its close button, Esc, the focus, the back gesture) is ui/Viewer — the same one a node graph opens in.
 */
export function ImageViewer() {
  const v = useStore((s) => s.viewer);
  const close = () => useStore.setState({ viewer: null });
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const toast = useStore((s) => s.toast);
  const src = v ? v.images[v.index] : '';

  useEffect(() => { setScale(1); setFit(true); setPos({ x: 0, y: 0 }); }, [src]);
  if (!v) return null;

  const zoom = (f: number) => { setFit(false); setScale((s) => Math.min(16, Math.max(0.1, s * f))); };
  // (Esc is the frame's: it closes the viewer and nothing else)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') useStore.setState({ viewer: { ...v, index: (v.index + 1) % v.images.length } });
    else if (e.key === 'ArrowLeft') useStore.setState({ viewer: { ...v, index: (v.index - 1 + v.images.length) % v.images.length } });
    else if (e.key === '0') { setFit(true); setScale(1); setPos({ x: 0, y: 0 }); }
    else if (e.key === '1') { setFit(false); setScale(1); setPos({ x: 0, y: 0 }); }
    else if (e.key === '+' || e.key === '=') zoom(1.25);
    else if (e.key === '-') zoom(0.8);
  };
  const onWheel = (e: React.WheelEvent) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); };
  const onDown = (e: React.MouseEvent) => { drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; };
  const onMove = (e: React.MouseEvent) => { const d = drag.current; if (!d) return; setPos({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }); };
  const onUp = () => { drag.current = null; };
  const copy = async () => {
    try {
      const blob = await (await fetch(src)).blob();
      const png = blob.type === 'image/png' ? blob : await toPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast(tr('已复制图片'), true);
    } catch (e: any) { toast(tr('复制失败：{message}', { message: e.message })); }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = src;
    a.download = `image-${v.index + 1}.${(/data:image\/(\w+)/.exec(src)?.[1] ?? 'png').replace('jpeg', 'jpg')}`;
    a.click();
  };
  const bar = (
    <>
      <span>{v.index + 1} / {v.images.length}</span>
      <span className="grow" />
      <button className="btn sm ghost" onClick={() => zoom(0.8)} aria-label={tr('缩小')}>−</button>
      <span style={{ minWidth: 48, textAlign: 'center' }}>{fit ? tr('适配') : `${Math.round(scale * 100)}%`}</span>
      <button className="btn sm ghost" onClick={() => zoom(1.25)} aria-label={tr('放大')}><Icon name="plus" size={13} /></button>
      <button className={clsx('btn sm ghost', fit && 'active')} onClick={() => { setFit(true); setScale(1); setPos({ x: 0, y: 0 }); }} title={tr('适配窗口 (0)')}>{tr('适配')}</button>
      <button className={clsx('btn sm ghost', !fit && scale === 1 && 'active')} onClick={() => { setFit(false); setScale(1); setPos({ x: 0, y: 0 }); }} title={tr('原始大小 (1)')}>1:1</button>
      <button className="btn sm ghost" onClick={copy}>{tr('复制图片')}</button>
      <button className="btn sm ghost" onClick={download}>{tr('下载')}</button>
    </>
  );
  return (
    <Viewer label={tr('图片查看')} onClose={close} bar={bar} onKeyDown={onKey}>
      <div className="viewer-stage" onWheel={onWheel} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); close(); } else onDown(e); }} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
        <img
          src={src}
          alt=""
          draggable={false}
          onDoubleClick={() => (fit ? (setFit(false), setScale(2)) : (setFit(true), setScale(1), setPos({ x: 0, y: 0 })))}
          style={fit ? { maxWidth: '100%', maxHeight: '100%' } : { transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, maxWidth: 'none' }}
          className={clsx(!fit && 'free')}
        />
      </div>
      {v.images.length > 1 && (
        <div className="viewer-thumbs">
          {v.images.map((s, i) => <img key={i} src={s} alt="" className={clsx(i === v.index && 'on')} onClick={() => useStore.setState({ viewer: { ...v, index: i } })} />)}
        </div>
      )}
    </Viewer>
  );
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}
