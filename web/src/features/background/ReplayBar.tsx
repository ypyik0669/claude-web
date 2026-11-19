import { useRef } from 'react';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { clock } from './model';
import { REPLAY_SPEEDS, type ReplaySpeed } from './history-model';
import { tr } from '@/i18n';

/**
 * 跑过的 → 回放: play / pause, the run's time as a track you can drag (or move with the arrow keys), and the speed.
 * `compact` (a phone, the cafe's own bar): the speed is one button that goes round 10× → 60× → 120×.
 */
export function ReplayBar({ t, dur, playing, speed, onPlay, onSeek, onSpeed, compact, className }: {
  t: number;
  dur: number;
  playing: boolean;
  speed: ReplaySpeed;
  onPlay: () => void;
  onSeek: (t: number) => void;
  onSpeed: (s: ReplaySpeed) => void;
  compact?: boolean;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const pct = dur > 0 ? Math.max(0, Math.min(100, (t / dur) * 100)) : 0;
  const seekAt = (x: number) => {
    const r = track.current?.getBoundingClientRect();
    if (r && r.width > 0) onSeek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur);
  };
  const next = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(speed) + 1) % REPLAY_SPEEDS.length];
  return (
    <div className={clsx('hx-replay', compact && 'compact', className)}>
      <button type="button" className="hx-play" aria-label={playing ? tr('暂停') : tr('回放')} title={playing ? tr('暂停') : tr('按原来的时间回放')} onClick={onPlay}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <div
        ref={track}
        className="hx-track"
        role="slider"
        tabIndex={0}
        aria-label={tr('回放进度')}
        aria-valuemin={0}
        aria-valuemax={Math.round(dur / 1000)}
        aria-valuenow={Math.round(t / 1000)}
        aria-valuetext={`${clock(t)} / ${clock(dur)}`}
        onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture?.(e.pointerId); seekAt(e.clientX); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) seekAt(e.clientX); }}
        onKeyDown={(e) => {
          const step = dur / 20;
          const to = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? t - step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? t + step : e.key === 'Home' ? 0 : e.key === 'End' ? dur : undefined;
          if (to === undefined) return;
          e.preventDefault();
          onSeek(Math.max(0, Math.min(dur, to)));
        }}
      >
        <i className="bar"><i className="fill" style={{ width: `${pct}%` }} /></i>
        <i className="knob" style={{ left: `${pct}%` }} />
      </div>
      <span className="hx-time">{clock(t)} / {clock(dur)}</span>
      {compact
        ? <button type="button" className="hx-speed1" title={tr('回放速度')} aria-label={tr('回放速度 {speed}×，点一下换成 {next}×', { speed, next })} onClick={() => onSpeed(next)}>{speed}×</button>
        : (
          <span className="hx-speed" role="radiogroup" aria-label={tr('回放速度')}>
            {REPLAY_SPEEDS.map((v) => <button key={v} type="button" role="radio" aria-checked={speed === v} onClick={() => onSpeed(v)}>{v}×</button>)}
          </span>
        )}
    </div>
  );
}
