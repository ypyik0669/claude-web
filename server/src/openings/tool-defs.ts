// The opening-pack tools of the `web` MCP server (界面改版方案 第 7 版 #opening「让 Claude 做一个」): names and schemas
// only — web/mcp.ts lists them, openings/tools.ts answers them. No imports (but the import-free mcp/always-load.ts):
// the MCP process loads this.
import { ALWAYS_LOAD } from '../mcp/always-load.js';

export const OPENING_TOOLS = [
  {
    name: 'opening_guide',
    title: 'How to make an opening',
    description: 'The opening-pack skill: what a web opening pack is (one self-contained index.html that plays for a few seconds in a sandboxed frame without network when the Claude Web desktop app opens, then calls cwOpening.done() and the app lights up its logo), its limits, how to end it, the flow (draft → watch the trial run → refine → save → apply), and a complete example to start from. Read it before making an opening.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'How to make an opening', readOnlyHint: true },
  },
  {
    name: 'opening_draft',
    title: 'Draft an opening',
    description: 'Keep a web opening pack as a draft (the same id replaces the previous draft) and play it once over the user\'s Claude Web window, the way it plays when the app opens. Answers with how it went — when it called cwOpening.done() (or that it was cut at its time limit), the errors it threw, its frame times — and pictures of its largest canvas during the run. Look at them and fix what is off before saving.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the opening is called (shown on its card in Settings → Appearance).' },
        html: { type: 'string', description: 'The whole index.html: everything inside it (images, fonts as data: URIs), no network.' },
        id: { type: 'string', description: 'The draft\'s id, to change a draft made before (the id opening_draft answered with). Leave out for a new one.' },
        author: { type: 'string', description: 'Who made it (shown before installing and on the card).' },
        license: { type: 'string', description: 'Its licence, e.g. MIT.' },
        maxSeconds: { type: 'number', description: 'At most this long before it is cut (default and limit 12).' },
      },
      required: ['name', 'html'],
    },
    annotations: { title: 'Draft an opening', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    // answers with pictures (the trial run): not deferred on our engine
    _meta: ALWAYS_LOAD,
  },
  {
    name: 'opening_get',
    title: 'Read an opening',
    description: 'A web opening pack\'s opening.json and index.html (a draft, or one of the user\'s saved web packs), to change it: draft the edited copy under the same id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { title: 'Read an opening', readOnlyHint: true },
  },
  {
    name: 'opening_save',
    title: 'Save an opening',
    description: 'Turn a draft into a saved opening pack (by its id), once the user is happy with it. It then shows up as a card in Settings → Appearance → Opening and background.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { title: 'Save an opening', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'opening_apply',
    title: 'Use an opening',
    description: 'Make an opening the one the desktop app plays (a saved pack by its id, or a built-in one: claude-web-chan, ignite, stars, ascii, cafe). Changes the user\'s setting: they are asked.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { title: 'Use an opening', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'opening_list',
    title: 'List openings',
    description: 'Every opening: the built-in ones, the user\'s packs (video or web) and the drafts, and which one is in use.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List openings', readOnlyHint: true },
  },
  {
    name: 'opening_delete',
    title: 'Delete an opening',
    description: 'Delete one of the user\'s opening packs (and its draft) by id. The built-in ones cannot be deleted.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { title: 'Delete an opening', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
] as const;

export const OPENING_TOOL_NAMES: ReadonlySet<string> = new Set(OPENING_TOOLS.map((t) => t.name));
