import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { clsx } from '@/util';
import { segIndex, segStep, segVars } from './seg-math';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  /** `data-*` attributes for this option's button (hooks for tests and stylesheets) */
  data?: Record<`data-${string}`, string>;
}

/**
 * A segmented control (UI refresh §6): a pill-shaped track, one equal-width button per option and a shadowed thumb
 * that slides under the chosen one (transform, 260ms — styles/floating.css `.segmented`; `seg-math.ts` has the
 * arithmetic). A radio group: `role="radiogroup"`, each option `role="radio"` with `aria-checked`.
 *
 * `value` not among the options (nothing chosen yet) shows no thumb. A click always reports the option, the chosen
 * one too — the owner decides whether that means anything.
 *
 * `arrows`: ← → ↑ ↓ Home End move the choice (and the focus), and only the chosen option is a tab stop — a radio
 * group's own keyboard. Off by default: inside a menu the arrows belong to the menu's rows, and every option stays a
 * tab stop.
 */
export function Segmented<T extends string>({ options, value, onChange, label, className, disabled, arrows }: {
  options: readonly SegmentedOption<T>[];
  value: T | null | undefined;
  onChange: (value: T) => void;
  /** what the group is, for assistive tech */
  label: string;
  className?: string;
  disabled?: boolean;
  arrows?: boolean;
}) {
  const index = segIndex(options.map((o) => o.value), value);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!arrows || e.altKey || e.ctrlKey || e.metaKey) return;
    const next = segStep(index, e.key, options.map((o) => !disabled && !o.disabled));
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(options[next].value);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className={clsx('segmented', index < 0 && 'none', className)} role="radiogroup" aria-label={label} style={segVars(options.length, index) as CSSProperties} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={i === index}
          className={clsx(i === index && 'on')}
          title={o.title}
          disabled={disabled || o.disabled}
          tabIndex={arrows ? (i === Math.max(0, index) ? 0 : -1) : undefined}
          onClick={() => onChange(o.value)}
          {...o.data}
        >{o.label}</button>
      ))}
    </div>
  );
}
