# 值班 Bot 聊天优先（A 批）实施计划

Spec: `docs/superpowers/specs/2026-10-31-bots-chat-first-redesign.md` §7「A 批」. Phase‑1 notes: `docs/notes/duty-bots.md`.

## Global Constraints (implementers must follow)

- **The reducer is the single source of truth** (`web/src/model/conversation.ts`). Run `npm test -w web` after changing it.
- **The SDK does not echo the user's message.** The sender pushes it locally; other windows get it through `sent` / `cw_echo`. Server-added prefixes must never appear in the local echo.
- **New UI state goes in meta.json** (`settings.set`), never localStorage. Per-bot "seen" state is server data (`thread.json`).
- **Dialogs and menus:** dialogs only through `dlg.*` (`web/src/ui/dialog.tsx`). Menus through `useAnchoredMenu` / `composer/Popover` / `useDropdown`, with no ad-hoc window listeners.
- **Stable zustand selectors:** no `?? []`, `.filter()` or `({…})` inside a selector (`store/selectors.test.ts` checks this). Derive with `useMemo`.
- **IME:** a textarea's Enter / Escape asks `imeComposing()` (`web/src/ui/ime.ts`) first.
- **All visible text goes through `tr('中文')`,** with English in `en.ts`. Run `node scripts/i18n/extract.mjs --check` afterwards.
- **Wording:** say 对话, never 会话. Never show 档案 / 引擎 / 窗格 / 停靠 / effort / ultracode / ACP. Empty states use `EMPTY` from `terms.ts`. `wording.test.ts` enforces this.
- **Child processes:** `spawn` always sets `windowsHide: true`.
- **Federation:** any new request carrying a sessionId goes into `server/src/federation/rewrite.ts`. This plan adds none on purpose: all new `bots.*` requests carry a botId. The thread is opened through the existing `session.open`, which is intercepted on the server that owns it.
- **Pages, right panels and the profile column are never unmounted**, only `hidden`. The profile column remembers its last section in `useBots`.
- **Editing files:** use Edit/Write or script files, not `node -e` in bash. The repo is LF.
- **Server-owned params:** `OpenSessionParams.gated`, `.botId` and the new `.botRole` are server-set. `clientSessionParams` must strip all three.
- **The bot cannot change its own policy or budget.** `propose_policy` only creates a card, and `self-guard.ts` is unchanged.
- **Tests:** run with the environment stripped:
  `env $(env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE)' | sed 's/^/-u /') npm test -w <ws> -- <file>`
  Also `npm run typecheck`. For e2e, run `npm run build -w server` first. Run `node scripts/ui-smoke.cjs` with the same env stripping.
- **Unchanged in A:** the policy gate's levels, budget, duty service, server lock, phase‑1 inbox semantics (refuse and queue), and the phase‑42 server assertions.

## Tasks

Waves are listed in dependency order. Tasks in the same wave touch disjoint files and can run in parallel.

| Wave | Tasks |
| --- | --- |
| 0 | T1 |
| 1 | T2 ∥ T3 ∥ T4 ∥ T7 ∥ T10 |
| 2 | T5 ∥ T8 ∥ T9 |
| 3 | T6 |
| 4 | T11 ∥ T12 (shared contract: `BotThread` props; T12 can stub it) |
| 5 | T13 |

---

### T1 — Protocol and shared types

**Goal:** define every wire shape once.

**Modify `server/src/protocol.ts`:**

- **`OpenSessionParams`:** add `botRole?: 'thread' | 'run' | 'internal'`. It is server-set: thread means the bot's main conversation, run is a routine run, internal is generator/kickoff work.
- **`SessionMeta`:** add `botId?: string` and `botRole?: 'thread' | 'run' | 'internal'`.
- **`Bot`:** add:
  - `title?: string` (职位)
  - `threadId?: string` (server-owned)
  - `notify?: boolean`
  - `pinned?: boolean`
  - `hidden?: boolean`
  - `avatar` keeps its `string` type, with a documented format of `shape:<0-11>|color:<0-9>|seed:<n>`. `char:<id>` is reserved for batch B.
- **`BotStatus`:** add:
  - `lastLine?: { text: string; at: number }`
  - `unseen: number`
  - `activity?: string`
  - `error?: { reason: string; next?: string }`
  - `threadUsd?: number`
- **Timeline types:**
  ```ts
  export type BotTimelineKind = 'system' | 'run' | 'approval' | 'draft' | 'proposal';
  export interface BotTimelineEntry {
    id: string; botId: string; at: number; kind: BotTimelineKind;
    /** system: one line; run: the routine name */ text?: string;
    /** system: what the click opens (≤ 2000 chars) */ detail?: string;
    icon?: 'routine' | 'rename' | 'memory' | 'policy' | 'profile' | 'bot';
    runId?: string; routineId?: string;
    /** approval / draft / proposal: the inbox item drawn live from useBots.inbox */ itemId?: string;
  }
  ```
- **`InboxProposal`:** add the variant `{ type: 'policy'; rules: PolicyRule[]; why?: string }`.
- **`InboxItem`:** add `thread?: boolean`. It means the approval came from the bot's main conversation, which has no routineId.
- **`ClientRequest`:**
  - `bots.start { name: string; avatar?: string; templateId?: string; cwd: string }` returns `BotStatus` with `threadId`.
  - `bots.thread.open { id: string }` returns `{ sessionId: string }`.
  - `bots.thread.seen { id: string }`.
  - `bots.timeline.list { id: string; before?: number; limit?: number }` returns `BotTimelineEntry[]`, oldest first.
  - Remove `bots.generate`. T2 deletes the server path and T12 the UI.
- **`ServerEvent`:** add `{ kind: 'bots.timeline'; entry: BotTimelineEntry }`.

**Tests:** `npm run typecheck` (both workspaces) passes with stub handlers that throw "not yet".

**Acceptance:** types compile, and no client can set `botRole` (asserted in T2).

---

### T2 — Keep bot and internal conversations out of the conversation lists (fixes the generator leak)

**Goal:** a bot's thread, its runs and generator/kickoff conversations never appear in the sidebar, palette, home, library or sessions MCP.

**Create `server/src/bots/hidden.ts`:**

- `GENERATOR_PREFIX = '把下面这句话变成一个「值班 Bot」的设置'`
- `isBotSession(meta: SessionMeta | undefined, s?: Pick<SessionSummary, 'firstPrompt' | 'title'>): boolean` returns true when either:
  - `meta?.botId` or `meta?.botRole` is set, or
  - the first prompt or title starts with `GENERATOR_PREFIX`. This catches conversations already leaked by phase 1.

**Modify `server/src/runtime/pool.ts` `open()`:**

- When `params.botId` or `params.botRole` is set, record `setSessionMeta(r.sessionId, { botId, botRole })`, following the `keepChatOnly` pattern and skipping the fork placeholder.
- **Guard:** if `params.sessionId` has `meta.botRole === 'thread'` and `!params.gated`, throw `tr('这是 Bot 的对话，请从 Bot 页打开')`. This catches every ungated path: IM, sessions MCP deliver, goals, fork, schedules.

**Modify `server/src/bots/service.ts` `clientSessionParams`:** also strip `botRole`.

**Modify `server/src/bots/pipeline.ts`:** routine run params get `botRole: 'run'`.

**Delete `server/src/bots/generate.ts` and `generate.test.ts`,** plus `BotService.generate`. Also drop `bots.generate` from the hub `GOES_OUT` set and its switch case. If you would rather keep it, it must open with `botRole: 'internal'`.

**Modify `server/src/ws/hub.ts` `sessions.list`:** filter with `isBotSession(s.meta.sessionMeta(x.sessionId), x)`.

**Find every other list producer and apply the same filter:**

- library search/list used by the palette (`grep -n "library\.\(search\|list\)" server/src/ws/hub.ts`)
- the `setSessionsDeps({ list })` wiring in `server/src/index.ts`, so `list_sessions` hides them and `send_to_session` refuses them
- IM's session pickers, if any

**Tests:**

- `server/src/bots/hidden.test.ts`: meta with botRole is hidden. A legacy generator `firstPrompt` is hidden. A normal session is shown.
- `service.test.ts`: `clientSessionParams({ cwd, gated: true, botId: 'x', botRole: 'thread' })` has none of the three.
- `pool.test.ts` (or nearest):
  - opening `{ botId, botRole: 'run', gated: true }` records meta;
  - opening a thread id without `gated` throws.

**Acceptance:** after `bots.start`, `sessions.list` doesn't contain the thread or kickoff, and old leaked generator rows disappear.

**Parallel:** yes. It owns pool.ts, hidden.ts, generate.ts, the hub `sessions.list` case and `clientSessionParams`.

---

### T3 — Bot timeline and thread state on disk

**Goal:** persistence only (no wiring).

**Modify `server/src/bots/store.ts`:**

- `appendTimeline(id: string, e: BotTimelineEntry): Promise<void>` appends to `bots/<id>/timeline.jsonl` under `locked()`.
- `timeline(id: string, o?: { before?: number; limit?: number }): BotTimelineEntry[]` is oldest first, default limit 300, skips torn lines.
- `threadState(id): ThreadState` and `setThreadState(id, patch)` read and write `bots/<id>/thread.json`, where:
  ```ts
  interface ThreadState { lastLine?: { text: string; at: number }; seenAt?: number; deliveredAt?: number; updatedAt: number }
  ```
  `ThreadState` goes in `types.ts`.
- These files are written without the lease, deliberately. They are append-only or per-bot, and the thread can live on a non-holder server. Document this in a comment.

**Create `server/src/bots/timeline.ts`:**

- `entryForRun(run: BotRun, routineName: string): BotTimelineEntry | undefined` produces one `run` entry per finished, non-skipped run, with the id `run:<runId>` so re-emits dedupe.
- `entryForItem(item: InboxItem): BotTimelineEntry | undefined` maps:
  - approval → `approval`, draft → `draft`, proposal → `proposal`, each with id `item:<itemId>`;
  - a finding → no entry, because the run card carries it.
- `systemEntry(botId, text, icon, detail?)`.
- `eventsBlock(entries: BotTimelineEntry[], items: Map<string, InboxItem>, runs: Map<string, BotRun>): string` renders `<cw-bot-events>\n- 9:41 例行「早间简报」完成：…\n- 9:42 你批准了：git push …\n</cw-bot-events>\n\n`. It returns '' when there is nothing to say. The text is for the model only, so it isn't run through tr.

**Tests:**

- `store.test.ts`:
  - append → read round-trip;
  - a torn last line is skipped;
  - `before` / `limit` paging;
  - thread state merge.
- `timeline.test.ts`:
  - run → entry (skipped → none);
  - approval → entry with itemId;
  - `eventsBlock` lists only what it's given and is '' for none.

**Parallel:** yes (store.ts, types.ts and timeline.ts only).

---

### T4 — Runner and gate support for an interactive gated thread

**Goal:** a gated conversation that a person is watching.

**Create `server/src/bots/runtime-hooks.ts`** (a registry like `setSessionsDeps`):

```ts
export interface BotRuntime {
  selfServer(botId: string, self: () => string): McpServerConfig;
  threadPrompt(botId: string): string;
}
export function setBotRuntime(r: BotRuntime | null): void;
export function botRuntime(): BotRuntime | null;
export const BOT_SELF_SERVER = 'cw-bot';
```

**Modify `server/src/runtime/session-runner.ts`:**

- Store `private readonly botRole = this.gated ? params.botRole : undefined`.
- When `botRole === 'thread'` and `botRuntime()`:
  - add `{ [BOT_SELF_SERVER]: botRuntime().selfServer(botId, () => this.sessionId) }` to `mcpServers` next to `sessionsMcp`;
  - append `botRuntime().threadPrompt(botId)` to `append`. It is read at start, and a respawn reads it again.
- In `gateHook`: when `botRole === 'thread'` and `input.tool_name === 'AskUserQuestion'`, return `{ continue: true }` with no decision.
- In `onCanUseTool` under `this.gated`: when `botRole === 'thread'` and `toolName === 'AskUserQuestion'`, return `this.askUser(event, o.signal)` so the existing AskCard shows.

  > **Risk found:** today `classify('AskUserQuestion')` is 'send' (unknown tool), so in a gated conversation the kickoff question would be refused and queued in the inbox.

- Expose `readonly botRole` for the pool and thread code.

**Modify `server/src/bots/policy/gate.ts`:**

- `GateCtx.bot` becomes `Bot | (() => Bot)`. Resolve it on every call. A long-lived thread must see policy changes; today `makeGate` snapshots the bot.
- Tools under `/^mcp__cw-bot__/` (after `unwrap`) skip `decide` and `selfGuard`. They get an audit row `{ cls: 'write_local', level: 'do', basis: 'rule', result: 'allowed' }` and are allowed.
- `GateCtx.routineId` becomes optional, for the thread.

**Tests:**

- `session-runner.test.ts` (gated + thread, with a fake gate):
  - the hook leaves AskUserQuestion undecided;
  - canUseTool for AskUserQuestion emits `permission`;
  - Bash still goes to the gate;
  - a gated `run` role still refuses AskUserQuestion through the gate.
- `gate.test.ts`:
  - `mcp__cw-bot__routine_create`, direct and wrapped in `ExecuteExtraTool`, is allowed with one audit row;
  - a `bot` getter sees a policy change between two calls.

**Parallel:** yes (session-runner.ts, gate.ts, runtime-hooks.ts).

---

### T5 — The bot-self MCP (in-process)

**Goal:** tools through which the bot manages itself. They are not graded, but every call is audited and leaves a timeline entry.

**Create `server/src/bots/self-mcp.ts`.** It uses `createSdkMcpServer` + `tool` with zod/v4, following `sessions-mcp/tools.ts`. Mark every tool `_meta: ALWAYS_LOAD` (`server/src/mcp/always-load.ts`) so ccb doesn't defer it behind ExecuteExtraTool.

Deps:

```ts
export interface BotSelfDeps {
  get(botId: string): Bot | undefined;
  /** BotService.update with the lease; throws 另一个 claude-web 正在值班 */
  edit(botId: string, fn: (b: Bot) => Bot): Promise<Bot>;
  runNow(botId: string, routineId: string): Promise<void>;
  remember(botId: string, text: string): Promise<void>;     // MemoryService.write scope 'bot', key botId
  propose(botId: string, p: InboxProposal, title: string): Promise<InboxItem>;
  event(botId: string, text: string, icon: BotTimelineEntry['icon'], detail?: string): Promise<void>;
}
export function botSelfServer(botId: string, self: () => string, d: BotSelfDeps): McpServerConfig;
```

Tools. Every one returns a text result for the model, and every error is returned with `isError: true`.

- **`bot_profile { name?, title?, avatar?, charter?: { role?, audience?, sources?, report?, done? } }`:**
  - goes through `botFields(patch, prev)`, so policy, budget and routines are not accepted;
  - event text examples: 「已改名为 X」, 「已更新职责」.
- **`routine_create { name, prompt, cron?, everyMinutes?, until?: string | 'forever', notify?: string }`:**
  - a missing `until` is refused with 「必须写结束日期或明确写『一直』」, and `until` is stored in the prompt footer;
  - goes through `routineOf(v, new Map())` with `selfMade: true`, respecting `maxRoutines`;
  - everyMinutes is at least 15;
  - event 「已创建例行 ⏲ {name}」 with a human cadence in `detail`.
- **`routine_update { id, …same }`, `routine_pause { id, paused }`, `routine_delete { id }`, `routine_test { id }`** (the last calls `runNow`). Each writes an event.
- **`remember { text }`:** event 「已记住：…」.
- **`propose_policy { rules: PolicyRule[], why }`:**
  - validates rules with shape.ts (export `ruleOf`);
  - creates an inbox `proposal` of type 'policy';
  - returns 「已发给用户确认，确认前不生效」;
  - never edits policy.

**Modify `server/src/bots/shape.ts`:** export `ruleOf`, and accept `title`, `notify`, `pinned`, `hidden` in `botFields`. `threadId` is never taken from a request.

**Tests:** `self-mcp.test.ts`, calling the tool handlers directly with fake deps:

- routine_create without `until` → isError;
- a valid one → `edit` was called with a routine having `selfMade` and an event was written;
- bot_profile can't set policy (the key is ignored or refused);
- propose_policy creates a proposal and doesn't call `edit`;
- an `edit` throwing the lease error → isError carrying that text.

**Parallel:** with T8 and T9 (self-mcp.ts, shape.ts).

---

### T6 — BotThreads: the main conversation, kickoff, event injection, thread approvals, status

**Goal:** wire everything up on the server.

**Create `server/src/bots/thread.ts`:**

```ts
export class BotThreads extends EventEmitter {   // 'line' (botId), 'timeline' (entry)
  constructor(d: { store: BotStore; inbox: Inbox; audit: AuditLog; pool: Pick<RunnerPool,'open'|'get'>; defaultProvider(): string|undefined; modelFor(b: Bot): string|undefined });
  /** opens (or returns) the gated runner of bot.threadId; a live ungated one is closed and reopened; gate set before any send */
  ensure(bot: Bot): AgentDriver;
  /** creates the conversation, stores threadId, sends the hidden kickoff */
  start(bot: Bot, template?: BotTemplate): Promise<string>;
  isThread(sessionId: string): string | undefined;          // → botId
  /** prepends <cw-bot-events> for entries after deliveredAt; advances deliveredAt */
  withEvents(sessionId: string, text: string): string;
  /** an approval whose item.thread: approveOnce on the thread gate, then a hidden 「已批准…继续」 send (or queued until idle) */
  onApproval(item: InboxItem, approved: boolean): Promise<void>;
  activity(botId: string): string | undefined;
}
export const KICKOFF_TAG = 'cw-bot-kickoff';
export function kickoffText(bot: Bot, template?: BotTemplate): string;  // wrapped in <cw-bot-kickoff>…</cw-bot-kickoff>
export function threadPrompt(bot: Bot): string;
```

**`ensure` open params:**

```ts
{ sessionId: bot.threadId, cwd: bot.cwd, permissionMode: 'default', providerId: bot.providerId || defaultProvider(), model: bot.model || modelFor(bot), gated: true, botId: bot.id, botRole: 'thread' }
```

- `drivenBy` is unset, because a person reads this conversation.
- The gate is `makeGate({ bot: () => store.get(id)!, runId: 'thread-' + yyyymmdd(now), … })`. Approvals it queues get `thread: true` and no routineId; make `GateCtx` carry an `itemExtra` for this.
- The gate is (re)made per process start, since runner state is lost on respawn.

**`threadPrompt`:**

- charter, title, policyLine;
- "speak like a colleague";
- for choices, use the AskUserQuestion tool with lettered options;
- set yourself up with the `mcp__cw-bot__*` tools;
- every routine needs an end date or 「一直」;
- policy is the user's: use `propose_policy`;
- events since the user's last message arrive in `<cw-bot-events>`.

**`kickoffText`:**

- **No template:** introduce yourself in one sentence, then call AskUserQuestion with A–F exactly as spec §2.2.
- **With a template:** say 「我按『X』来」 plus at most two confirmation questions through AskUserQuestion.

**`lastLine`:** listen to the pool's `message` for thread ids. On `result` with text, set `threadState.lastLine` (first 80 chars) and emit `line`.

**Modify `server/src/bots/service.ts`:**

- Own a `BotThreads`. Call `setBotRuntime({ selfServer: (id, self) => botSelfServer(id, self, selfDeps), threadPrompt: (id) => threadPrompt(this.must(id)) })`.
- Implement `selfDeps` with `this.edit` / `this.runNow` / memory write / `inbox.add` / timeline append.
- **`start({ name, avatar, templateId, cwd })`:**
  - builds from `fromTemplate(templateId, cwd)` when a template is given (routines kept, so the bot only confirms), else a minimal bot: empty charter role, no routines, `outputs: [{kind:'inbox'}]`, `policy: { rules: [], signOff: true }`, `budget: { dailyUsd: 2 }`;
  - default avatar from name;
  - then `create` → `threads.start` → `edit` to set threadId → system event 「已创建 {name}」.
- **`threadOpen(id)`:** a bot without a threadId (phase‑1 bots) gets one now, with a kickoff naming its existing routines. Returns `{ sessionId }`.
- **`timeline(id, before, limit)`, `seen(id)`.**
- **Wire events:**
  - scheduler `run` → `entryForRun` → append and emit `timeline`;
  - inbox `item` → `entryForItem` (new ones only, keyed by id) → append and emit;
  - both also emit `changed`.
- **`statusOf` adds:**
  - `lastLine` (thread state, or the last run's `said` first line if newer);
  - `unseen` (timeline entries after `seenAt`);
  - `activity` (running routine name, or the thread runner state: 「在想…」 / 「等你回答」);
  - `error` (budget used → 「预算用完 · 明早 0 点恢复」; last run error);
  - `threadUsd` (from `ledger.rowsFor(threadId)`, cached per tick).
- **`inboxAnswer`:** for `item.thread`:
  - skip `scheduler.persistApproval` (no routineId);
  - after `inbox.answer`, call `scheduler.onInboxAnswer` (still records trust and approve_scope rules — it needs the change below);
  - then call `threads.onApproval(item, approve)`.
- Policy proposal `adopt` is applied by the scheduler (below).

**Modify `server/src/bots/scheduler.ts`:**

- In `onInboxAnswer`, the approve branch no longer requires routineId/sessionId for trust or approve_scope. Only the resume part does, and the resume is skipped for `item.thread`.
- `adopt` handles `proposal.type === 'policy'`: each rule goes through `ruleOf` (allow-scope checks) and is appended by `mutate`. This is the only path by which a bot's suggestion changes policy, and it happens only after the user clicks.

**Modify `server/src/ws/hub.ts`:**

- Broadcast `bots.timeline`.
- Handle `bots.start` (`refusePeerUnc(cwd)`), `bots.thread.open`, `bots.thread.seen` and `bots.timeline.list`.
- In `session.open`, before `modeMismatch`: if `params.sessionId && s.bots.threads.isThread(id)`, return `{ sessionId, info, history, pending }` from `s.bots.threads.ensure(bot)` and ignore the client's model/mode/provider.
- In `session.send`: if it's a thread, `outgoing = s.bots.threads.withEvents(sid, outgoing)` before `runner.send`. The canonical mirror and `sent` echo keep the original text.

**Tests:** `thread.test.ts`, with a fake pool/driver like `pipeline.test.ts`:

- `start` sends exactly one message containing `<cw-bot-kickoff>`, and `runner.gate` is set before it;
- `withEvents` prepends once and a second call adds nothing;
- `onApproval` calls approveOnce and sends 「已批准」;
- an ungated live runner is closed and reopened.

`service.test.ts`:

- `start` with templateId keeps the template's routines and sets threadId;
- a thread approval answered with `approve_scope` adds the rule and doesn't call the scheduler's resume;
- `adopt` of a policy proposal adds the rules;
- `statusOf.unseen` counts after `seen`.

**Acceptance:**

- a window's `session.open` on a thread id returns a gated runner;
- sending prepends events;
- a gated thread approval resumes in place.

**Not parallel:** service.ts, scheduler.ts, hub.ts.

---

### T7 — Reducer: hidden prefixes and hidden kickoff

**Modify `web/src/model/conversation.ts`:**

- `decodeAttachments` first strips a leading `^<cw-bot-events>[\s\S]*?</cw-bot-events>\n*`, returning `botEvents?: string`.
- A whole message of the form `<cw-bot-kickoff>…</cw-bot-kickoff>`, or a resume text starting with `已批准` that the server tagged `<cw-bot-continue>`, returns `hidden: true`.
- `UserItem.hidden?: boolean` is set in `applyUser`. A hidden item still starts a turn (it anchors groupTurns), but it's not a prompt for `isLastPrompt`, edit, rewind or `suggestion`. Treat it like `meta` in those spots (lines ~580/610/771/875/887).

**Modify `web/src/model/turn.ts`, if needed,** so a turn whose user item is hidden keeps the assistant blocks.

**Tests** (`conversation.test.ts`):

- events prefix stripped, text kept;
- kickoff → hidden;
- edit or rewind never targets a hidden item;
- `groupTurns` gives one turn with the assistant reply after a hidden user item.

**Parallel:** yes.

---

### T8 — Embedding the conversation: ChatView extras and the Composer bot variant

**Create `web/src/features/chat/interleave.ts`:**

```ts
export function interleave<T extends { at: number }>(turnStarts: number[], extras: T[], hasOlder: boolean): { before: number; items: T[] }[]
```

- `before` is the index of the turn an extra goes ahead of; `turns.length` means at the end.
- When `hasOlder`, extras before the first loaded turn are dropped.

**Modify `ChatView.tsx`:**

- `ChatView({ extras?: { at: number; key: string; node: React.ReactNode }[] })`. `TurnList` renders the extras between `TurnView`s using `interleave` on each turn's first item ts, memoized on `[turns, extras]`.
- `UserBubble` renders nothing for `it.hidden`.

**Modify `Composer.tsx`:**

- New prop `variant?: 'bot'` hides the project/branch/permission/model chips and the + menu's 新对话-type entries.
- New prop `chips?: { label: string; text: string }[]` is reserved for batch B; leave it unrendered or omit it.
- Check that `focusComposer` in OverPage finds `.bot-thread .composer textarea`, and extend its selector.

**Risk:** ChatView's Ctrl+F looks up the pane in the layout and returns early under a synthetic `PaneContext` (`paneId: 'bot:<id>'`). Accept that (no find bar), or add `findAlways` to the context.

**Tests:**

- `interleave.test.ts`: ordering, ties go after the turn, old extras are dropped when `hasOlder`, an empty turn list puts everything at the end.
- `view-mode` / `ask-card` tests unaffected.

**Parallel:** with T5 and T9 (chat and composer files only).

---

### T9 — Web state and model for bots

**Rewrite `web/src/features/bots/state.ts`:**

- **Remove** `creating`, `createTemplate`, `phoneInbox`, `tab`/`BotTab`, `generate`, `createBot`, `startCreate`.
- **Add:**
  - `timeline: Record<string, BotTimelineEntry[]>`
  - `view: 'thread' | 'new'`
  - `profileOpen: boolean`
  - `profileSection: 'profile' | 'computer' | 'routines' | 'policy' | 'memory' | 'usage'`
  - `phoneScreen: 'roster' | 'thread' | 'profile'`
- **Add functions:**
  - `openThread(id)`: `bots.thread.open`, then `useStore.getState().openSession({ sessionId, cwd: bot.cwd }, 'none')` (so it's never placed in the layout), then `bots.thread.seen`, then `loadTimeline(id)`.
  - `startBot({ name, avatar, templateId, cwd })` → `bots.start` → `openThread`.
  - `loadTimeline(id, before?)`.
  - `markSeen(id)`.
  - `upsertTimeline(entry)` on `bots.timeline`.
- Keep `answerInbox`, `runNow`, `pauseBot`, `stopBot`, `deleteBot`, `updateBot` and `__cwBots`. `inject` also takes `timeline`.

**Modify `model.ts`:**

- `rosterGroups(bots: BotStatus[], inbox: InboxItem[]): { attention: BotStatus[]; rest: BotStatus[]; hidden: BotStatus[]; manager?: BotStatus }`. Sorting: pinned, then lastLine.at.
- `rowState(b): 'attention' | 'fresh' | 'working' | 'error' | 'idle'`.
- `lastLineOf(b, pendingForBot): string`. A pending approval gives 「{n} 件事等你点头」, otherwise `b.lastLine.text`, otherwise `b.title`.
- `cadenceText(r: Routine): string` (human time from cron/everyMinutes, wrapping the existing helpers).
- Drop the create-form helpers: `normalizeDraft`, `draftProblem`, `lastUserText`, etc.

**Tests:** in `model.test.ts`:

- grouping (attention first, ★ manager, hidden last);
- the lastLine priorities;
- cadenceText for `30 7 * * 1-5` and `everyMinutes: 60`.

Update `state.test.ts` (timeline upsert dedupes by id and keeps order; inject). Delete tests of removed helpers.

**Parallel:** with T5 and T8 (bots state/model only).

---

### T10 — Avatars: SVG generated from the name, with state animation

**Create `web/src/features/bots/avatar-model.ts`:**

- `avatarOf(name: string, stored?: string): { shape: number; color: number; seed: number }`: a stable string hash; `stored` overrides.
- `avatarString(a)`.
- `SHAPES` (12 SVG paths) and `COLORS` (10 tokens from the design tokens, contrast-checked against both themes).

**Create `web/src/features/bots/BotAvatar.tsx`:**

- `BotAvatar({ name, avatar, size, state }: { …; state?: 'idle' | 'working' | 'attention' | 'error' })` renders an inline SVG: shape, two eyes, and on `working` three dots.
- CSS in the bots stylesheet:
  - idle → slow blink;
  - working → eyes glance left/right plus dots;
  - attention → amber ring;
  - error → grayscale;
  - `@media (prefers-reduced-motion)` makes it static.
- `data-state` goes on the root for ui-smoke.

**Tests:** `avatar-model.test.ts`:

- the same name gives the same face;
- different names spread over at least 8 distinct shape×color pairs among 20 sample names;
- a stored string wins.

**Parallel:** yes. Batch B's pixel character uses `char:<id>` (`server/src/characters/`); not in A.

---

### T11 — The thread view and timeline cards

**Create `web/src/features/bots/BotThread.tsx`:**

- `BotThread({ bot }: { bot: BotStatus })`. It wraps `<PaneContext.Provider value={{ paneId: 'bot:'+id, tileId: 'bot', sessionId: bot.threadId }}>` around:
  - **Header:** avatar + name + activity (「在线」 when idle, otherwise `bot.activity`, otherwise the error reason and next step). Clicking it toggles `profileOpen`.
  - **Banner:** other bots' pending approvals: 「{n} 件事等你批 · 查看」 opens the first such bot.
  - `<ChatView extras={…} />` and `<Composer variant="bot" visible />`.
- Before the thread has loaded, show `tr('正在叫醒 {name}…')`.
- Calls `markSeen` when visible and new entries arrive.

**Create `web/src/features/bots/cards/`:**

- **`SystemLine.tsx`:** a centered small gray line. Clicking opens `detail` in an `Expandable`.
- **`BotRunCard.tsx`:**
  - from `useBots.runs` by runId: 「例行 · {name} · 用时 {s} s · {said first line}」 and 打开 (opens the run conversation with `openSession({sessionId}, 'none')` and shows it in the thread column as a back-able sub-view, or opens it in the main panes via `closeBots()` + `loadHistory`; pick one and record it in the notes);
  - while running: 「在跑…」 plus elapsed.
- **`ApprovalCard.tsx`,** from `useBots.inbox` by itemId:
  - **First line:** 「{classLabel} · {bot} 想要 {summary}」.
  - **Gray line:** 「请核对后再批准」.
  - **Evidence:** `callDetail(item)` (already masked) as a full `<pre>`.
  - **Key facts row:** amount / recipients / domains from `scopeDefaults`.
  - **Buttons:** an equal-width 拒绝 | 允许 ▾. ▾ is a `useAnchoredMenu`:
    - 仅这次 → `approve`;
    - 这次运行内 → `approve_scope` with `{ ...scopeDefaults, until: now + 30 min }`, shown only when the scope has a target;
    - 对这个目标总是允许 → `approve_scope` with `ScopeEditor` (reused from `scope-form.tsx`, prefilled);
    - 总是 → `ScopeEditor` with unlimited checked plus the `ruleUnlimitedRisk` confirm.
  - The default (button body) is 仅这次.
  - **When done:** 「已允许 · 9:42」 / 「已拒绝」 / 「已过期」 + 「以后总是允许？」 → opens the scope form against a new identical approval only if pending. Otherwise show the note only.
- **`DraftCard.tsx`:**
  - 发送 → `send` (copy + mark, as `Inbox.act` does);
  - 丢弃 → `archive`;
  - 以后不用草稿 → `updateBot(policy.signOff=false)` after a `dlg.confirm`. That edit is a user action, so it's allowed.
- **`ProposalCard.tsx`:**
  - policy proposals show the rules in plain words, with 采纳 → `adopt` and 不用 → `archive`;
  - trust_up / routine proposals keep the phase‑1 actions.

**`extras` building (`useThreadExtras(botId)`):** maps timeline entries to nodes keyed by entry id, memoized on the timeline array plus the inbox/runs arrays.

**Tests:**

- `cards/approval-menu.test.ts`, a pure helper `approvalChoices(item)`:
  - opaque target → only 仅这次 and 总是;
  - a pay item's scope needs maxAmount;
  - 这次运行内 has `until`.
- `thread-extras.test.ts`: entries map to nodes in time order, and an unknown itemId is dropped.

**Parallel:** with T12, which can stub `BotThread`.

---

### T12 — Roster, New Bot page, profile column, page rewrite, phone, deletions

**Rewrite `BotsSide.tsx` → `Roster.tsx`:**

- `Roster({ compact? })` is the desktop section sidebar (`SectionSide` shell with a search box and ＋).
- Groups:
  - 「需要你 (n)」;
  - bots;
  - the manager with ★;
  - a collapsed 「隐藏的 Bot」.
- **Row:** a 34 px `BotAvatar` | bold name + gray title | second line `lastLineOf` | time on the right | state dot.
- **Row menu** (`useAnchoredMenu`): 置顶 / 隐藏 / 暂停 / 删除, with delete via `dlg.confirm` and the manager excluded.
- `App.tsx` keeps mounting it in the `bots` sidebar section. Rename the import.

**Rewrite `BotsPage.tsx`:**

- **Desktop:** `OverPage` with no tabs; the body is a two-column `thread | profile` grid. The roster is the app sidebar.
- **Only one non-manager bot:** go straight into its thread. Spec says no empty roster (desktop still shows the roster in the sidebar).
- **No bots:** the New Bot page.
- **Phone:** `phoneScreen` switches between `Roster`, `BotThread` (with a back arrow and the avatar at top right → profile) and `BotProfile` (full page). All three stay mounted and are hidden.
- **Esc order:** profile → new page → close page.

**Create `NewBot.tsx`** (`view: 'new'`):

- avatar picker (shape × color grid plus 换一个), name field (`imeComposing`), folder chip defaulting to the focused conversation's cwd else home, 开始;
- below it, template cards from `useBots.templates`, where a click starts with that template;
- calls `startBot`.

**Create `BotProfile.tsx`** with sections in a hidden-not-unmounted scroll column. `profileSection` scrolls into view and is remembered.

- **资料:** avatar, name (BlurField → `updateBot`), title, notify toggle.
- **电脑 (最近画面):**
  - the last image result of a `mcp__web__browser_*` / `mcp__computer__*` tool in the thread conversation, or in the latest run conversation if loaded;
  - helper `lastScreen(conv)` in `profile-model.ts`;
  - shows the time, else 「电脑闲着」;
  - no takeover in A.
- **例行:**
  - rows: status dot, name, `cadenceText`, pause switch (`updateBot` routines);
  - expanding a row shows the prompt, next run, last 5 runs, and 暂停 / 测试 (`runNow`) / 编辑 / 删除 (`dlg.confirm`);
  - 编辑 prefills the composer with 「改一下例行：{name}」 via `fillComposer`, scoped to the bot thread;
  - footer 「在对话里说一句就能加」.
- **权限:**
  - one row per class with four levels (直接做 / 做了告诉我 / 先问我 / 不许), reusing `PolicyEditor`'s level logic;
  - scoped rules listed with source and time, plus 撤销;
  - edits go through `updateBot` (the user's own edit; allowed).
- **记忆:** `memory.search { scope:'bot', botId }`, inline edit via `memory.update`, delete via `memory.remove` with 「这条不对」.
- **用量:** `weekUsd` / `budget.weeklyUsd` (or dailyUsd×7), `todayUsd`, `threadUsd`, and a context ring from the thread session info when open.

**Delete:** `BotDetail.tsx`, `BotList.tsx`, `CreateBot.tsx`, `RunPane.tsx`, `LoadBar.tsx` (or move a one-line load summary under the roster), `RoutineTable.tsx` (after moving `monthlyEstimate` use into the profile if wanted), `RunList.tsx`, and the inbox tab in BotsPage.

**Keep:** `Inbox.tsx` (MissionPanel 「需要你」 uses it; its 「看对话」 should call `openBots(item.botId)` + `openThread` for `item.thread`), `scope-form.tsx`, `mask.ts`, `fields.tsx`, `PolicyEditor.tsx` (if reused), and `features/settings/BotsSection.tsx` unchanged.

**Tests:**

- `profile-model.test.ts`: `lastScreen` finds the newest image tool result, and none → undefined.
- `roster.test.ts` (pure): search filters by name/title, and hidden bots are excluded from 需要你.
- Delete tests of removed components; update `inbox-view.test.ts` if imports moved.

**Acceptance:** `npm test -w web` and typecheck pass, and selectors are stable (`selectors.test.ts`).

---

### T13 — i18n, wording, e2e, ui-smoke, notes

**i18n:** `node scripts/i18n/extract.mjs --check`. Add English for every new string in `en.ts`. `wording.test.ts` passes: no 会话 / 窗格; the menu says 对话.

**e2e (`server/ws-phase42.mjs`), extend after the phase‑1 checks:**

1. **Fake upstream:** a new mode driven by the request.
   - When `turnText` contains `cw-bot-kickoff`: reply with text 「嗨，我是 晨报…」 plus a `tool_use` `AskUserQuestion { questions: [{ question: '你最想让我帮什么？', header: '…', options: A–F, multiSelect: false }] }`.
   - When the last tool_result is an AskUserQuestion answer: reply with a `tool_use` named `mcp__cw-bot__routine_create` if `j.tools` lists it, else `ExecuteExtraTool { tool_name: 'mcp__cw-bot__routine_create', params }`, with `{ name: '早间简报', prompt: '…', cron: '0 8 * * 1-5', until: 'forever' }`.
   - When the turn's text has `给我推一下`: the `Bash git push origin main` tool_use, to get a thread approval.
2. `bots.start { name: '晨报', cwd: repo }` → `threadId` is set, and `sessions.list` doesn't contain it.
3. Wait for a `permission` event with `toolName: 'AskUserQuestion'` on `threadId` (the kickoff spoke first). Answer with `permission.respond { behavior: 'allow', updatedInput: { …input, answers: { '你最想让我帮什么？': 'A …' } } }`.
4. Wait until `bots.get(id).routines` has 早间简报 with `selfMade: true`. `bots.timeline.list` has a `system` entry 「已创建例行」. The audit has a `mcp__cw-bot__routine_create` row with basis `rule`.
5. Send through `session.open` + `session.send` 「给我推一下」 on the thread → an approval with `thread: true` and `sessionId === threadId`. A `bots.timeline` entry has kind `approval` and that itemId. The upstream's next request text contains no `<cw-bot-events>` yet.
6. `bots.inbox.answer { approve }` → the thread's next upstream request contains 「已批准」. The audit row for the push has basis `user`.
7. A later `session.send` on the thread → the upstream user text starts with `<cw-bot-events>` and contains 「你批准了」. The transcript (`transcript.load`) holds it, but the decoded UI (T7) strips it; the reducer test covers that.
8. Delete the bot → the timeline file is gone (directory removed).

Keep every existing phase‑1 assertion.

**ui-smoke (`scripts/ui-smoke.cjs`), rewrite the 「bots」 section:**

- **Inject:** two bots (`attention` with `lastLine`, `running`), a timeline with system / run / approval entries for bot 1, and an approval inbox item with `thread: true`.
- **Checks:**
  - `.bot-roster .bot-row` ×2, each with `.bot-avatar[data-state]`, the second line text, and the attention group first;
  - clicking row 1 → `.bot-thread` is visible and `.bot-sysline`, `.bot-run-card` and `.bot-approval-card` are inside `.chat-inner` in time order;
  - the approval card has 拒绝 and 允许, and its ▾ menu has 4 entries (or 2 for an opaque target);
  - 资料 toggle → `.bot-profile` with five sections (资料 / 电脑 / 例行 / 权限 / 记忆 / 用量 headings present; 电脑 shows 「电脑闲着」);
  - ＋ → `.bot-new` with the name field and template cards (14);
  - Esc order: profile, then the page;
  - 总览 · 需要你 still shows the approval with 批准;
  - no error boundary and no console errors.
- **Phone width:** roster → thread → profile screens toggle.
- Take screenshots `bots-roster`, `bots-thread`, `bots-new`, `bots-profile`.

**Notes (`docs/notes/duty-bots.md`), add a 「聊天优先（A 批，2026-10-31）」 section covering:**

- thread = gated conversation with `botRole: 'thread'`;
- `SessionMeta.botId/botRole` hides conversations, including the legacy generator prefix rule;
- the pool's guard against ungated thread opens;
- the AskUserQuestion exception in gated threads;
- `<cw-bot-events>` / `<cw-bot-kickoff>` and where they're stripped;
- `timeline.jsonl` and `thread.json`, written without the lease, and why;
- bot-self MCP tools, audited with basis rule;
- policy only via adopted proposals;
- thread approvals (`thread: true`, approveOnce plus a continue message, no resumes.json);
- the debug hook `__cwBots.inject({ timeline })`;
- the e2e and ui-smoke changes;
- update the 「界面」 bullet: no inbox page, and the phone's first screen is the roster.

The `CLAUDE.md` index row text is unchanged.

**Final run:** `npm run typecheck`, `npm test` (env-stripped), `npm run build:all`, `npm run build -w server && node server/ws-phase42.mjs`, `node scripts/ui-smoke.cjs`.

---

## Risks and unknowns found in the code

1. **AskUserQuestion is refused in gated conversations today.** `classify` ranks unknown tools as 'send', so the kickoff question would be queued in the inbox instead of shown. T4 fixes this for `botRole: 'thread'` only.
2. **The thread can be opened ungated.** Windows' `session.open` passes `clientSessionParams`, which strips `gated`. IM, `send_to_session`, goals and fork open through the pool directly. Hence the hub intercept plus the pool guard (T2/T6). Forking a thread should be disabled in the UI, because a fork is a new, ungated conversation.
3. **`makeGate` snapshots the `bot`.** A long-lived thread would keep the old policy. It becomes a getter (T4).
4. **Phase‑1 approvals need routineId and sessionId** (`scheduler.approvedCall`). Thread approvals take a separate path, `thread: true` (T6). IM 批准 buttons go through `inboxAnswer`, so they work too.
5. **Hiding conversations from the list.** There's no existing "hidden" flag, and lists come from `library.list` (hub `sessions.list`), library search and sessions MCP deps. Each producer must filter, so grep for all of them. Old leaked generator conversations can only be recognised by their first prompt.
6. **Hiding routine run conversations changes phase‑1 behaviour.** The notes say 「对话本身在对话列表里」. The spec's 「库里按 Bot 归档」 implies hiding them. The plan hides them and reaches them through 打开 on the run card; confirm with the user.
7. **ChatView can be embedded but is coupled to the pane.** It reads `PaneContext` (a synthetic context works). Its Ctrl+F checks the layout, and `askScope`, OverPage's `focusComposer` selector and Composer chips all assume a pane. ChatTile-only pieces (GoalBar, PrBar, InfoColumn) are not included. `openSession(p, 'none')` avoids placing the conversation into the layout.
8. **Hidden prefixes.** The local echo shows the typed text, because the prefix is added in hub `session.send`. The reloaded transcript contains the prefix, so it's stripped in `decodeAttachments`. A hidden kickoff still has to anchor a turn in `groupTurns` (T7). The canonical mirror and handover briefing see the text without events, which is acceptable.
9. **The lease.** Bot-self tools edit bot.json through `acting()`. On a server that isn't on duty, the thread's tool calls fail with 「另一个 claude-web 正在值班」, which is returned to the model as an error. The timeline and `thread.json` are written by both servers (append-only, tolerant reads).
10. **Budget.** Thread turns are user-initiated and not budget-gated in A. Their cost is shown (`threadUsd`). Decide whether the budget should also stop thread turns.
11. **ccb deferring MCP tools.** ccb may wrap them in `ExecuteExtraTool`. Use `ALWAYS_LOAD` on the cw-bot tools; the gate's `unwrap` already handles the wrapper, and the e2e picks the name from the request's `tools`.
12. **Audit for the thread** uses the synthetic run id `thread-YYYYMMDD`. `perDay` counting in `gate.seed` only reads `runs/index.jsonl`, so thread calls aren't counted across processes. This is minor; note it.
13. **电脑「最近画面」** is client-derived from tool-result images in loaded conversations. There's no server screenshot channel in A (spec §3's 4 s polling is batch B).

### Critical Files for Implementation
- C:\Users\YPY\claude-web\server\src\runtime\session-runner.ts
- C:\Users\YPY\claude-web\server\src\bots\service.ts (plus new thread.ts / self-mcp.ts beside it)
- C:\Users\YPY\claude-web\server\src\ws\hub.ts
- C:\Users\YPY\claude-web\web\src\features\chat\ChatView.tsx
- C:\Users\YPY\claude-web\web\src\model\conversation.ts
