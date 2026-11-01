# 统一会话库（2026-09-27）

> 2026-11-01 起只剩两个来源：Claude Code 和 claude.ai 数据导出（见「只留 Claude」）。Codex / OpenCode / ACP / Cursor / DeepSeek Harness 的来源、
> 「本机发现」（`library.localScan`）、侧栏底部「把 X 里的对话也列在这里？」的提示（`library.detect` / `announce` / `dismiss`、`library.discovered`、
> `SourceStatus.dismissed`）都删了；它们的实现和真机记录在之前的提交里（`git log -- server/src/library/codex-source.ts` 之类）。

- **一个入口**：`server/src/library/service.ts` 的 `LibraryService` 把来源合成一个列表 / 读取 / 搜索面；`sessions.list`、`sessions.search`、`transcript.load`、`session.open` 都走它。来源实现 `SessionSource`（`library/types.ts`），每个来源一个文件：

  | 来源 | 列表 / 读取 | rename | archive | delete | fork | 续聊 |
  | --- | --- | --- | --- | --- | --- | --- |
  | Claude（`claude-source.ts`） | SDK `listSessions` / transcript | ✓（SDK） | ✓（只记在 meta.json，Claude Code 没有归档标记） | ✓ | ✓（SDK `forkSession`） | ✓ |
  | claude.ai 导出（`claudeai-source.ts`） | 导入时存下的 JSON | — | — | — | — | 「接着聊」= 在 Claude 里接着聊（`continueInClaude`） |

- **id 规则**：Claude 保持原 UUID；claude.ai 是 `claudeai-<原生 id>`。不含冒号。前缀表（`LIBRARY_ID_PREFIXED_KINDS`）和 `parseLibraryId` 在 `protocol.ts`（web 共用）。
- **加入**：Claude 始终在库里（不能移出）；claude.ai 默认不加入，导入后自动 `library.join('claudeai')`。状态存 meta `settings['library.joined']`。移出 = 从列表和索引里去掉（数据不动）。
- **删除先备份**：完整历史导出到 `<dataDir>/library-trash/<id>.json`（Claude 是把原始 jsonl + `<id>/` 目录拷到 `library-trash/<id>/`；`dataDir()` 跟随 `CLAUDE_WEB_DIR`），写成功才调来源的 delete，导出失败就不删；启动时清理 30 天前的备份。界面二次确认，批量默认归档。
- **索引**：`<dataDir>/library.db`（FTS5），每会话正文摘录上限 20 000 字，中文走 LIKE（同 memory 的 `hasCjk`）；首轮索引完成前搜索退回旧的 transcript 扫描。`agent:<kind>`、`in:<目录片段>` 是查询前缀（`index-db.ts`）。
  - **索引不能跟着正在写的对话反复重读**（2026-09-29 实测：空闲的 3090 server 常驻 ~16% CPU）：Claude 的监听器每次 transcript 追加都触发一次索引，而每次都整份重读（进行中的对话 60–70 MB），索引里的 `list()` 还会让过了 TTL 的来源在后台重列。现在：① 索引用 `list({revalidate:false})`，年龄不触发重列，只有监听器（soft → `stale`）/ 我们自己的改动（`dirty`）才会；有监听器的来源 TTL 10 分钟（`WATCHED_LIST_TTL_MS`），其它 60 秒；② 还在写（3 分钟内变过）的 Claude 对话，索引正文已存满 20 000 字（按 UTF-16 算，和截断同一个单位——SQLite 的 `LENGTH` 按码点，一个 emoji 就永远「不满」）时只 `touch()` 摘要（标题），**不动 `lastModified`**，安静 3 分钟后重读一次：索引读的是 `getSessionMessages` 沿 `parentUuid` 走出的链，压缩（`compact_boundary` 的 `parentUuid:null`，> 5 MB 时 SDK 只读最后一个边界之后）和 CLI 里的回退都会换掉开头，文件只追加不代表正文开头不变；③ 其它还在写的对话 3 分钟内最多重读一次（`INDEX_LIVE_MS`），跳过的会排一次补跑，补跑用 `scheduleIndex(ms, {unlessSooner:true})`，不会把已经排好的更早一次（监听器的 5 s）往后推。实测一个 62 MB、每 7 秒追加一次的对话：server CPU 7.9 s/分钟 → 0.2 s/分钟。
- **踩过的坑**：
  - **来源遇到暂时性失败必须 throw**（不能返回空），否则 service 会以为「没有会话」、把索引和缓存清掉；只有「没装」/「没数据」才返回空。service 保留上次缓存并在 `SourceStatus.error` 里带出错误。
  - **Windows 上 Python 文本模式写文件会把 LF 变成 CRLF**：仓库有 `.gitattributes`（`eol=lf`），改文件用 Edit/Write 或二进制写；提交前 `git diff -w --ignore-cr-at-eol --stat` 应该和 `git diff --stat` 一样。
  - **大目录树别用 chokidar 监听**（2026-09-29 实测，桌面版从开始菜单点开后一分多钟没有窗口的根因）：chokidar 在 Windows 上对**每个文件**单独 `fs.watch`，库对 `~/.claude/projects` 深度 4 的监听是 4468 个文件 + 168 个目录，server 开始监听后事件循环整整堵了 ~18 s（CPU profile 里 `createFsWatchInstance` → 原生 `start`），而桌面窗口要等页面画出来才显示。现在 `SessionService` 和库的监听都走 `runtime/watch-tree.ts` 的 `watchTree(dir, onChange)`：一个 `fs.watch(dir, {recursive:true})` 句柄（Windows ReadDirectoryChangesW / macOS FSEvents / Linux 按目录 inotify，Node ≥ 20），回调拿到相对路径；目录还不存在就每 30 s 找一次、出现后再挂；句柄出错（整棵树被删，Windows 上是 EPERM）回到寻找。`SessionService` 只认 `transcriptEvent(rel)`：项目目录、项目下的 `<id>.jsonl` / `<id>` 目录（子代理日志、tool-results、memory 不算）。同样条件下 profile 里 55 s 内零卡顿。chokidar 只留给小目标（git 的 HEAD / index / refs、编辑器里打开的单个文件）。
  - **SDK 的 `listSessions` 会整个漏掉第一句很长的对话**（2026-10-17 实测：头 64 KB 里没有可读的第一句、尾部又没有标题类的行）：`sessions/unlisted.ts`
    扫目录补上，进程结束时补一行 `last-prompt` 让别的应用（Mirasim）也列得出。详见「照官方桌面版录屏改的界面」第二轮。
- 测真机时用临时 `CLAUDE_WEB_DIR` 起一个独立 server，别碰用户自己的 `~/.claude-web`。

## 在 Claude 里接着聊（`continueInClaude`，2026-10-22 为 DeepSeek Harness 做的，现在只有 claude.ai 导出用）

- hub 的 `session.open` 在 head 检查**之前**拦下这类 id：`LibraryService.continuation()` 把整段历史（`continue-in-claude.ts`：说过的话全文，工具调用一行注释，不带思考）写成一份新的 Claude transcript（`transcript-file.ts` 的 `writeClaudeTranscript`，目录名规则抄 SDK：非字母数字变 `-`，超 200 字符加哈希），标题照搬，meta 记 `continuedAs`（新对话记 `continuedFrom` + `replayed`）；以后再发都进同一个（transcript 被删了才新建），列表只出 Claude 那条。新对话的供应商 = 发送时选的，否则用默认供应商。前端：`openSession` 回来的 id 不一样时 layout `session.rekey` 把所有标签换过去、等新对话的历史加载完再发。
- 只往 Claude 那边走，原来的数据一个字节都不写。（历史：dsh 那边后来又聊的内容「补进来」的 `catchUp` / `continuationBehind` 一套随 dsh 删了。）
- **`toClaudeEntries`（`session/handoff.ts`）的时间戳必须严格递增**：同一毫秒里生成的行时间戳相同，续接时只走到第 2 个回答，后面几轮全没发给模型（2026-10-22 真机：12 条历史只发了 5 条）。现在每行相隔 1 ms、最后一行早于现在。

## claude.ai 的数据导出（阶段 F4，2026-10-25）

- 一次性导入，不是同步；不碰 claude.ai 的任何接口。入口：设置 → 对话库 的「导入 claude.ai 数据…」、命令面板。上传 `POST /api/import/claude-ai`（要令牌，没设令牌时只认同源请求 `cloud/same-origin.ts`；1 GB 上限）存到 `~/.claude-web/claude-ai/uploads/<随机>.zip`；`claudeai.scan` / `claudeai.import` 只认这个目录里的 zip，导完删掉，没导的 24 小时后清掉（`sweepUploads`）。
- zip 自己读（`server/src/import/zip.ts`，stored / deflate / zip64；`unzipper` 只是传递依赖，打包后不一定在）。导出包来自外面，读法是防着的（修补轮 F1）：`readZipFile` 按偏移读（不整个读进内存），只解压那三个 JSON（`want`），每条和合计都有解压上限（512 MB，`inflateRawSync` 的 `maxOutputLength`，头里写的大小骗不过去），条目重叠 / 超出文件就拒。id 不能当文件名的对话（`../../x`）在 parseExport 就算 `skipped`；`add` / `update` 只数真写了的。再导入：文件只写进这次选的文件夹下面，项目说明只在项目自己没有时才填。解析 `server/src/import/claude-ai.ts`：按文件名在 zip 任意目录里找 `conversations.json` / `projects.json` / `users.json`；坏的一条跳过（`skipped`），整份坏才报错；`is_starter_project` 的示例项目不导。消息：content 为空用 `text`；artifacts 工具调用变成文字（标题 + 代码块）；其它工具调用是 `tool_use` + 紧跟的 user 行 `tool_result`（同 id）；附件的 `extracted_content` 变成「［附件 名］」文字块；`files` 只剩名字。行 uuid 稳定（再读一样）。
- 存储：每个对话一个 `~/.claude-web/claude-ai/conversations/<uuid>.json`（`{ conv, cwd?, importedAt }`）；再导入按 uuid 去重，`updated_at` 更新的覆盖。来源 `ClaudeAiSource`（`AgentKind` 'claudeai'，id `claudeai-<uuid>`，只读：caps 只有 `resume` + `continueInClaude`）；「接着聊」走 `continuation()`（见上一节）。导入后自动 `library.join('claudeai')`，索引照常建（能搜）。
- 项目：用户选了文件夹才导；每个项目建 `<文件夹>/<safeName(项目名)>/`，加成项目（`claudeAiUuid` 记来源，再导入就更新同一个），`prompt_template` → 项目说明，docs 写进去（**已有的文件不覆盖**，计 `filesKept`）。导出包里的对话一般不带项目 uuid，带了（`project_uuid` / `project.uuid`）就把 cwd 设成那个项目的文件夹，否则是主目录。
- 调试：`node server/ws-phase39.mjs [port] [token]`（fixture 在 `server/fixtures/claude-ai-export/`）。
