// 值班 Bot 头像: an inline SVG face (avatar-model.ts) — the shape in its agent colour, two eyes, and while working three
// dots. The state lives on data-state (styles/bots.css animates it; ui-smoke reads it): idle blinks slowly, working
// glances left / right, attention gets an amber ring, error goes gray. prefers-reduced-motion keeps it still.
import { useMemo } from 'react';
import { avatarOf, COLORS, SHAPES } from './avatar-model';

export type BotAvatarState = 'idle' | 'working' | 'attention' | 'error';

export function BotAvatar({ name, avatar, size = 32, state = 'idle' }: {
  name: string;
  avatar?: string;
  size?: number;
  state?: BotAvatarState;
}) {
  const face = useMemo(() => avatarOf(name, avatar), [name, avatar]);
  // the seed nudges the eyes a little so two bots with the same shape and colour still look different
  const gap = 3.5 + (face.seed % 3);
  const eyeY = 14 + ((face.seed >> 2) % 3);
  const eyeR = 1.8 + ((face.seed >> 4) % 2) * 0.5;
  return (
    <svg
      className="bot-face"
      data-state={state}
      width={size}
      height={size}
      viewBox="-2 -2 36 36"
      aria-hidden="true"
      focusable="false"
      style={{ color: COLORS[face.color] }}
    >
      {state === 'attention' && <circle className="bot-face-ring" cx="16" cy="16" r="17" />}
      <path className="bot-face-body" d={SHAPES[face.shape]} />
      <g className="bot-face-eyes">
        <ellipse cx={16 - gap} cy={eyeY} rx={eyeR} ry={eyeR * 1.25} />
        <ellipse cx={16 + gap} cy={eyeY} rx={eyeR} ry={eyeR * 1.25} />
      </g>
      {state === 'working' && (
        <g className="bot-face-dots">
          <circle cx="12" cy="22" r="1.4" />
          <circle cx="16" cy="22" r="1.4" />
          <circle cx="20" cy="22" r="1.4" />
        </g>
      )}
    </svg>
  );
}
