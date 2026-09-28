import type { ReactNode } from 'react';

/**
 * The composer's one row under the text box (spec §5.4): `+` · project · branch on the left, model · permission ·
 * mic · send on the right. Never wraps: it is a size container, and below ~560 / 420px (a split pane, a phone) the
 * chips drop their text (`.opt`) and keep their icons; the model chip truncates last. The welcome page and a
 * conversation use the same row; which slots are filled is the caller's business.
 */
export function ComposerBar({ plus, project, branch, status, meter, model, permission, mic, steer, send }: {
  plus?: ReactNode;
  project?: ReactNode;
  branch?: ReactNode;
  /** a conversation that is not running: 「未运行 · 发送即恢复」 in place of the chips */
  status?: ReactNode;
  meter?: ReactNode;
  model?: ReactNode;
  permission?: ReactNode;
  mic?: ReactNode;
  steer?: ReactNode;
  send: ReactNode;
}) {
  return (
    <div className="composer-bar cb">
      <div className="cb-left">{plus}{project}{branch}</div>
      <span className="grow" />
      <div className="cb-right">{status}{meter}{model}{permission}{mic}{steer}{send}</div>
    </div>
  );
}
