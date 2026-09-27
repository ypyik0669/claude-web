# 统一会话库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本机 Claude / Codex / OpenCode（以及声明支持 ACP `session/list` 的 agent）的全部会话出现在 claude-web 的一个列表里，可跨 agent 搜索、看完整历史、在原 agent 续聊、交给别的 agent、作为上下文引用。

**Architecture:** `server/src/library/` 下每个 agent 一个 `SessionSource` 适配器（官方接口优先），`LibraryService` 汇总、去重、缓存并驱动 `library.db`（SQLite FTS5）全文索引；hub 的 `sessions.list / sessions.search / transcript.load` 改走它，新增 `library.*` 请求做管理操作；前端侧栏加来源筛选、分组「展开更多」、按能力显示的管理菜单。

**Tech Stack:** TypeScript（server ESM + web React/zustand）、`node:sqlite` FTS5、Codex app-server JSON-RPC v2（`server/src/agents/jsonrpc.ts`）、OpenCode `opencode serve` HTTP、vitest。

**Spec:** `docs/superpowers/specs/2026-09-27-unified-session-library-design.md`

## Global Constraints

- **加入是可选的**：除 Claude 外，任何来源默认**不加入**会话库；系统自动检测本机装了哪些 agent（只做轻量检测：复用 `AgentRegistry` 的安装/版本探测 + 数据目录是否存在，**不启动后台进程**），用户点「加入」后才启动适配器、列会话、建索引；「移出」立即停止该来源的后台进程并从列表与索引里去掉它的会话（不动 agent 自己的数据）。加入状态存 meta `settings['library.joined']: AgentKind[]`，「以后再说」存 `settings['library.dismissed']: AgentKind[]`。
- 修改其它 agent 的会话**只走官方接口**；没有接口的来源只读；不直接改写 agent 的数据文件。
- 删除前先把完整历史导出到 `~/.claude-web/library-trash/<id>.json`（保留 30 天）；导出失败则不删除；界面二次确认；批量操作默认归档。
- 会话 id：Claude 保持原 UUID；其它来源 `<agent>-<原生 id>`（`codex-…`、`opencode-…`），不含冒号。
- 导入会话的历史永远从 agent 自己读；在这里续聊的新轮次写回 agent 原生记录。
- 库专用后台进程（Codex app-server、`opencode serve`）每个来源至多一个，闲置 5 分钟退出，与会话进程不共用。
- 索引库 `~/.claude-web/library.db`（路径跟随 `CLAUDE_WEB_DIR`）；单会话正文摘录上限 20 000 字符；中文查询走 LIKE（同 `memory/service.ts` 的 `hasCjk`）。
- 单个来源失败不影响其它来源，返回上次缓存并带 `error`。
- 数据目录一律用 `dataDir()`（`server/src/meta/store.ts` 同源），测试里用临时 `CLAUDE_WEB_DIR`。
- 真实数据只读验证：对本机真实 Codex / OpenCode 会话只做 list / search / read / resume；rename / archive / delete 只在测试时新建的会话上做。

## Review Focus

1. **Codex / OpenCode 没装或后台进程起不来（ENOENT、崩溃）** → 该来源 `status.enabled=false` 带原因，`list()` 返回空，Claude 会话照常显示（Task 3、4 各一测）。
2. **删除时备份导出失败** → 不调用官方删除、向客户端报错，会话仍在（Task 8 测）。
3. **会话在原生 CLI 里又聊了几轮** → 下次刷新时 `updatedAt` 变了，索引重建这条、列表时间更新（Task 7 测）。
4. **超长线程（上千条事项）** → `read()` 按页返回，首页只含最近 N 轮，`next` 游标能继续往前取（Task 3 测）。
5. **中文关键词搜导入会话正文中间的词** → 命中（Task 7 测）。

---

### Task 1: 协议与 id

**Files:**
- Modify: `server/src/protocol.ts`（`AgentKind`、`SessionSummary`、`HubRequest` 联合）
- Create: `server/src/library/ids.ts`
- Test: `server/src/library/ids.test.ts`

**Interfaces:**
- Produces:
  - `AgentKind` 加 `'opencode'`。
  - `SessionSummary` 新增可选字段：`source?: string`（cli / vscode / exec / appServer / opencode …）、`parentId?: string`、`archived?: boolean`、`childCount?: number`、`caps?: SourceCaps`。
  - `export interface SourceCaps { resume: boolean; rename: boolean; archive: boolean; delete: boolean; fork: boolean }`
  - `export interface SourceStatus { kind: AgentKind; name: string; installed: boolean; detected: boolean; joined: boolean; dismissed: boolean; enabled: boolean; version?: string; count?: number; indexedAt?: number; error?: string; disabledReason?: string }`
  - 新请求：`{ kind: 'library.sources' }` → `SourceStatus[]`；`{ kind: 'library.read'; sessionId: string; cursor?: string; limit?: number }` → `{ messages: any[]; next?: string }`；`{ kind: 'library.rename'; sessionId: string; title: string }`；`{ kind: 'library.archive'; sessionIds: string[]; archived: boolean }`；`{ kind: 'library.delete'; sessionIds: string[] }` → `{ deleted: string[]; failed: { id: string; error: string }[] }`；`{ kind: 'library.fork'; sessionId: string }` → `{ sessionId: string }`；`{ kind: 'library.reindex' }`；`{ kind: 'library.join'; kind_: AgentKind; joined: boolean }`、`{ kind: 'library.dismiss'; kind_: AgentKind }`；事件 `library.discovered`（`{ kinds: AgentKind[] }`：检测到、未加入、未 dismiss 的来源）。`enabled` = 已加入且可用。
  - `sessions.search` 返回项加 `snippet?: string` 已有，保持形状 `{ session: SessionSummary; snippet?: string }[]`。
  - `ids.ts`：`libraryId(kind: AgentKind, nativeId: string): string`（claude 原样返回 nativeId）、`parseLibraryId(id: string): { kind: AgentKind; nativeId: string }`（无已知前缀 → `{kind:'claude', nativeId:id}`）。已知前缀：`codex-`、`opencode-`、`acp_<id>-`（ACP 自定义 agent 的 `acp:x` 映射成 `acp_x-`，避免冒号）。

- [ ] **Step 1: 写失败测试** `ids.test.ts`：`libraryId('codex','019a')==='codex-019a'`；`libraryId('claude','u-1')==='u-1'`；`libraryId('acp:demo','s1')==='acp_demo-s1'`；`parseLibraryId('opencode-ses_x')` → `{kind:'opencode',nativeId:'ses_x'}`；`parseLibraryId('acp_demo-s1')` → `{kind:'acp:demo',nativeId:'s1'}`；一个普通 UUID → `{kind:'claude'}`；往返 `parse(libraryId(k,n))` 对上述每种都相等。
- [ ] **Step 2:** `npm test -w server -- ids` → FAIL（模块不存在）
- [ ] **Step 3:** 实现 `ids.ts`，改 `protocol.ts`。
- [ ] **Step 4:** `npm test -w server -- ids` 通过；`npx tsc --noEmit -p server && npx tsc --noEmit -p web` 通过。
- [ ] **Step 5:** `git commit -m "library: ids and protocol types"`

### Task 2: 抽出 Codex 事项转换

**Files:**
- Create: `server/src/agents/codex-items.ts`
- Modify: `server/src/agents/codex-driver.ts`（`onItem` 改为调用共享函数，行为不变）
- Test: `server/src/agents/codex-items.test.ts`，夹具 `server/src/agents/__fixtures__/codex-turns.json`

**Interfaces:**
- Produces:
  - `export type CodexItemState = Map<string, { type: string; toolName?: string; output: string }>`
  - `export function codexItemMessages(synth: MessageSynth, seen: CodexItemState, item: any, completed: boolean): any[]` —— 就是现在 `CodexDriver.onItem` 的逻辑（commandExecution / fileChange / mcpToolCall / dynamicToolCall / plan / webSearch），返回要推送的消息而不是自己 push。
  - `export function codexTurnsToMessages(sessionId: string, turns: any[], model?: string): any[]` —— 历史转换：每个 turn `synth.beginTurn()`；`userMessage` → `synth.user(content 里 type==='text' 的 text 拼接)`；`agentMessage` → `synth.text(item.text)`；`reasoning` → `synth.delta('thinking', [...summary, ...content].join('\n'))`；其余走 `codexItemMessages(…, completed=true)`；turn 末 `synth.endTurn({ ok: status==='completed'||status==='interrupted', error: turn.error?.message })`。最后**过滤掉 `type==='stream_event'`**（历史只要终态消息，和 transcript 一致）。

- [ ] **Step 1: 录夹具**：用本机 `codex app-server` 对一个真实线程调 `thread/turns/list {threadId, itemsView:'full', limit:3}`，把结果脱敏（路径换成 `/work/demo`、去掉 base_instructions）存成夹具；至少包含 userMessage、agentMessage、reasoning、commandExecution、fileChange 各一。
- [ ] **Step 2: 写失败测试**：`codexTurnsToMessages('codex-x', fixture.data.reverse())` 结果里：没有 `stream_event`；第一条 `type==='user'` 且文本等于夹具第一个 userMessage 文本；存在 `assistant` 含 `tool_use` name `Bash` 且随后有 `tool_result` 同 id；fileChange 产出 `Edit` 或 `Write`；每个 turn 以 `type==='result'` 结尾。
- [ ] **Step 3:** `npm test -w server -- codex-items` → FAIL
- [ ] **Step 4:** 实现 `codex-items.ts`，`CodexDriver.onItem` 改成 `this.pushAll(codexItemMessages(this.synth, this.items, item, completed))`。
- [ ] **Step 5:** `npm test -w server` 全过（`drivers.test.ts` 证明实时路径没变）；commit `"agents: shared codex item → message conversion"`

### Task 3: Codex 来源

**Files:**
- Create: `server/src/library/types.ts`、`server/src/library/lazy-rpc.ts`、`server/src/library/codex-source.ts`
- Modify: `server/src/agents/__mocks__/codex-server.mjs`（加 `thread/list`、`thread/turns/list`、`thread/name/set`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/fork`，内存里放 3 个线程，其中 1 个 `source:'subAgent'`、`parentThreadId` 指向另一个，1 个有 250 个 turn）
- Test: `server/src/library/codex-source.test.ts`

**Interfaces:**
- Consumes: `libraryId/parseLibraryId`（Task 1）、`codexTurnsToMessages`（Task 2）、`JsonRpcProcess`（`agents/jsonrpc.ts`）、`AgentRegistry.launch('codex')`（给出 command/args/env；args 里的 `app-server` 保留）。
- Produces（`types.ts`）：
  ```ts
  export interface SessionSource {
    kind: AgentKind;
    caps: SourceCaps;
    status(): Promise<SourceStatus>;
    list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }>;
    read(nativeId: string, o: { cursor?: string; limit: number }): Promise<{ messages: any[]; next?: string }>;
    rename?(nativeId: string, title: string): Promise<void>;
    archive?(nativeId: string, archived: boolean): Promise<void>;
    remove?(nativeId: string): Promise<void>;
    fork?(nativeId: string): Promise<string>;           // 返回新的原生 id
    exportAll?(nativeId: string): Promise<unknown>;     // 删除前备份
    close(): Promise<void>;
  }
  ```
  - `lazy-rpc.ts`：`export class LazyRpc { constructor(spawn: () => JsonRpcProcess, init: (rpc) => Promise<void>, idleMs = 300_000); request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>; close(): Promise<void> }` —— 首次请求时起进程并跑 `init`（`initialize` + `initialized`），每次请求重置闲置计时，进程退出后下次请求重起；并发首次请求只起一个进程。
  - `export class CodexSource implements SessionSource`，构造 `new CodexSource(launch: { command: string; args: string[]; env: Record<string,string> })`。
  - `list`：`thread/list { sortKey:'updated_at', sortDirection:'desc', limit, cursor, archived: o.archived ?? false, sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther'] }`。映射：`sessionId=libraryId('codex', t.id)`、`title = t.name || t.preview.slice(0,80)`、`firstPrompt=t.preview`、`cwd=t.cwd`、`lastModified=t.updatedAt*1000`、`createdAt=t.createdAt*1000`、`source = t.source` 的类型名、`parentId = t.parentThreadId ? libraryId('codex', t.parentThreadId) : undefined`、`gitBranch=t.gitInfo?.branch`、`agent:'codex'`、`caps`。
  - `read`：`thread/turns/list { threadId, itemsView:'full', sortDirection:'desc', limit: o.limit (默认 20 turn), cursor }`，把本页 turn 反转成时间正序后 `codexTurnsToMessages`；`next = nextCursor ?? undefined`（更早的轮次）。
  - `caps = { resume:true, rename:true, archive:true, delete:true, fork:true }`；`rename→thread/name/set`、`archive→thread/archive|thread/unarchive`、`remove→thread/delete`、`fork→thread/fork {threadId, excludeTurns:true}` 返回 `thread.id`、`exportAll` = 翻完所有页的 turns 数组。
  - `status`：`launch` 的可执行文件解析失败或 `initialize` 失败 → `{installed:false|true, enabled:false, disabledReason}`；`thread/list` 返回 JSON-RPC `-32601` → `enabled:false, disabledReason:'Codex 版本不支持 thread/list，请升级'`。

- [ ] **Step 1: 扩 mock**，写失败测试（用 `process.execPath` + mock 路径作为 launch）：
  - `list({limit:2})` 返回 2 条、`next` 存在；再用 `next` 取到第 3 条；子代理线程的 `parentId` 等于父线程的 library id。
  - `read(long, {limit:20})` 返回的 `result` 条数 = 20、`next` 存在；用 `next` 再取得到更早的 20 轮（Review Focus 4）。
  - `rename` 后 `list` 里标题变了；`archive(true)` 后默认 `list` 不再含它、`list({archived:true})` 含它；`fork` 返回新 id 且 `list` 多一条。
  - launch 指向不存在的可执行文件：`status().enabled===false` 且 `list()` 返回 `{items:[]}`、不抛（Review Focus 1）。
  - `LazyRpc` 闲置：`idleMs=50` 时两次请求间隔 120ms，mock 进程被重启过一次（mock 在 `initialize` 时自增计数，经一个 `debug/initCount` 方法可读）。
- [ ] **Step 2:** `npm test -w server -- codex-source` → FAIL
- [ ] **Step 3:** 实现 `types.ts`、`lazy-rpc.ts`、`codex-source.ts`。
- [ ] **Step 4:** 测试通过；commit `"library: codex source over app-server thread API"`

### Task 4: OpenCode 来源

**Files:**
- Create: `server/src/library/opencode-source.ts`、`server/src/library/opencode-convert.ts`
- Create: `server/src/library/__fixtures__/opencode-messages.json`（本机 `GET /session/{id}/message` 真实响应脱敏：含 text、reasoning、tool 类 part 各一）
- Modify: `server/src/agents/types.ts`（`AGENT_DEFS` 加 `{ kind:'opencode', name:'OpenCode', icon:'opencode', protocol:'acp', command:'opencode', args:['acp'], versionArgs:['--version'], install:'npm i -g opencode-ai', login:'opencode auth login', models: [], docs:'https://opencode.ai' }`）、`web/src/ui/icons.tsx`（加 `opencode` 图标，手写 24×24 路径，风格同表内其它 agent 图标）
- Test: `server/src/library/opencode-source.test.ts`

**Interfaces:**
- Consumes: `SessionSource`（Task 3）、`libraryId`、`MessageSynth`、`mapToolName`（`agents/normalize.ts`）。
- Produces:
  - `export function opencodeToMessages(sessionId: string, msgs: { info: any; parts: any[] }[]): any[]` —— `info.role==='user'` → `synth.user(text parts 拼接)`；assistant：每条 `beginTurn`，`text` part → `synth.text`，`reasoning` → `synth.delta('thinking')`，`tool` part → `synth.toolUse(part.callID, mapToolName(undefined, part.tool, part), part.state?.input ?? {})` + `synth.toolResult(part.callID, String(part.state?.output ?? part.state?.error ?? ''), part.state?.status==='error')`，末尾 `endTurn`；过滤 `stream_event`。
  - `export class OpenCodeSource implements SessionSource`，构造 `new OpenCodeSource(launch: { command: string; env: Record<string,string> }, opts?: { baseUrl?: string })`（测试传 `baseUrl` 直连假服务，不起进程）。
  - 起服务：`<command> serve --port 0 --hostname 127.0.0.1`，从 stdout 正则 `/https?:\/\/127\.0\.0\.1:(\d+)/` 取端口（30 s 超时）；闲置 5 分钟 kill；Windows 用 `resolveSpawn` 解析 `.cmd` 垫片。
  - 能力探测：启动后 `GET /doc`，检查 `paths['/session/{id}']` 是否有 `patch`（rename）/`delete`；`caps.rename/delete` 按结果；`archive:false, fork:false, resume:true`（经 ACP）。
  - `list`：`GET /session`，按 `time.updated` 倒序，本地分页（游标 = 偏移量字符串）；映射 `sessionId=libraryId('opencode', s.id)`、`title=s.title`、`cwd=s.directory`、`lastModified=s.time.updated`、`createdAt=s.time.created`、`agent:'opencode'`、`source:'opencode'`、`parentId = s.parentID ? libraryId('opencode', s.parentID) : undefined`。
  - `read`：`GET /session/{id}/message`，一次取全量后按 20 条用户消息为一页从尾部往前切，`next` = 偏移。
  - `rename` → `PATCH /session/{id}` body `{title}`；`remove` → `DELETE /session/{id}`；`exportAll` → `GET /session/{id}/message` 原样。
- [ ] **Step 1: 写失败测试**（用 `node:http` 在测试里起假服务，路由 `/doc`、`/session`、`/session/{id}/message`、PATCH、DELETE）：`list` 映射正确、按更新时间倒序；`read` 用夹具产出 user → assistant(tool_use/ tool_result) → result；`/doc` 不含 delete 时 `caps.delete===false` 且没有 `remove` 调用路径；`command` 不存在时 `status().enabled===false`、`list()` 返回空（Review Focus 1）。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** 通过
- [ ] **Step 5: 真机核对**：本机起 `opencode acp`，发 `initialize`，记录 `agentCapabilities.loadSession` 的值写进 `opencode-source.ts` 顶部注释；若为 false，`caps.resume=false`（续聊走交接）。commit `"library: opencode source over opencode serve"`

### Task 5: Claude 来源与 ACP list 来源

**Files:**
- Create: `server/src/library/claude-source.ts`、`server/src/library/acp-source.ts`
- Modify: `server/src/agents/__mocks__/acp-agent.mjs`（环境变量 `MOCK_ACP_LIST=1` 时 `initialize` 返回 `agentCapabilities.sessionCapabilities.list:{}` 并实现 `session/list` 返回 2 条 `{sessionId, cwd, title, updatedAt}`）
- Test: `server/src/library/claude-source.test.ts`、`server/src/library/acp-source.test.ts`

**Interfaces:**
- Consumes: `SessionsService`（`sessions/service.ts`：`list`、`transcript`、`rename`、`remove`）、`AgentRegistry.launch`、`JsonRpcProcess`。
- Produces:
  - `export class ClaudeSource implements SessionSource` 包装 `SessionsService`：`list` 一次返回全部（无游标）、`read` 返回整份 transcript（`next` 永远 undefined）、`caps={resume:true,rename:true,archive:false,delete:true,fork:true}`（归档仍用 meta），`sessionId` 保持原 UUID。
  - `export class AcpListSource implements SessionSource`，构造 `(kind: AgentKind, launch)`；`status()` 起一次进程 `initialize` 看 `agentCapabilities.sessionCapabilities?.list`，没有 → `enabled:false, disabledReason:'该 agent 不支持会话列表'` 并关进程；有 → `list` 调 `session/list {cursor}`；`read` 不支持（返回空并 `next` undefined），`caps={resume: !!loadSession, rename:false, archive:false, delete:false, fork:false}`。
- [ ] **Step 1: 写失败测试**：`ClaudeSource` 用临时 `HOME` 下放一个最小 jsonl，`list` 能看到、`read` 返回其消息；`AcpListSource` 对 `MOCK_ACP_LIST=1` 的 mock 列出 2 条（id 为 `acp_e2e-…`），对普通 mock `status().enabled===false`。
- [ ] **Step 2–4:** FAIL → 实现 → 通过；commit `"library: claude source and ACP session/list source"`

### Task 6: 引用与交接从库取历史

**Files:**
- Create: `server/src/library/briefing.ts`
- Modify: `server/src/session/swap.ts`（`swapAgent` 在 canonical 为空时用库历史播种）、`server/src/ws/hub.ts`（`session.send` 展开引用标记）
- Test: `server/src/library/briefing.test.ts`

**Interfaces:**
- Consumes: `renderBriefing`（`session/handoff.ts`）、`CanonicalLog.observe`、`LibraryService.readAll(id)`（Task 8 产出；本任务先以参数注入 `readAll: (id: string) => Promise<any[]>`）。
- Produces:
  - 引用标记格式（前端 Task 10 插入、服务端展开）：`<session-ref id="<libraryId>" title="<转义后的标题>" />`。
  - `export async function expandSessionRefs(text: string, readAll: (id: string) => Promise<any[]>): Promise<string>` —— 每个标记替换为 `<referenced-session id=… title=…>\n${renderBriefing(...)}\n</referenced-session>`；读取失败替换为 `<referenced-session id=… error="无法读取：原因" />`（不静默丢）。
  - `export async function seedCanonical(canonical: CanonicalLog, sessionId: string, messages: any[]): Promise<void>` —— 把库历史逐条 `observe`，供 `swapAgent` 在 canonical 为空时调用。
- [ ] **Step 1: 写失败测试**：含两个引用标记的文本，一个 `readAll` 返回消息、一个抛错 → 输出含第一个的简报文本（含其用户消息原文片段）和第二个的 `error="无法读取`；不含标记的文本原样返回。
- [ ] **Step 2–4:** FAIL → 实现并接入 `swap.ts` / hub（hub 用 `library.readAll`，Task 8 后接通；本任务先让 hub 通过 `this.s.library?.readAll` 可选调用）→ 通过
- [ ] **Step 5:** commit `"library: session references and handoff seeded from native history"`

### Task 7: 搜索索引

**Files:**
- Create: `server/src/library/index-db.ts`
- Test: `server/src/library/index-db.test.ts`

**Interfaces:**
- Produces:
  - `export class LibraryIndex`，构造 `new LibraryIndex(file = path.join(dataDir(), 'library.db'))`：
    - `upsert(s: SessionSummary, text: string): void`（`text` 截到 20 000 字符）
    - `indexedAt(id: string): number | undefined`（返回上次写入时该会话的 `lastModified`）
    - `remove(id: string): void`
    - `search(q: string, o: { limit: number; agent?: AgentKind; cwdLike?: string }): { id: string; snippet: string }[]` —— 非中文走 FTS5 `MATCH`（片段用 `snippet()`），中文走 `LIKE` 并手工截取命中处前后 40 字符；`agent` / `cwdLike` 是 SQL 过滤。
    - `static parseQuery(raw: string): { q: string; agent?: AgentKind; cwdLike?: string }` —— 识别 `agent:<kind>`、`in:<片段>`。
  - 损坏处理：打开失败 → 把文件改名为 `library.db.corrupt-<ts>` 后新建（同 `meta/store.ts` 的做法）。
- [ ] **Step 1: 写失败测试**：upsert 三条（英文正文、中文正文「把最小化窗口改成托盘」、不同 agent）；`search('托盘')` 命中中文那条且 snippet 含「托盘」（Review Focus 5）；`search('refactor', {agent:'codex'})` 只返回 codex 的；`parseQuery('agent:codex in:claude-web 登录')` → `{q:'登录', agent:'codex', cwdLike:'claude-web'}`；同 id 第二次 upsert 更新 `indexedAt`（Review Focus 3）；把库文件写成垃圾字节后 new → 能用且出现 `.corrupt-` 备份。
- [ ] **Step 2–4:** FAIL → 实现 → 通过；commit `"library: fts5 search index"`

### Task 8: LibraryService 与 hub 接线

**Files:**
- Create: `server/src/library/service.ts`
- Modify: `server/src/ws/hub.ts`（`Services` 加 `library`；`sessions.list`、`sessions.search`、`transcript.load`、`session.open`、新 `library.*`）、`server/src/index.ts`（构造 `LibraryService`，注册来源，关停时 `close()`）
- Test: `server/src/library/service.test.ts`

**Interfaces:**
- Consumes: Task 1–7 全部；`AgentTranscripts`（`head`、`create`、`patchHead`、`list`）；`MetaStore`（存 `settings['library.disabled']: AgentKind[]`）。
- Produces:
  - `export class LibraryService extends EventEmitter`（事件 `'changed'`），构造 `(sources: SessionSource[], index: LibraryIndex, transcripts: AgentTranscripts, meta: MetaStore)`：
    - `list(): Promise<SessionSummary[]>` —— 并发拉所有启用来源（各自翻完页，Codex 每页 100），合并 `transcripts.list()` 里在 claude-web 开的外部会话；**去重**：外部会话头部 `nativeSessionId` 与某导入项原生 id 相同 → 保留 claude-web 那条的 `sessionId`，但 `lastModified` 取两者较大、`caps` 取来源的；带 `parentId` 的项不单独出现，父项 `childCount` 计数；结果缓存 60 s，`invalidate()` 清缓存；来源失败 → 用上次缓存并在 `status` 记 `error`。
    - `read(id, cursor?, limit?)` → 按 `parseLibraryId` 分到来源；claude-web 自开且非导入的外部会话仍读 `transcripts.load`。
    - `readAll(id): Promise<any[]>` —— 翻完全部页、按时间正序拼接。
    - `sources(): Promise<SourceStatus[]>`（含 `count`、`indexedAt`；未加入的来源只返回轻量检测结果，不调用其 `status()`）；`join(kind, joined)`：加入 → 启用并立即 `invalidate()` + 触发索引；移出 → `source.close()`、从缓存与 `index` 删除该来源的所有 id；`dismiss(kind)`；`detect(): Promise<AgentKind[]>` 用 `AgentRegistry` 探测结果（`agents.list`，60 s 缓存）+ 数据目录存在性（codex：`~/.codex/sessions`；opencode：`~/.local/share/opencode`）得出「检测到但未加入、未 dismiss」的列表，启动时与每次 `agents.list refresh` 后 emit `'discovered'`。
    - **只有已加入的来源**参与 `list / read / search / refreshIndex`。
    - `rename / archive / fork`：按 caps 分派，不支持 → 抛 `Error('该来源不支持此操作')`；完成后 `invalidate()` 并 emit `'changed'`。
    - `remove(ids)`：逐个 `exportAll` → 写 `library-trash/<id>.json` → 成功后才调 `remove` 并 `index.remove`；导出或写文件失败 → 记入 `failed`、**不删**（Review Focus 2）；启动时清理 30 天前的 trash 文件。
    - `prepareResume(id): Promise<{ agent: AgentKind; cwd: string }>` —— 导入会话在 `transcripts` 里还没有头部时 `create({ sessionId:id, agent, cwd, title, createdAt, nativeSessionId, imported:true })`（`Head` 类型加可选 `imported?: boolean`），使现有 `CodexDriver` / `AcpDriver` 的 resume 分支直接生效。
    - `refreshIndex(): Promise<void>` —— 遍历 `list()`，`index.indexedAt(id) !== lastModified` 的才 `readAll` 取文本（user + assistant 文本块拼接）再 `upsert`；串行、每条之间 `await setImmediate`，首次全量不阻塞请求；启动 10 s 后跑一次，之后 `'changed'` 与 `chokidar` 监听（`~/.claude/projects`、`~/.codex/sessions`，去抖 5 s）触发。
    - `search(raw, limit)` → `LibraryIndex.parseQuery` + `index.search`，再按 id 回填 `SessionSummary`；索引还空时退回旧的 `SessionsService.search`。
  - hub：`library.discovered` 事件转发给客户端；`sessions.list` → `library.list()`（去掉 500 截断，`req.limit` 仍可截）；`sessions.search` → `library.search`；`transcript.load`：头部 `imported` 或 id 带已知前缀 → `library.read(id)` 首页，否则原逻辑；`library.read` → 分页；`session.open` 带 `sessionId` 且 `parseLibraryId` 非 claude → 先 `prepareResume` 再 `pool.open({...params, agent})`；`library.*` 请求一一转发；`library.changed` 事件广播。
- [ ] **Step 1: 写失败测试**（假 `SessionSource` 两个 + 临时目录）：未加入的来源不出现在 `list()`、其 `list/status` 从未被调用；`join(kind,true)` 后出现；`join(kind,false)` 后消失且 `close()` 被调用、索引里它的条目被删；`detect()` 只返回已安装、未加入、未 dismiss 的来源；合并排序；外部会话与导入项去重成一条；子项被折叠、父项 `childCount===1`；一个来源 `list` 抛错时另一个照常、`sources()` 带 `error`；`remove` 时 `exportAll` 抛错 → `failed` 含它且假来源的 `remove` 未被调用；`prepareResume` 生成的头部 `nativeSessionId` 正确且再次调用不重复创建；`refreshIndex` 对 `lastModified` 没变的会话不调用 `read`。
- [ ] **Step 2–4:** FAIL → 实现 → 通过；`npm test -w server`、`npx tsc --noEmit -p server` 全过
- [ ] **Step 5:** commit `"library: service, dedupe, backups, hub wiring"`

### Task 9: 前端数据层

**Files:**
- Modify: `web/src/store/index.ts`（`refreshSessions` 去掉 `limit:500`；新增 `librarySources: SourceStatus[]`、`sourceFilter: AgentKind | 'all'`、`loadLibrarySources()`、`libraryOp(kind, payload)`；`library.changed` 事件 → `refreshSessions()`；`loadHistory` 对导入会话记录 `historyCursor` 并新增 `loadOlder(sessionId)` 调 `library.read` 把更早的消息**前置**）
- Modify: `web/src/model/conversation.ts`（新增 `prependTranscript(c, msgs)`：对 `msgs` 建一个新 conversation 再把原 items 接在后面，保证去重与合并规则不变）
- Test: `web/src/model/conversation.test.ts`（加用例）、`web/src/store/store.test.ts`（加用例）

**Interfaces:**
- Consumes: Task 1 / 8 的请求与事件。
- Produces: `useStore` 上 `sourceFilter`、`setSourceFilter(k)`、`librarySources`、`loadOlder(id): Promise<boolean>`（还有更早的返回 true）、`libraryOp(op: 'rename'|'archive'|'delete'|'fork', payload): Promise<any>`；`prependTranscript(c: Conversation, msgs: any[]): void`。
- [ ] **Step 1: 写失败测试**：`prependTranscript` 后 items 顺序为「旧消息在前」，且把同一 `message.id` 分两页给出时只合并成一个 item；store：`loadOlder` 在 `next` 为空时返回 false 且不再请求；`library.changed` 事件触发一次 `sessions.list` 请求。
- [ ] **Step 2–4:** FAIL → 实现 → 通过（`npm test -w web`）；commit `"web: library data layer, older-history paging"`

### Task 10: 侧栏、会话菜单、引用、命令面板

**Files:**
- Modify: `web/src/features/sidebar/Sidebar.tsx`、`web/src/features/workbench/tiles/ChatTile.tsx`（会话头菜单）、`web/src/features/composer/Composer.tsx`（引用芯片）、`web/src/features/chat/ChatView.tsx`（顶部「加载更早」）、`web/src/features/palette/CommandPalette.tsx`、`web/src/styles.css`
- Test: `web/src/features/sidebar/filter.test.ts`（纯函数）

**Interfaces:**
- Consumes: Task 9 的 store 字段。
- Produces:
  - `web/src/features/sidebar/filter.ts`：`export function filterSessions(all: SessionSummary[], o: { source: AgentKind | 'all'; query: string; showArchived: boolean; meta: Record<string, SessionMeta> }): SessionSummary[]`（排除带 `parentId` 的；`archived` 字段或 meta 归档都算归档）与 `export function sourceCounts(all): Record<string, number>`。
  - 发现提示：收到 `library.discovered`（或 `librarySources` 里有 `detected && !joined && !dismissed`）时，侧栏顶部出现一条提示「检测到本机有 Codex、OpenCode 的会话，要加入会话库吗？」，每个来源一个「加入」按钮 + 整条「以后再说」（调 `library.dismiss`）；不加入不影响任何现有功能。
  - 侧栏：筛选框上方一排来源筛选（全部 / 各 `librarySources` 里启用且 `count>0` 的来源，带数量）；每组先显示 25 条，末尾「展开更多（剩 N）」每次 +50（替代原来跳命令面板的提示）；行上 `childCount>0` 时显示「+N 子任务」；Ctrl/Shift 点击多选（已有 ctrl-click 行为保留为「新标签打开」时改用复选模式开关按钮进入多选），多选工具条：归档 / 删除（按所有选中项 `caps` 的交集显示）。
  - 会话右键菜单与会话头菜单：重命名（`caps.rename`）、归档（`caps.archive` 或 Claude 的 meta 归档）、删除（`caps.delete`，`dlg.confirm` 两次，第二次文案「将先备份到 ~/.claude-web/library-trash，再从 <来源> 删除」）、分叉（`caps.fork`）、交给其它 agent（现有 `session.switchAgent`）、在原生 CLI 打开（开 `term` tile，`cmd`：codex → `codex resume <原生id>`，opencode → `opencode --session <原生id>`，claude → `claude --resume <id>`）、引用到输入框。
  - 引用芯片：Composer 插入 `<session-ref id="…" title="…" />` 标记，渲染时用现有 `decodeAttachments` 同样的方式解成芯片（新增一种 kind `session`）；被引用会话在 `sessions` 里不存在 → 芯片红色、`title` 提示「会话已不存在」。
  - 导入会话的对话顶部：`loadOlder` 为 true 时显示「加载更早的记录」按钮；`transcript.load` / `library.read` 失败时对话区显示错误原因与「重试」按钮（不留空白）。
  - 命令面板搜索结果显示 agent 图标 + 目录 basename + snippet；输入以 `agent:` / `in:` 开头时同样走服务端搜索。
- [ ] **Step 1: 写失败测试** `filter.test.ts`：`parentId` 项被排除；`source:'codex'` 只留 codex；`query` 同时匹配标题与 firstPrompt；归档项在 `showArchived:false` 时排除；`sourceCounts` 不计子项。
- [ ] **Step 2–4:** FAIL → 实现 `filter.ts` 与界面 → `npm test -w web`、`npx tsc --noEmit -p web`、`npm run build -w web` 通过
- [ ] **Step 5: 截图核对**（`scripts/shot.cjs`，mock 数据）：侧栏来源筛选、展开更多、多选工具条、删除确认第二步文案、引用芯片、加载更早按钮各一张，确认无错位；commit `"web: library sidebar, menus, references, palette"`

### Task 11: 设置 → 会话库

**Files:**
- Create: `web/src/features/settings/LibrarySection.tsx`
- Modify: `web/src/features/settings/SettingsModal.tsx`（分区表加 `{ id:'library', l:'会话库', ic:'archive', keywords:'session library codex opencode 导入 索引 会话库', body: () => <LibrarySection /> }`，放在「CLI Agents」之前）

**Interfaces:**
- Consumes: `library.sources`、`library.join`、`library.reindex`。
- Produces: 列出所有检测到的 agent（含未加入的），每行：图标、名称、版本、是否已加入、会话数（仅已加入）、上次索引时间、状态（未安装 / 检测到未加入 / 已加入 / 不可用：原因）、「加入 / 移出」开关（移出时说明「只是不在这里显示，不会删除 agent 自己的记录」）；底部「重建索引」按钮（调用后显示进行中，`library.changed` 后刷新）。
- [ ] **Step 1:** 实现；**Step 2:** `npx tsc --noEmit -p web`、`npm run build -w web` 通过，截一张图核对；**Step 3:** commit `"settings: session library section"`

### Task 12: 端到端、CI、文档、真机验证

**Files:**
- Create: `server/ws-phase13.mjs`
- Modify: `scripts/e2e.mjs`（默认 phases 加 `'13'`）、`.github/workflows/ci.yml`（e2e 行加 `13`）、`CLAUDE.md`（新增「统一会话库（2026-09-27）」一节）、`README.md`（上手教程加一节「本机其它 agent 的会话」）

**Interfaces:**
- Consumes: 全部前序任务。
- [ ] **Step 1: 写 `ws-phase13.mjs`**：通过 `agents.set` 把 codex 的 command 指到 mock `codex-server.mjs`、加一个 `MOCK_ACP_LIST=1` 的 ACP agent；断言：加入前 `sessions.list` 不含 `codex-` 项且收到 `library.discovered` 含 codex；`library.join` codex 与该 ACP agent 之后：`sessions.list` 含 `codex-` 与 `acp_` 前缀项且子线程被折叠；`library.read` 分页有 `next`；`sessions.search` 命中 mock 线程正文里的词；`library.rename` 生效；`library.delete` 后 `library-trash` 里有备份文件、列表里没有了；`session.open` 一个 `codex-` 会话后发一条消息，mock 收到的 `thread/resume` 的 `threadId` 等于原生 id；`library.sources` 含 codex 与 acp 两项且 `enabled`。
- [ ] **Step 2:** `npm run build:all && node scripts/e2e.mjs 13` 通过；`node scripts/e2e.mjs` 全部通过。
- [ ] **Step 3: 真机只读验证**（不跑 rename/archive/delete）：独立 `CLAUDE_WEB_DIR` 起 server，确认 Codex 条数与 `find ~/.codex/sessions -name '*.jsonl' | wc -l` 同一量级、OpenCode 11 条；打开一个真实 Codex 会话能看到工具卡片；首次索引完成后搜一个已知中文词命中；对一个**新建的**测试 Codex 线程做 rename / archive / delete 并确认 trash 备份存在。
- [ ] **Step 4:** 写 CLAUDE.md / README 小节（来源与能力表、id 规则、删除备份位置、真机验证的坑）；`npm run typecheck && npm test` 通过；commit `"library: e2e phase13, CI, docs"`；推送后确认 CI 三平台绿。
