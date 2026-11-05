// The `data-id`s the composer's controls render with. The menus import these to draw their rows, and the reach
// table (reach.ts → reach.test.ts, ui-smoke through window.__cwComposerReach) checks against the same values — so
// a renamed or removed control breaks a test instead of silently dropping out of the table.

/** `+` menu rows besides the capability switches (whose ids are CAPABILITIES[].key). */
export const PLUS_ID = { files: 'files', folder: 'folder', reference: 'reference', goal: 'goal', channels: 'channels', chatOnly: 'chatOnly', slash: 'slash', connectors: 'connectors', record: 'record' } as const;

/** Model menu controls (the model rows are `.mm-row`, the other agents' sections `data-sec="agent:<kind>"`). */
export const MODEL_MENU_ID = { addProvider: 'add-provider', agents: 'agents', refresh: 'refresh', manage: 'manage', sources: 'sources', effort: 'model-effort', fast: 'model-fast', more: 'model-more', codexLogin: 'codex-login' } as const;

/** The 子代理 chip's menu (models/SubagentChip.tsx): 「跟主模型一样」 and 「这个供应商的新对话都这样」; `open`: the main model menu's row that opens it. */
export const SUBAGENT_MENU_ID = { same: 'subagent-same', default: 'subagent-default', open: 'subagent-open' } as const;

/** The menu of the chip next to the model's (models/EffortChip.tsx): the levels' group, and 深度编排's row. */
export const EFFORT_MENU_ID = { effort: 'effort', ultracode: 'ultracode' } as const;

/** Project chip menu rows (recent projects are `[data-dir]`). */
export const PROJECT_MENU_ID = { browse: 'browse', worktree: 'worktree' } as const;

/** The composer row's own buttons. */
export const BAR_ID = { mic: 'mic', steer: 'steer', send: 'send', meter: 'meter' } as const;

export const idSel = (id: string): string => `[data-id="${id}"]`;
