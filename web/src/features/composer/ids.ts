// The `data-id`s the composer's controls render with. The menus import these to draw their rows, and the reach
// table (reach.ts → reach.test.ts, ui-smoke through window.__cwComposerReach) checks against the same values — so
// a renamed or removed control breaks a test instead of silently dropping out of the table.

/** `+` menu rows besides the capability switches (whose ids are CAPABILITIES[].key). */
export const PLUS_ID = { files: 'files', folder: 'folder', reference: 'reference', goal: 'goal', channels: 'channels', more: 'more' } as const;

/** Model menu controls (the model rows are `.mm-row`, the other agents' sections `data-sec="agent:<kind>"`). */
export const MODEL_MENU_ID = { effort: 'effort', ultracode: 'ultracode', addProvider: 'add-provider', agents: 'agents', refresh: 'refresh', manage: 'manage' } as const;

/** Project chip menu rows (recent projects are `[data-dir]`). */
export const PROJECT_MENU_ID = { browse: 'browse', worktree: 'worktree' } as const;

/** The composer row's own buttons. */
export const BAR_ID = { mic: 'mic', steer: 'steer', send: 'send', meter: 'meter' } as const;

export const idSel = (id: string): string => `[data-id="${id}"]`;
