// The composer's one round button and the light around the box: which state they are in. Pure; Composer.tsx renders
// them, styles/composer.css draws each state (`.send[data-state]`, `.composer-glow`).

/**
 * `empty` nothing to send (the faint circle) · `ready` something to send (ink, the arrow) · `working` starting a
 * conversation or uploading (a spinner, not clickable) · `running` a turn is in flight: the same circle is the stop
 * square.
 */
export type SendFace = 'empty' | 'ready' | 'working' | 'running';

export function sendFace(s: { busy: boolean; canSend: boolean; working: boolean }): SendFace {
  if (s.busy) return 'running';
  if (s.working) return 'working';
  return s.canSend ? 'ready' : 'empty';
}

/**
 * The light travelling around the composer's edge (spec §4.5: a looping animation plays only where the conversation
 * is in view and really running): not while it waits for an answer to a permission card, not while its process is
 * still starting, not behind another tab.
 */
export function glowing(s: { welcome: boolean; state: string | undefined; visible: boolean }): boolean {
  return !s.welcome && s.visible && s.state === 'running';
}
