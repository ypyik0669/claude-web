# 统一会话库（2026-09-27）

- **一个入口**：`server/src/library/service.ts` 的 `LibraryService` 把 Claude + 各 agent 自己的会话记录合成一个列表 / 读取 / 搜索面；`sessions.list`、`sessions.search`、`transcript.load`、`session.open` 都走它。来源实现 `SessionSource`（`library/types.ts`），每个来源一个文件：

  | 来源 | 列表 / 读取 | rename | archive | delete | fork | 续聊 |
  | --- | --- | --- | --- | --- | --- | --- |
  | Claude（`claude-source.ts`） | SDK `listSessions` / transcript | ✓（SDK） | ✓（只记在 meta.json，Claude Code 没有归档标记） | ✓ | ✓（SDK `forkSession`） | ✓ |
  | Codex（`codex-source.ts`） | `codex app-server` 的 `thread/list`、`thread/turns/list` | `thread/name/set` | `thread/archive`/`unarchive` | `thread/delete` | `thread/fork` | `thread/resume` |
  | OpenCode（`opencode-source.ts`） | `opencode serve` 的 `GET /project` + `GET /session` + `/session/:id/message` | — | — | CLI `opencode session delete` | — | ACP `session/load` |
  | ACP agent（`acp-source.ts`） | 只有声明 `sessionCapabilities.list` 的才能列（`session/list`），无 read | — | — | — | — | 看 `loadSession` |

  能力只来自**官方接口**；没有就是只读，不改 agent 的数据文件。库专用后台进程（app-server / `opencode serve`）每来源一个、`LazyRpc` 闲置 5 分钟退出，不和会话进程共用。
- **id 规则**：Claude 保持原 UUID；其它 `<agent>-<原生 id>`（`codex-…`、`opencode-…`、`gemini-|qwen-|kimi-…`），自定义 ACP agent `acp:<name>` → `acp_<name 里的 - 转成 ~>-<原生 id>`。不含冒号。前缀表和 `parseLibraryId` 在 `protocol.ts`（web 共用）。续聊时 `prepareResume()` 给它建一个 `imported:true` 的头指向原生 id，驱动走原生 resume，新轮次写回 agent 自己的记录。
- **加入是可选的**：除 Claude 外默认不加入；检测只看 `AgentRegistry` 版本探测 + 数据目录（`~/.codex/sessions`、`~/.local/share/opencode`、`%LOCALAPPDATA%\opencode`），**不启动任何进程**。`library.discovered {kinds}` 在连接时和 `agents.list {refresh:true}` 后推送，侧栏底部出一行轻提示「把 X 里的对话也列在这里？ · 列出来 ×」（× = 以后再说；入门清单完成或关掉之后、或清单出现满 3 天后才出，见「界面改版 阶段 4」）。状态存 meta `settings['library.joined' | 'library.dismissed']`。移出 = 关掉该来源进程 + 从列表和索引里去掉（agent 数据不动）。
- **删除先备份**：完整历史导出到 `<dataDir>/library-trash/<id>.json`（`dataDir()` 跟随 `CLAUDE_WEB_DIR`），写成功才调来源的 delete，导出失败就不删；启动时清理 30 天前的备份。界面二次确认，批量默认归档。
- **索引**：`<dataDir>/library.db`（FTS5），每会话正文摘录上限 20 000 字，中文走 LIKE（同 memory 的 `hasCjk`）；首轮索引完成前搜索退回旧的 transcript 扫描。`agent:codex`、`in:<目录片段>` 是查询前缀。
  - **索引不能跟着正在写的对话反复重读**（2026-09-29 实测：空闲的 3090 server 常驻 ~16% CPU、库专用的 `codex app-server` ~30%）：Claude 的监听器每次 transcript 追加都触发一次索引，而每次都整份重读（进行中的对话 60–70 MB），索引里的 `list()` 还会让过了 TTL 的来源在后台重列（Codex 一次 ~760 个线程）。现在：① 索引用 `list({revalidate:false})`，年龄不触发重列，只有监听器（soft → `stale`）/ 我们自己的改动（`dirty`）才会；有监听器的来源（Codex）TTL 10 分钟（`WATCHED_LIST_TTL_MS`），其它 60 秒；② 还在写（3 分钟内变过）的 Claude 对话，索引正文已存满 20 000 字（按 UTF-16 算，和截断同一个单位——SQLite 的 `LENGTH` 按码点，一个 emoji 就永远「不满」）时只 `touch()` 摘要（标题），**不动 `lastModified`**，安静 3 分钟后重读一次：索引读的是 `getSessionMessages` 沿 `parentUuid` 走出的链，压缩（`compact_boundary` 的 `parentUuid:null`，> 5 MB 时 SDK 只读最后一个边界之后）和 CLI 里的回退都会换掉开头，文件只追加不代表正文开头不变；③ 其它还在写的对话 3 分钟内最多重读一次（`INDEX_LIVE_MS`），跳过的会排一次补跑，补跑用 `scheduleIndex(ms, {unlessSooner:true})`，不会把已经排好的更早一次（监听器的 5 s）往后推。实测一个 62 MB、每 7 秒追加一次的对话：server CPU 7.9 s/分钟 → 0.2 s/分钟。
- **踩过的坑**：
  - **来源遇到暂时性失败必须 throw**（不能返回空），否则 service 会以为「没有会话」、把索引和缓存清掉；只有「没装」/「版本不支持」才返回空。service 保留上次缓存并在 `SourceStatus.error` 里带出错误。
  - **Codex `Thread.source` 不只是字符串**：`"cli"|"vscode"|"exec"|"appServer"|{custom}|{subAgent:…}`，`subAgent` 里又是 `"review"|"compact"|{thread_spawn:{parent_thread_id,…}}|…`。响应是 `{data, nextCursor, backwardsCursor}`（不是 `threads` / `turns`），以 `codex app-server generate-ts` 为准。
  - **Codex `thread/list` 默认只返回当前 provider 的线程**：真机上 690 个里只列出 399 个；要传 `modelProviders: []`。而且带 `[]` 时子代理线程的 `parentThreadId` 是 null，父线程只在 `source.subAgent.thread_spawn.parent_thread_id` 里（`parentOf()` 兜底，否则 277 个子线程平铺在顶层）。
  - **OpenCode 的 `/doc` 只写了 2 个路径**（`/auth`、`/log`），能力没法从 OpenAPI 探测，改为解析 `opencode session --help`（Windows 冷启动约 10 秒，超时 60 秒、失败下次重试）。**`GET /session` 只返回 serve 自己 cwd 所在项目的会话**（从 claude-web 仓库起是 0 条），要先 `GET /project` 再逐个带 `x-opencode-directory`（URI 编码）头去取。
  - **Windows 上 Python 文本模式写文件会把 LF 变成 CRLF**：仓库有 `.gitattributes`（`eol=lf`），改文件用 Edit/Write 或二进制写；提交前 `git diff -w --ignore-cr-at-eol --stat` 应该和 `git diff --stat` 一样。
  - **大目录树别用 chokidar 监听**（2026-09-29 实测，桌面版从开始菜单点开后一分多钟没有窗口的根因）：chokidar 在 Windows 上对**每个文件**单独 `fs.watch`，库对 `~/.claude/projects` 深度 4 的监听是 4468 个文件 + 168 个目录（Codex 再加 720 个），server 开始监听后事件循环整整堵了 ~18 s（CPU profile 里 `createFsWatchInstance` → 原生 `start`），打包版里连着 Codex 列表一起是 ~65 s，而桌面窗口要等页面画出来才显示。现在 `SessionService` 和库的监听都走 `runtime/watch-tree.ts` 的 `watchTree(dir, onChange)`：一个 `fs.watch(dir, {recursive:true})` 句柄（Windows ReadDirectoryChangesW / macOS FSEvents / Linux 按目录 inotify，Node ≥ 20），回调拿到相对路径；目录还不存在就每 30 s 找一次、出现后再挂；句柄出错（整棵树被删，Windows 上是 EPERM）回到寻找。`SessionService` 只认 `transcriptEvent(rel)`：项目目录、项目下的 `<id>.jsonl` / `<id>` 目录（子代理日志、tool-results、memory 不算）。同样条件下 profile 里 55 s 内零卡顿。chokidar 只留给小目标（git 的 HEAD / index / refs、编辑器里打开的单个文件）。
- `server/ws-phase13.mjs`：mock Codex（`agents/__mocks__/codex-server.mjs`，`CW_MOCK_RPC_LOG` 记录收到的请求）+ `MOCK_ACP_LIST=1` 的 mock ACP，端到端验证加入前不列、加入后列出并折叠子线程、分页读、搜索、改名、删除备份、`codex-` 会话续聊走 `thread/resume`、`library.sources` 状态。
- 真机验证（2026-09-27，只读 + 一个自建的测试线程）：Codex 717 条（`~/.codex/sessions` 721 个 jsonl + archived 42，部分没有线程记录）、OpenCode 11 条、Claude 119 条；首轮全量索引约 150 秒（约 850 个会话），之后中文搜索 ~150 ms。测真机时用临时 `CLAUDE_WEB_DIR` 起一个独立 server，别碰用户自己的 `~/.claude-web`。

## Codex 的「分页存储」线程（2026-10-16 用户报告）

另一台电脑上打开 Codex 对话报「加载历史失败：paginated_threads is not supported yet」。新版 Codex（桌面版自己会更新）把线程存成 `history_mode = 'paginated'`（`~/.codex/state_5.sqlite` 的 `threads` 表；本机 766 条都是），旧一些的 `codex` 命令行认得这种格式但读不了，**分页读和整条读都拒**，所以不能走 `NO_PAGING` 那条 `thread/read` 退路（以前退过去，用户看到的就是 Codex 的原话）。

- `codex-source.ts`：`PAGINATED` 命中时 `read()` / `exportAll()` 换「Codex 桌面版自带的 codex」再读一次（`desktopCodexBin()`：Windows `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe` 取最新的，macOS `Codex.app/Contents/Resources/codex`；`newerRpc()` 按 command+args+env 判断是不是同一个，懒启动、和主进程一起关）。没有桌面版就报一句能照做的话（更新 Codex 命令行，或在 设置 → Agents 把命令换成桌面版那个）。
- 本机复现不了原话：0.159.2 / 0.162.1（npm 包解到临时目录，`CODEX_HOME` 指到 `~/.codex` 的**拷贝**）和桌面版 0.162-alpha 读本机的分页线程都正常（turns/list full / summary / notLoaded、`thread/read includeTurns`、`thread/items/list` 全通）；原话在二进制里只出现在 `thread_processor.rs` 的 fork / resume 一带。所以「旧命令行 + 新桌面版写的线程」是推断，测试用 mock 的 `MOCK_CODEX_NO_PAGINATED=1`（分页读和整条读都拒）覆盖。
- 拷贝的 `CODEX_HOME` 上 `thread/resume` / `thread/fork` 测不了：线程记着当时的 model provider（`cwgw`，我们的网关）、rollout 路径指向真的 `~/.codex`（「must be in Codex home directory」）。
- **SDK 的 `listSessions` 会整个漏掉第一句很长的对话**（2026-10-17 实测：头 64 KB 里没有可读的第一句、尾部又没有标题类的行）：`sessions/unlisted.ts`
  扫目录补上，进程结束时补一行 `last-prompt` 让别的应用（Mirasim）也列得出。详见「照官方桌面版录屏改的界面」第二轮。

## 本机发现与 Cursor 只读历史（2026-10-21，用户要求「直接扫本机」）

- **Cursor**：`~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl`（本机确认的字段：`{role, message:{content:[{type:'text'|'tool_use'}]}}`）。`library/cursor-source.ts` 只读，`caps` 全 false（`resume / rename / archive / delete / fork`）；`AgentKind` 加 `cursor`，库 id `cursor-<uuid>`。`LibraryService.prepareResume` 现在对 `caps.resume === false` 的来源直接报「只读」，不再把它交给根本没有驱动的 agent。
- **本机发现**：`library/local-scan.ts` 只看常见目录（home、`APPDATA`、`LOCALAPPDATA`、`HERMES_HOME`），列 Cursor / WorkBuddy / DeepSeek Harness / Zcode / Hermes / OpenClaw / Kiro / Windsurf；`readable` 只在确有来源时为 true。本机 WorkBuddy 只有 `~/.workbuddy/sessions/*.json` 运行记录，没有可读的对话文件 → 界面显示「找到数据」。扫描不读凭据、不全盘递归；结果缓存 60 秒（按 homeDir 区分，测试可注入）。
- **协议**：新增 `library.localScan`；`SourceStatus.caps` 让设置页把只读来源标成「只读」。测试 `library/cursor-source.test.ts`（脱敏 fixture：半行 JSON、tool_use、本机发现只读标记）。

### DeepSeek Harness（2026-10-21，用户问「对话库没有它是不是我电脑没有」）

- **不是没装**：`~/.dsh`（`$DSH_HOME` 可改）是它的用户目录；会话在 `sessions/<项目目录>/<会话目录>/`，标题/cwd 索引在 `storages/session_projcache/sessions/*.json`。之前的 `local-scan` 只找 `.deepseek*` 和 AppData，漏了 `~/.dsh`。
- **格式**：日志是**多帧 zstd**（每次追加一帧），Node 的 `zstdDecompressSync` 只解第一帧；要按 magic `28 B5 2F FD` 切帧再逐帧解。旧会话文件名 `session.jsonl.zstd`、新会话（v4）是 `session.v4.jsonl.zstd`，两者都要认。解出来是 JSONL 事件流：`session`（header，`cwd` / `createdAt` 在**顶层**，不在 `data` 里）、`session/title`、`user/message`、`assistant/message`、`tool/call`、`tool/result`（另有 text / reasoning / tool-call 的增量 chunk，读历史用不到）。
- **会话 id 就是目录名**：旧会话目录是 `session-<uuid>`，新会话是裸 `<uuid>`。不要去掉/补前缀——`session/list` 和 `session/resume` 都用它，改了就回 `session is not resumable`。
- **注入消息与思考块（2026-10-21，用户问「能读、能续吗」时对着真会话发现的）**：harness 把自己的注入也写成 `user/message`——`source.kind: 'runtime-context'`（cwd / 沙箱 / 审批快照）和 `'skill-catalog'`（整份技能清单，几千字）。照原样读出来像是用户每问一句前粘了一大段；`dshMessages` 现在只把 `source.kind === 'user'`（以及没有 source 的旧格式）当用户消息。assistant 的思考块是 `{type:'reasoning', text}`，而渲染只折叠 SDK 的 `thinking` 块，所以要映射成 `{type:'thinking', thinking}`，否则历史里的思考整段消失。
- **实现**：`library/dsh-source.ts` 读文件（列会话 / 读正文），`AgentKind` 加 `dsh`，库 id `dsh-<目录名>`；`local-scan.ts` 把它标为可读取（不再重复列 `.deepseek*`）。真机验证：本机 4 个会话（Desktop\dsh 3 个、Documents 1 个，后者只有标题头），最大一个 49 条消息（21 user / 28 assistant）。测试 `library/dsh-source.test.ts` 用两帧 zstd 的脱敏 fixture 覆盖多帧解码、消息映射与分页。
- **2026-10-22 改成「在 Claude 里接着聊」（用户报告：发出去只有自己那句，回复是 `llm-deepseek: no API key for provider route "deepseek-official"`；用户要的是「只读 dsh 的记录，然后用任何模型继续聊」）**：
  - **读取的三处错**：①一个目录里同时有 `session.jsonl.zstd`（v0）和 `session.v4.jsonl.zstd` 时取了先列出来的 v0——升级时 dsh 把旧日志迁成 v4，之后**只写 v4**，读 v0 就停在升级那一刻（用户的 `5699dcc8` 少了后面 3 轮）。现在 `pickLog()` 和 dsh 自己一样取代数最大的 `session[.vN].jsonl[.zstd]`（也认不压缩的）。②工具结果两种形状：v0 是 `content:[{type:'tool-result', toolCallId, content}]`，v4 是 `message.toolCallId` + `content` 本身就是结果；assistant 消息里的 `{type:'tool-call', id, name, arguments}` 和随后的 `tool/call` 事件是同一个调用，只出一次。③分页曾经从最老的一页开始，长对话打开只看到前几轮；现在按库的约定**第一页是最新的**、cursor 往前翻（`readAll` 会倒序拼回），一页从用户说话处起。另外：标题优先用 projcache 的 `record.rows.title.val`（新会话日志里没有 `session/title`）；`origin: 'subagent'` / 有 `parentSession` 的子代理会话、没说过话的空会话不进列表；图片从 `attachments/v1/objects/<前两位>/<sha256>` 读出来。
  - **续聊**：`SourceCaps.continueInClaude`。hub 的 `session.open` 在 head 检查**之前**拦下这类 id：`LibraryService.continuation()` 把整段历史（`continue-in-claude.ts` 的 `replayEvents`：说过的话全文，工具调用一行注释，不带思考）用 `toClaudeEntries` 写成一份新的 Claude transcript（`transcript-file.ts` 的 `writeClaudeTranscript`，目录名规则抄 SDK：非字母数字变 `-`，超 200 字符加哈希），标题照搬，meta 记 `continuedAs`；以后再发都进同一个（transcript 被删了才新建）。新对话的供应商 = 发送时选的，否则和新对话一样用默认供应商；在 dsh 对话上选过的子代理模型也带过去。前端：`openSession` 回来的 id 不一样时 layout `session.rekey` 把所有标签换过去、等新对话的历史加载完再发；composer 对这类对话显示 Claude 的 chip。dsh 本身从不启动。SessionStore 的 mirror 只有官方二进制支持（ccb 没有 `--session-mirror`），所以直接写 transcript 文件、`--resume` 两个引擎都能接。
  - **只往 Claude 那边走，不写回 dsh**（用户问过「回去 dsh 是不通的？」）：dsh 读日志很严——每行过它的格式解码器、`seq` 必须连续、写之前拿跨进程锁，写错一行就是 `corrupt session log`，那条对话在 dsh 里可能打不开。所以 `~/.dsh` 一个字节都不写，Claude Web 里聊的回不到 dsh。反过来是通的：
    - **列表一条**：dsh 对话有 `continuedAs` 且那个 Claude 对话还在，列表只出 Claude 那条（更新时间取两者较新的）；Claude 那条被删了，dsh 那条回来。新建续聊时 `invalidate('claude')`，不等文件监听。
    - **dsh 里后来又聊的补进来**（`LibraryService.catchUp`）：Claude 对话的 meta 记 `continuedFrom` + `replayed`（已经带过去的 dsh 消息条数）；dsh 那边多出来的消息用 `toClaudeEntries(…, { parentUuid: currentLeaf(file) })` 接在 Claude 对话当前末尾后面，再写一行 `last-prompt` 指过去（官方二进制按它续）。三个时机，都走 hub 的 `catchUpFromSource`：`transcript.load` / `library.read` 的第一页、`session.open`（回 `caughtUp`，前端看到就重载历史）、以及**监听 `~/.dsh/sessions`**（`defaultWatchDirs` 加了 dsh，`behind()` 等 1.5 s 不再写再发 `continuationBehind`）。
    - **对话进程开着也要补**：闲置的进程会留一阵才回收，只在「没有进程」时补等于大多数时候不补（真机第一次就是这样）。现在 `pool.quiet(id)`（没进程，或进程闲置、没有待重启、没有后台任务、安静 3 s）就补，补完 `pool.reloadTranscript(id)`：`SessionRunner.reloadTranscript()` 重启进程读新的 transcript，`respawn` 起新进程之前用 `repairLeaf(…, { ignoreLeavesFrom })` 忽略官方二进制退出时写的旧 leaf（同 `yieldToOutside`，但对话不关，前端状态不乱）。`catchUp` 在写之前再问一次 `canWrite()`，返回**写了几行**（只有工具结果时是 0，不白重启）。
    - **正在跑一轮时 dsh 写了**（独立审查 2026-10-22 第二轮 FAIL：只在监听那一下试过一次，之后进程一直开着就再没人补，下一句发出去模型没看到）：现在 hub 的 `behindPending` 记下来，进程变 `idle` 后 3.3 s 再试（已经是 idle 只是没安静够，就直接定时），补完广播 `session.caughtUp`，开着它的窗口重读历史。**发送前**也补：前端 `send()` 对 `sessionMeta.continuedFrom` 的对话（进程 idle 时）先发 `library.catchUp`（服务端最多等 4 s 等它安静），写了就先重载历史再发——这样那几句排在这句前面。`sessionMeta` 前端只在启动时读一次，所以 `openSession` 换 id 时本地也记上 `continuedFrom` / `continuedAs`。
    - **同时两次补齐 = 两个引擎进程**（审查第三轮 FAIL：dsh 写完 ~1.5 s 发送时，监听和发送前那一下撞上；`catchUp` 共用一个 promise，两边都拿到 n>0、各自重启，`respawn` 里状态还是 idle 所以 `quiet()` 拦不住）：现在 ①hub 的 `catchUpFromSource` 每个对话排队，一个跑完才跑下一个，只有真写了的那次重启；发送前那次排在别人后面时，把前面写的行数也算上（前端照样先重载历史）。②`reloadTranscript` 正在重启就复用那次；`respawn` 期间 `respawning` 让 `quiet()` 为 false。③发送前先 `newSince()` 看有没有新的，**没有就不等**；有才等，而且**只等很快会自己结束的**（`SessionRunner.settling()`：`starting`、正在重启、或刚闲下来 3 s 内；最多 10 s），前端在 `starting` 时也做这一步。有后台任务（开着的开发服务器）或等着重启时不等——第四轮审查：那样每次发送白等 11 s、dsh 那句照样排后面；这种情况交给之后的重试。代价：刚重启后发送，这句要 3～5 s 才出现在界面上（先补、再显示这句）。④重试定时器每个对话只留一个。
    - 真机（dsh 副本 + 假接口）：打开时补（界面上看得到）、发送时补、进程闲着时 dsh 一写 6 s 内 transcript 里就有、下一句模型收到；消息数 23 → 27 → 31，没有重复。审查的复现（假接口收到 SLOW 时往 dsh 副本写一轮再拖 9 s）：这一轮结束几秒后界面出现 dsh 那句，下一句模型收到，只一次。撞车（dsh 写完 1.5 s 发送）和重启中（dsh 写完马上发送）：各只一次、都在那句之前，结束后这个对话只有一个引擎进程（`Get-CimInstance Win32_Process` 按对话 id 查；引擎命令行里不一定有 `--resume` 字样）。
  - **`toClaudeEntries` 的时间戳必须严格递增**：同一毫秒里生成的行时间戳相同，ccb 续接时只走到第 2 个回答，后面几轮全没发给模型（真机：12 条历史只发了 5 条）。现在每行相隔 1 ms、最后一行早于现在；交接（`swap.ts`）也走这个函数，一并受益。
  - **真机验证**（临时 HOME + `~/.dsh` 的副本 + 假 Anthropic 接口，界面用 `scripts/shot.cjs` 跑）：打开 dsh 对话 → chip 是默认供应商 → 发送 → 标签换成新的 Claude 对话、出现回复；模型收到 16 条消息，dsh 里每一轮都在；再发一次进同一个对话，18 条。
- **续聊（2026-10-21 用户要求「像 Codex 那样」；10-22 起库里的 dsh 对话不再走这条，见上）**：dsh 的 ACP 服务端（`dsh --profile acp`）在 `initialize` 里声明 `sessionCapabilities: { list, resume, close }`，**没有标准 `loadSession`**。所以 `agents/acp-driver.ts` 续聊时先发 `session/resume`（`{ sessionId, cwd, mcpServers }`，要求 cwd 与创建时一致），再退回 `session/load`；`library/acp-source.ts` 的 `caps.resume` 也认 `sessionCapabilities.resume`。`DshSource` 继续负责列会话和读正文（ACP 没有 transcript replay），续聊由 ACP 驱动完成，新轮次由 dsh 写回同一份日志，下次读文件就能看到。`AGENT_DEFS` 里 dsh 默认命令是 `dsh --profile acp`（需 `npm i -g @deepseek-ai/dsh`；本机实测 npx 缓存那份依赖不全，`execa` / `zod` 解析失败，所以不用 npx）。
- **resume 不能带我们的 MCP 列表**（2026-10-21 真机）：带上 `claude-web-memory` 的 stdio MCP 时 dsh 回 `Internal error`，去掉就成功。AcpDriver 现在先按完整 MCP 列表 resume，失败再不带 MCP 重试一次，并推一条「本次续聊没有挂载共享记忆 / 联网」的提示。
- **真机实测**（`dsh` 0.2.1-rc.2）：`initialize` 12.8 s（`deepseek-harness-acp` 0.0.1）、`session/list` 4 个、`session/resume` 15.3 s、`session/close` 正常；用用户的 `session-86ce…` 跑完整 AcpDriver，`head.nativeSessionId` 保持原 id，未回退新会话。测试时创建的 3 个空会话目录已删除。限制：dsh 不支持 fork / 删除 / `session/load`，一次只允许一个进行中的 prompt。

## claude.ai 的数据导出（阶段 F4，2026-10-25）

- 一次性导入，不是同步；不碰 claude.ai 的任何接口。入口：设置 → 对话库 的「导入 claude.ai 数据…」、命令面板。上传 `POST /api/import/claude-ai`（要令牌，没设令牌时只认同源请求 `cloud/same-origin.ts`；1 GB 上限）存到 `~/.claude-web/claude-ai/uploads/<随机>.zip`；`claudeai.scan` / `claudeai.import` 只认这个目录里的 zip，导完删掉，没导的 24 小时后清掉（`sweepUploads`）。
- zip 自己读（`server/src/import/zip.ts`，stored / deflate / zip64；`unzipper` 只是传递依赖，打包后不一定在）。导出包来自外面，读法是防着的（修补轮 F1）：`readZipFile` 按偏移读（不整个读进内存），只解压那三个 JSON（`want`），每条和合计都有解压上限（512 MB，`inflateRawSync` 的 `maxOutputLength`，头里写的大小骗不过去），条目重叠 / 超出文件就拒。id 不能当文件名的对话（`../../x`）在 parseExport 就算 `skipped`；`add` / `update` 只数真写了的。再导入：文件只写进这次选的文件夹下面，项目说明只在项目自己没有时才填。解析 `server/src/import/claude-ai.ts`：按文件名在 zip 任意目录里找 `conversations.json` / `projects.json` / `users.json`；坏的一条跳过（`skipped`），整份坏才报错；`is_starter_project` 的示例项目不导。消息：content 为空用 `text`；artifacts 工具调用变成文字（标题 + 代码块）；其它工具调用是 `tool_use` + 紧跟的 user 行 `tool_result`（同 id）；附件的 `extracted_content` 变成「［附件 名］」文字块；`files` 只剩名字。行 uuid 稳定（再读一样）。
- 存储：每个对话一个 `~/.claude-web/claude-ai/conversations/<uuid>.json`（`{ conv, cwd?, importedAt }`）；再导入按 uuid 去重，`updated_at` 更新的覆盖。来源 `ClaudeAiSource`（`AgentKind` 'claudeai'，id `claudeai-<uuid>`，只读：caps 只有 `resume` + `continueInClaude`）；「接着聊」走现成的 `continuation()`（同 dsh）。导入后自动 `library.join('claudeai')`，索引照常建（能搜）。
- 项目：用户选了文件夹才导；每个项目建 `<文件夹>/<safeName(项目名)>/`，加成项目（`claudeAiUuid` 记来源，再导入就更新同一个），`prompt_template` → 项目说明，docs 写进去（**已有的文件不覆盖**，计 `filesKept`）。导出包里的对话一般不带项目 uuid，带了（`project_uuid` / `project.uuid`）就把 cwd 设成那个项目的文件夹，否则是主目录。
- 调试：`node server/ws-phase39.mjs [port] [token]`（fixture 在 `server/fixtures/claude-ai-export/`）。

## Antigravity（2026-11-21，用户转述的社区需求「把 Antigravity IDE 的对话接进来」）

- **在哪**（本机实测，2026-05 到 11 月的几个版本）：`~/.gemini/antigravity/conversation_summaries.db`（SQLite：`conversation_summaries`
  有标题 / preview / `workspace_uris` / `last_modified_time` / `parent_conversation_id`，另有 FTS5 表 `conversations_fts` 存每个对话的
  user / agent 正文和 `[[step, 字节偏移], …]`）+ `~/.gemini/antigravity/conversations/<id>.db`（每个对话一个 SQLite：`steps` 表一步一个
  protobuf `step_payload`，`trajectory_metadata_blob` 里有工作区文件夹）。旧版本的目录 `~/.gemini/antigravity-ide/conversations/` 是同样的
  `<id>.db`，**没有 summaries**（标题取第一句话、文件夹取元数据）；更旧的 `<id>.pb` 是加密的（熵 7.8 bit/byte），读不了、跳过。
- **只读副本**：Antigravity 开着时这些库可能正在写（WAL）。一律把 `<id>.db` 和 `-wal` 拷到临时目录、读副本、读完删掉，**原文件一次都不打开**
  （测试里比对了目录快照：没有多出 -wal / -shm，大小和 mtime 都不变）。
- **step 的 protobuf**（没有公开 schema，对着真数据读出来的）：1 类型、4 状态、5 元数据 `{1 创建时间 {1 秒}, 4 工具调用 {1 id, 2 名字, 3 参数 JSON},
  30 动作, 31 一句话摘要}`；类型 14 用户说的话 `19.2`；类型 15 agent 这一轮 `20 {1 正文, 3 思考, 7 工具调用[{1 id, 2 名字, 3 参数}]}`；
  工具那一步的 id 和 15 里给的一样。结果：新版本（类型 132）在 `140.2.1` 有现成的文字（agent 看到的原样，`140.1` 是参数回显、`140.2.6`
  内嵌一个 Step），旧版本只在各自的字段里（13 grep、14 读文件、15 列目录、28 命令…），取里面的文字、去掉参数自己的键和值。
  **解析时先试 message 再当文字**只在开头像字段标签（0x08 / 0x0a / 0x10 / 0x12 / 0x18 / 0x1a）时做：列目录的一项 `{1 名字, 4 大小}`
  本身也是合法 UTF-8（`\n\r.dockerignore ]`）；固定宽度（wire type 1 / 5）读成数，不当成字节，否则 `AGENTS.md` 会被当成「字段 8 + 8 字节」
  读成 `GENTS.md`。
- **工具映射成 app 自己的卡片**：`view_file`→Read、`run_command`→Bash、`grep_search`→Grep、`find_by_name` / `list_dir`→Glob、
  `write_to_file`→Write、`replace_file_content`→Edit、`multi_replace_file_content`→MultiEdit、`search_web`→WebSearch、`read_url_content`
  →WebFetch；其余（`manage_task`、`schedule`、`browser_subagent`…）保留原名和参数（普通卡片）。所以对话头的「改了几个文件 +N −M」、回合的
  「读了 1 个文件 · 改了 1 · 搜索 1 · 跑了 1 个命令」都对得上。结果截到 4000 字。
- **列表**：summaries 里 `parent_conversation_id` 非空的（子代理的对话）不列；summaries 里有但库文件没了的（在 Antigravity 里删了）不列；
  旧目录里一句话都没说过的不列；同一个 id 两个目录都有时新目录的为准。`lastModified` 取 summaries 的时间和库文件（含 -wal）mtime 较新的。
- **读**：先读这个对话自己的库；读不出东西（库坏了 / 格式变了）退回 summaries 的 FTS 正文（只有文字，按字节偏移切回每一步）。
  读过的对话按文件大小 + mtime 缓存，翻页不重拷。
- **接着聊**：`caps` 同 dsh / claude.ai（`resume` + `continueInClaude`），走 `LibraryService.continuation()` 在 Claude 里开新对话、带上历史；
  Antigravity 那边一个字节都不写。
- `SessionSource.name`：不是 agent 的来源（Cursor、claude.ai、Antigravity）自己带显示名，`sources()` 和「只读」报错用它（以前没加入时显示成
  小写的 kind）。
- 测试：`library/antigravity-source.test.ts`（自己写 protobuf 的夹具：两个目录、summaries + FTS、子代理 / 删掉的 / 空对话、类型 132、
  列目录的项、翻页、FTS 退路、原文件快照不变）。真机（`ag-home` 临时 HOME + 本机数据的副本，2026-11-21）：加入前不列、加入后 6 条、读最长的
  840 条消息一页 40 条、搜「webview2」命中、打开即在 Claude 里续上（transcript 里有 Antigravity 的原话）、再打开进同一个、列表只剩 Claude 那条；
  界面截图里对话头、回合摘要、改动数都正常。本机直接读（只读副本）32 个对话、首次列表 1.6 秒（要开旧目录 29 个库取标题，之后按 mtime 缓存）。
