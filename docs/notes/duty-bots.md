# 值班 Bot（2026-10-30）

spec：`docs/superpowers/specs/2026-10-30-duty-bots-design.md`；一期的计划和各任务记录在 `.superpowers/sdd/2026-10-30-duty-bots-phase1/`。Bot = 住在电脑里、按例行（Routine）定时干活的 Claude 对话，动作过一道策略闸，要人拍板的事进收件箱。

- **目录**：`<CLAUDE_WEB_DIR>/bots/`。每个 Bot 一个目录 `<id>/`：`bot.json`（章程、例行、策略、预算、输出）、`runs/index.jsonl`（每次运行一行，同 id 再追加一行、读时取最后一行）、`runs/<runId>.audit.jsonl`（这次运行每个工具调用的判定：级别、依据、规则、结果）、`state/<routineId>.json`（预检指纹、上次结论、检查点）、`state/<routineId>.checkpoint.md`（长任务的进度，Bot 自己写）、`trust.json`（批准次数）。根上：`inbox.json`、`scheduler.lock`(+`.take`)、`stop.request.json`、`held.json`（勿扰时段攒下的 IM 推送）。服务端代码 `server/src/bots/`，前端 `web/src/features/bots/`。
- **流水线**（`pipeline.ts` 的 `runRoutine`）：预检脚本 → 指纹没变就跳过（`skipped`）→ 开一个新对话（resume 时开原来那个）→ 先挂上闸再发提示词 → 等 result / 超时 / 硬停 → 验收脚本 → 写运行记录 → 输出（收件箱 finding、`<draft>` 进草稿、追加文件；IM 由 service 推）。连续失败 3 次停用这条例行。费用是这个对话在账本里的累计。
- **`drivenBy: 'schedule'` 复用定时任务的那个值**：意思是「没人坐在窗口前」，runner 不加给人看的提示（节点图提示等），不新加一个枚举。真正区分 Bot 对话的是 `gated: true`（服务端设的，窗口发来的 `session.open` 会被 `clientSessionParams` 去掉）。
- **策略闸只在 Claude 的对话上**：Codex / ACP 不认 `gate`，开出来不是 gated 的直接判失败（「对话不经过策略检查」），不跑。**gated 对话用 SDK 的 PreToolUse hook**，不是 canUseTool：settings 的 allow 规则、权限模式、`allowedTools`（MCP 工具全在里面，SDK 会警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`）都会让 canUseTool 根本不被调用。hook 自己 600 s 超时、闸 590 s 不答就拒绝；闸里出任何错都是拒绝（fail closed）——放过去就会弹一张没人看的权限卡。canUseTool 那边只复用 hook 的答案。
- **「要问」= 拒绝并排队，不挂起**：挂着等人批，SDK 会一直等、整轮卡死、超时也算在这次运行上。现在是拒绝这一步（告诉模型「已放进收件箱，先做别的」）、收件箱加一条 approval、运行照常结束；批准后用同一个对话 resume（`trigger: 'resume'`），`approveOnce` 让完全相同的那次调用（工具名 + 键排序的 input 的 sha1）放行一次，审计依据 `user`。
- **级别**：`deny` 永远先看（范围只要碰到一个值就算）→ 放开（`unleashed`）→ 自动驾驶 → 带范围的规则 → 不带范围的规则 → 默认（读 / 本地写 / 浏览器做，装东西做了告诉我，发出去 / 付钱 / 删除要问）。
- **带范围的 `do` 规则对 shell 只认得清楚的**：纯 HTTP 客户端（curl / wget / irm / iwr）和 `git push <https-url>`；其它（裸主机、ssh、代理、展开出来的目标、`git -c` / 会执行程序的传输方式…）都是 opaque，只能走要问。审批时可以带范围（域名 / 频道 / 收件人 / 金额上限 / 到期，或明确同意的「无限制」），范围必须写明用在哪儿，付钱的要写上限。**已知的类级绕过留给二期隔离**：`python -c`、`node -e`、`git -c core.fsmonitor=…`、`npm exec -c …` 这类「让解释器跑任意代码」的写法，一期的分类器看不穿。
- **Bot 改不了自己的策略和审计**（`policy/self-guard.ts`，放开了也一样）：Write / Edit / MultiEdit / NotebookEdit 落在 `bots/` 下就拒绝，只有这个 Bot 自己的 `state/` 例外；路径先 resolve、realpath（junction / 8.3 / `..`）、Windows 上大小写折叠。网络路径先折回本机盘符：`\\localhost\c$\…`、`\\127.0.0.1\…`、`\\<本机名>\…`、`\\?\UNC\…`、`\\.\C:\…` 都当 `C:\…` 判（验收时发现过 `\\localhost\c$` 绕过）；折不回来的共享（别的主机、命名共享）要问。映射盘符（`net use V: \\localhost\c$`）realpath 出来是网络形式，同样折回再判；建盘符 / 共享 / 链接的命令（net use、New-PSDrive、subst、mklink、New-Item -ItemType Junction…）要问。shell 命令里出现 bots 目录（`$HOME`、`%USERPROFILE%`、`../`、数据目录名等写法）要问。
- **调度租约**：`scheduler.lock` 记 pid / host / instance / 时间，`.take` 用 `wx` 独占创建保护「读 → 写 → 再读」，两个进程（桌面版和无窗口的值班服务）同时发现租约过期也只有一个拿到。只有持有者跑 Bot、写 bot.json / inbox.json；别的窗口点「停」写 `stop.request.json`，持有者 watch + 每次 tick 取走执行。丢了租约的调度器立刻停掉在跑的运行。tick 30 s。
- **默认来源是 API / 网关**（设置 `bots.defaultProvider`），不是 Claude 订阅：无人值守的自动化跑在订阅上不合服务条款。档位（便宜 / 平衡 / 最好）只在智能路由组上映射成策略虚拟模型，Claude 上「最好」= opus，其它来源用它自己的默认模型。
- **值班模式**（`duty.ts`，设置里的开关，`bots.duty.install`）：把 server 注册成本用户的无窗口服务，关了窗口 Bot 照跑。Windows 是登录任务 → wscript 隐藏跑 `duty.vbs`（崩了重启、见到 `duty.stop` 或 `duty.cmd` 没了就停）→ `duty.cmd` 设好环境起 server，pid 写 `duty/duty.pid`；mac / Linux 是 launchd / systemd 用户单元。和桌面版谁跑 Bot 由上面的租约定。
- **预检 / 验收脚本**：Windows 走 `powershell.exe`，其它 `sh`；硬停会杀掉正在跑的脚本。
- **总管**：一期只是占位——内置、不能删、不能有例行，不干活；转派是二期。
- **界面**（A 批起，见下面「聊天优先」）：Bot 页是聊天——三栏：名册（页面自己的第一栏）| Bot 自己的对话 | 资料栏；没有收件箱页了，批准卡在对话里，总览（右侧面板 mission）的「需要你」照旧列出来。手机第一屏是名册（只有一个自己的 Bot 时直接进它的对话）。设置在「通用」页里的「值班 Bot」一块（设置页数上限 15，不另开一页）。
- **调试**：`CLAUDE_WEB_DIR=/tmp/x npm start`（别碰自己的 `~/.claude-web`），建一个 Bot，`bots.runNow`，看 `bots/<id>/runs/index.jsonl` 和 `runs/*.audit.jsonl`；Bot 的对话（主对话、例行的运行）都不在对话列表里，运行从对话里运行卡的「打开」进。`window.__cwBots.inject({ bots, inbox, runs, load, timeline })` / `open(id)` / `state()` 是前端调试入口（服务端下次推送会覆盖，tick 每 30 s 推一次 load）。
- **测试**：`node server/ws-phase42.mjs`（e2e 默认列表里，自己起 server）：真引擎（ccb）+ 假 Anthropic 上游，不花 token——模板 14 个、建 Bot、跑一次（finding、费用是数字）、`git push origin main`（仓库没有 remote，不出网）被闸拒绝进收件箱、批准后 resume 同一对话且这次放行、放开后不再问、在上游挂住时硬停、总管删不掉；之后是聊天优先那一段（见下面）。ui-smoke 的「bots」一段见下面。
- **坑**：in-process MCP 的工具 schema 不能用 `z.record`——SDK 自带的 schema 转换在 zod 4.5 的 record 上抛错，整个服务的 tools/list 失败，ccb 把这个服务的工具全丢了（不报错，模型只是看不到）。`self-mcp.test.ts` 真发一次 tools/list 查这个。
- **坑**：e2e 的阶段脚本自己起 server 时要设 `CLAUDE_WEB_SYSTEM_LANG: 'zh-CN'`，不然单跑时闸的提示是英文，断言中文会失败。跑 e2e 前先 `npm run build -w server`（脚本跑的是 `server/dist`）。

## 已知的类级绕过（第 1 阶段不拦，第 2 阶段的隔离 / Rule of Two 再管）

闸门按「这一次调用是什么动作」分级，下面这些能让 bot 绕过分级，第 1 阶段只记录、不拦：

- 解释器直接跑代码：`python -c`、`node -e`、`git -c …`（用配置改掉被覆盖命令的行为）。
- 包执行器：`npx`、`pnpm dlx`、`npm exec`、`yarn dlx`——拉下来的任意包在本机跑，分级只看到外层命令。
- bot 自己写的配置，下一次「被覆盖的」命令才生效：`.curlrc`、`~/.netrc`、git hooks / `core.hooksPath` /
  `url.<x>.insteadOf`、`.npmrc`，以及代理环境变量（`HTTPS_PROXY` 等，子进程继承）——改的那一步是 write_local，
  真正外发的那一步看起来是普通的 `git push` / `curl`。
- 读也能外发：`WebFetch` / `curl` GET 归 read，查询串里可以带出任何东西（Rule-of-Two 那一族：读了不可信内容又能
  对外发请求）。
- 闸门外的脚本：预检查（precheck）和验收脚本不过闸门，继承整个服务器的环境变量（`precheck.ts` 的 spawn，在
  密钥保险箱之前就是这样）；`generateBot` 让模型写的预检查 / 验收脚本，用户点「保存并先跑一次」就会跑——预览里
  必须原样展示，不能默认折叠。
- shell 自己拼出来的路径：通配 / 变量拼接（`~/.cl*/bo*/b1/bot.json`、`$a$b`）写进 bots 目录，或先建个硬链接再用
  Write 改——命令里认不出 bots 目录。文件工具的守卫按真实路径判（目录链接、映射盘符、`\\localhost\c$` 都折回），
  建盘符 / 共享 / 链接的命令（`net use`、`New-PSDrive`/`ndr`、`subst`、`mklink`、`ln`、`fsutil hardlink`、
  `ni -ItemType …`、`CreateSymbolicLink`、`wmic share`）一律要问，但 shell 字符串匹配做不到完整。
- 批准过的 / 放开的调用不计入任何上限（ledger L71）。
- IM 里的批准 / 拒绝：绑定的群里任何成员都能点，群聊里等于谁都能批付款 / 外发；第 2 阶段考虑只认绑定者的用户 id。
- spec §5 的不可信内容隔离和 Rule of Two 是第 2 阶段的事。

## 值班让位的风险和处理（2026-10-30 终审 I2 / I4）

- **pid 被别的程序复用（I2）**：以前 server.lock 只看「pid 活着 + 本次开机后写的」，服务器没清理就死掉（桌面版
  4 秒停超时、任务管理器、崩溃）后，Windows 很快把这个 pid 给了别的程序，值班入口每 30 秒 BUSY 退出一次，直到
  重启或注销都不会好。现在 ready 的锁（有 port + nonce）要用 `probeLock` 问它的端口（问两次，隔 1 秒），不应答就
  算死锁、删掉接管；没 ready 的锁只在 5 分钟（`STARTING_STALE_MS`）内算活。代价：事件循环卡死超过约 4 秒的服务器
  会被判死，另一个可能接管同一个数据目录。
  另一头：桌面版也每 2 秒看一眼锁（watchLock）——它卡顿时值班入口把它判死、接管了数据目录，它缓过来后发现锁上是活的
  值班服务器，就写 server.yield 让它退、把锁拿回来。值班入口判「不应答」要看两次：第一次只记在
  server.lock.suspect，下一轮（≥25 秒后）还是同一把锁、还不应答才接管；中间应答了就作废。
- **让位时在跑的运行（I4）**：以前值班服务器让给桌面版（或桌面版退出）时，在跑的运行记成「被停下了」，cron 的
  下次时间已经推后，`onFail: 'resume'` 也不续跑——登录后值班补跑、一分钟内用户打开桌面版，这一轮就静悄悄丢了。
  现在服务器退出（非用户的硬停止）时，在跑的运行记成 `handoff: true`、「中断（让给另一个 claude-web）」、不写
  endedAt；下一个拿到租约的在 `recover()` 里把它关掉，`onFail: 'resume'` 的续跑，cron 触发的再跑一次（retried，
  不连环重试）。用户的硬停止照旧：不交接，记「被停下了」。预检查的指纹只在运行成功后才存（终审第二轮），
  重跑不会被当成「没变化」跳过。
- **硬停止的进程树（I3）**：关对话时 CLI 1.5 秒不退出就 `killTree`（Windows 上 `taskkill /t /f`），挂住的 CLI 下面
  的 bash / 后台命令 / curl 循环一起结束；bot 的硬停止（interrupt 后紧接着 close）不再先重启一个 CLI 再关掉。
- **duty.log**：超过 1 MB 轮转一次（留一份 `duty.log.1`）。Windows 由 vbs 在两次运行之间轮转（运行中 cmd 占着文件），
  macOS 由值班入口每次启动时轮转，Linux 走 journal。

## 真机实测（2026-10-31，Task 22，两个真中转）

临时 HOME / `CLAUDE_WEB_DIR`，模板 `pr`，cwd 是仓库的本地克隆（push 地址改成无效），`everyMinutes: 60`，默认策略，模板预算 `dailyUsd: 2`。脚本和明细在 `.superpowers/sdd/2026-10-30-duty-bots-phase1/task-22-report.md`。

| 来源 / 模型 | 运行 | 成功 | 跳过 | 每次费用 | 每次用时 |
| --- | --- | --- | --- | --- | --- |
| super-nb.me / claude-sonnet-5-5（档案默认） | 10（含 1 次 resume、1 次硬停） | 7 | 2（预检指纹没变 1、超预算 1） | 0.36–0.38 $（resume 只多 0.055 $） | 25–35 s |
| aizhongzhuan.cc / claude-opus-5-5（档案默认） | 2 | 0 | 0 | 0 | 179–200 s，中转 503「分组里没有这个模型的通道」 |
| aizhongzhuan.cc / deepseek-v4.1-flash（Bot 指定 model） | 4（3 次手动 + 1 次 60 分钟定时自己触发） | 4 | 0 | 记成 0（价格未知） | 65–70 s，定时那次 171 s / 30 个工具调用 |

- **验收通过率**：带验收脚本（工作区干净）的 10 次全部通过；但模型调用失败的那两次也「验收通过」——验收只看脚本，run.ok 另由 isError 判。
- **收件箱**：finding 16（每次一条报告 + 预算用完一条）、草稿 4、approval 13——批了 1 条，其余 12 条里 11 条出自 deepseek 那 4 次：它每次都想在 cwd 外的 Bot state 目录 `mkdir` / `rm` 检查点、把 `gh` 输出管道给 `python -c`（opaque → 要问）；sonnet 只在探针里问了 push 和删检查点。
- **approve → resume 接上**：同一 sessionId、`trigger: resume`，被批的 push 审计依据 `user`、真执行（没有 nowhere remote，退出 128）。
- **硬停**：跑到第 12 s 时 `bots.stop` → 0.80 s 后运行记录结束（「被停下了」），`bots.load.running` 1 → 0。
- **闸覆盖**：每次 transcript 的 tool_use 数 = 审计行数（唯一的差是被 SDK 取消、没执行的并行调用）；`ExecuteExtraTool` 按里面的真工具记审计；`state/<routine>.checkpoint.md` 的 Write 放行（do）。
- **档位 → 模型**：两个中转都是 Anthropic 档案（kind=claude），balanced 不映射，用档案默认模型；不需要路由组。档案默认模型在中转分组里没通道时 Bot 不回退，要给 Bot 指定 model。
- **要改的**：① 模板 `dailyUsd: 2` 在 sonnet 中转上只够 ~6 次（每次新对话大半是 cache 写），每小时一次的模板中午前就停；② 价格未知的模型费用记 0，预算闸管不住；③ 同一个 `memory_write` 一次判 write_local 放行、一次判 send 要问；Bot 自己 state 目录下的 `mkdir` / `rm` 也要问（在 cwd 外）。
- **实测之后改的**（2026-10-31）：
  - 模板预算按例行的频率定（`templates.ts` 的 `dailyUsdFor`）：每天次数 × 0.40 $ × 1.25，取整，最少 2 $、最多 15 $；每小时一次的 `pr` 是 12 $。
  - 价格未知（`costUnknown`，中转上的 deepseek 等）不再记 0：按 token 用 Sonnet 价估一个数（`pipeline.ts` 的 `ledgerCost`），记 `costEstimated: true`，预算照算；运行列表费用前显示「约」。
  - `memory_write` 在 Bot 对话里一律是本地写：Bot 的记忆服务（`--bot`）不管模型填什么 scope 都只写 Bot 自己那份，所以带不带 scope、经不经 ExecuteExtraTool 都判 write_local（那次第二个调用多填了 scope）。
  - 命令行碰 state 目录照旧要问（接受）；提示词改成「检查点用 Write 写、做完用 Write 写成空，别用命令行碰 state 目录」（以前叫它「做完后删掉」，模型就去 `rm`）。
  - 对话失败（isError / 超时 / 进程退出）不跑验收脚本，`verified: { ok: false, skipped: true }`，列表上是「– 验收」，不再「验收通过」。
  - 来源没有这个模型的通道（503 No available channel / model_not_found / does not exist）：运行的错误直接说「这个来源上用不了模型 …，在 Bot 的设置里选一个这个来源有的模型」；回退模型留给二期。

## 聊天优先（A 批，2026-10-31）

spec `docs/superpowers/specs/2026-10-31-bots-chat-first-redesign.md` §7；计划 `docs/superpowers/plans/2026-10-31-bots-chat-first-A.md`；各任务记录 `.superpowers/sdd/2026-10-31-bots-chat-first-A/`。

- **Bot 的主对话（thread）= 一个 gated 的 Claude 对话，`botRole: 'thread'`**，id 存在 `bot.threadId`（服务端写）。`bots.start { name, avatar?, templateId?, cwd }` 建 Bot 并开它（service 方法叫 `startBot`，`start` 是服务自己的启动）；一期的 Bot 第一次 `bots.thread.open` 时补一个。`BotThreads`（`bots/thread.ts`）管它：`ensure` 开 / 接管 runner（池里有一个不 gated 的就先关掉），每个新 runner 先挂闸再发任何东西。
- **藏起来**：`SessionMeta.botId / botRole`（pool 开对话时按 params 记下）让对话列表、库搜索、sessions MCP 都不列它（`bots/hidden.ts` 的 `isBotSession`）；主对话、例行的运行、生成 / 内部的都算。以前漏出去的生成器对话没有 meta，按首句的老前缀认（`GENERATOR_PREFIX`）。
- **防止不 gated 地打开主对话**：窗口的 `session.open` 会被 `clientSessionParams` 去掉 `gated / botId / botRole`，所以 hub 先拦：`session.open` 的 sessionId 是某个 Bot 的主对话（不是分叉 / 回退）就交给 `bots.openThread`，窗口给的模型 / 模式 / 来源不管。IM、`send_to_session`、目标、分叉直接走池子，池子再兜一层：主对话不带 `gated` 打开就抛「这是 Bot 的对话，请从 Bot 页打开」。`refuseOnThread`（`hidden.ts`，hub 一进来就调）拒绝在主对话上 `session.setProvider` / `switchAgent` / `handoff.start`。界面上主对话不能分叉（`useForkable`）。
- **AskUserQuestion 在主对话里是例外**：闸本来把不认识的工具当「发出去」排进收件箱；`botRole === 'thread'` 时 AskUserQuestion 不过闸，走 canUseTool 弹选择卡给人答。开场卡最多 4 个选项（AskUserQuestion 的上限），A–D 是选项，「E 帮我写东西 / F 别的」写在问题里，靠卡片自带的「其它」。
- **隐藏块**：`<cw-bot-kickoff>`（开场）、`<cw-bot-events>`（用户上次说话以来发生的事）、`<cw-bot-continue>`（批准 / 拒绝之后叫它接着做）。只有服务端自己发的才算（`serverSend`：hub 的 `withEvents`、开场、continue）；`SessionRunner.send` 把别的路径（窗口、IM、peer、sessions MCP、目标）带进来的这些块去掉（`bots/tags.ts`）。transcript 里留着；网页只在 Bot 主对话里藏（`Conversation.botThread` 由 `SessionMeta.botRole === 'thread'` 定，`decodeAttachments(text, { bot })`），没闭合的标签或整条只有块的消息用 `‹` 显示不藏。`withEvents` 把上次以来非 system 的时间线条目拼成 `<cw-bot-events>` 放在用户这句前面，`deliveredAt` 前移，每件事只说一次。
- **`timeline.jsonl` 和 `thread.json`**（每个 Bot 目录下）：时间线（system / run / approval / draft / proposal，卡片的数据从 inbox / runs 现取）和主对话的状态（lastLine、seenAt、deliveredAt）。**这两个不要租约就写**：主对话在哪台 server 上开就在哪台写，追加写 + 宽松读，两台都写也不坏；放到租约后面的话，不值班的那台上用户聊天就记不下来。未读数用每个 Bot 的索引（id 的时间、行数、文件大小），别的进程写过（大小变了）才重读；过 4000 行压到最新 2000 条。运行开始就有一张「在跑…」的卡（`onStarted`，同一个 `run:<id>`，结束时换成完成的那张）。
- **Bot 自己的工具**（`bots/self-mcp.ts`，进程内 MCP，每个安装一个名字 `cw-bot-<hex>`，存在 `bots/self-server.json`）：`bot_profile`、`routine_create / update / pause / delete / test`、`remember`、`propose_policy`。主对话的闸（`GateCtx.selfTools`，只在 `BotThreads.arm` 设）对这几个**确切的名字**直接放行、记审计（依据 `rule`，runId `thread-YYYYMMDD`）；例行的运行照常分级；runner 没加载这个服务（只聊天 / 精简工具）时不放行。例行要有 `until`（日期或用户说了才 `forever`），到期 tick 停掉；Bot 建的 cron 两次之间至少 15 分钟（看接下来 24 次）；update / pause / delete 只能动它自己建的（`selfMade`），失败停用的 / 到期的不能自己再开。审计按天的 `perDay` 只读 `runs/index.jsonl`，主对话的调用跨进程不计（小事）。
- **策略只能经采纳的提议改**：`propose_policy` 只放一张卡，用户「采纳」才写进 bot.json（放宽的规则必须带范围，送 / 付钱 / 删除或无限制先 `confirmRisk`）；`self-guard.ts` 照旧，另外写 `.mcp.json`、`.claude/settings*.json`、`~/.claude/settings*.json`、`~/.claude.json` 要问。第一个例行建好时提一张「规矩」卡（`{ type: 'rules' }`，按类列「先问我 / 直接做 / 不做」，「就这样」收起，「改一下」开资料栏的权限）。
- **主对话里的批准**：闸拒绝并排队的 approval 没有 routineId，带 `thread: true`、`sessionId = threadId`。批准 → 主对话的闸 `approveOnce`（同一次调用放行一次），再等它空闲发一条 `<cw-bot-continue>已批准「…」…`，不走 resumes.json；拒绝也发一条说不做。24 小时没答的过期（`THREAD_APPROVAL_MS`，tick 关成「已过期」，再答会报错）。卡片：拒绝 | 允许 ▾（仅这次 / 这次运行内 30 分钟 / 对这个目标总是 / 总是；opaque 的目标只有仅这次 / 总是），答过显示 已允许 / 已拒绝 / 已过期 / 已收起。主对话的轮次不受预算拦（费用 `threadUsd` 显示出来）。
- **界面**：桌面 Bot 页是三栏 `.bots-col-roster`（280px，`Roster.tsx`，顶上「Bot」+ ＋ 和搜索；需要你在前、总管 ★、隐藏的收起）| `.bots-col-thread` | `.bots-col-profile`。名册不放在应用侧栏里——侧栏收起时也要看得见（Grok 那样），所以 Bot 页在前时应用侧栏显示的是普通的对话列表（`App.tsx` 的 `SidebarColumn` 把 bots 当 chat），没有第二份名册；页面在桌面上也没有 `over-head` 那一行（`OverPage head={false}`，名册栏头已经写着 Bot，对话栏头是 Bot 自己的脸 + 名字 + 状态），手机照旧有。对话打开时 `BotThread` 拉一次 `bots.runs.list`；运行卡在记录到之前显示「例行 · 名字 · 时间」、「打开」灰着（`data-state="loading"`），不会是空卡。`BotThread.tsx`（`.bot-thread`，嵌 `ChatView extras` + `Composer variant="bot"`，卡片插在 `.chat-inner` 里按时间排）、`BotProfile.tsx`（资料 / 电脑 / 例行 / 权限 / 记忆 / 用量；「电脑」的最近画面从已加载的对话里的截图结果取，没有就「电脑闲着」）、`NewBot.tsx`（脸、名字、文件夹、14 个模板）。Esc：资料栏 → 新 Bot 页 → 关页；手机：资料 → 对话 → 名册 → 关页。
- **调试**：`window.__cwBots.inject({ timeline })` 放时间线条目；要看对话里的卡片，还得在 `__store` 的 `open[threadId]` 里有这个对话（ui-smoke 是把种子对话复制一份到 threadId 下，再 `__cwBots.open(id)`；点名册的行会真去 `bots.thread.open`）。
- **e2e（`ws-phase42.mjs` 后半段）**：假上游按系统提示词里有没有 `cw-bot-events` 认出主对话的请求（引擎的「下一句提示」旁路请求按 `[SUGGESTION MODE:` 跳过）。`bots.start` → 有 threadId、`sessions.list` 里没有；开场 → `permission.request` 的 AskUserQuestion（不进收件箱）→ 用 `updatedInput.answers` 答 → 模型调 routine_create（请求的 `tools` 里有就直接调，没有就先 `SearchExtraTools select:` 再 `ExecuteExtraTool`；服务名从 `<数据目录>/bots/self-server.json` 读）→ 例行 selfMade、有 until、有「规矩」提议、时间线有「已创建例行」、审计依据 rule；`session.open` + `session.send`「给我推一下」→ `thread: true` 的批准 + 时间线 approval 条目，那一轮的 `<cw-bot-events>` 只有「规矩」卡一件（建第一个例行时提的提议，下一句说一次），没有 push；批准 → 下一个请求里有「已批准」、push 放行（依据 user）；再说一句 → 用户文字以 `<cw-bot-events>` 开头、含「你批准了」，transcript 里有；删 Bot → 目录（含 timeline.jsonl）没了。
- **ui-smoke「bots」一段**：注入两个 Bot（attention 带 lastLine、running）、Bot 1 的时间线（system、完成的运行、thread 批准、规矩卡、在跑的运行）和它的对话（种子对话的副本）。查：名册是页面自己的一栏（`.bots-col-roster`）两行、需要你在前、每行有脸（data-state）和第二行，侧栏里没有名册、页面没有头一行，应用侧栏收起时名册还在；运行记录没到时两张运行卡是「例行 · 巡检 · 时间」+ 灰的打开，注入后在跑的那张「在跑… N s」、完成的「用时 42 s」+ 结论 + 打开；对话里 `.chat-inner` 的卡片按时间排；批准卡有 拒绝 / 允许，▾ 是 仅这次 / 总是（git push 没有域名 / 频道 / 收件人，是 opaque 目标，只有这两项）；规矩卡有 就这样 / 改一下；资料栏六节、电脑闲着；Esc 先关资料再关页；＋ → 新 Bot 页 14 张模板；总览 · 需要你还有那条批准；手机名册 → 对话 → 资料再 Esc 回来。截图 `bots-roster` / `bots-thread` / `bots-profile` / `bots-new` / `bots-phone-roster` / `bots-phone-thread`。
- **坑（真机找到的，2026-11-01）**：`openSession(…, 'none')` 本来不放进工作台，但它随后的「后台补读历史」`loadHistory(sid)` 默认 `focus`，又 `openInPane` 了——窗口跳回对话分区、Bot 页刚出来就被藏起来，Bot 的主对话成了普通对话的一个标签（能分叉、输入框写「回复 Claude」）。ui-smoke 是往 `__store.open` 里注入对话，不走 `openSession`，所以没测出来；`store.test.ts` 现在查 `'none'` 的恢复不动布局。截图要在干净的 localStorage 下（布局还存在 localStorage 里），换 origin（`localhost` / `127.0.0.1`）或先 `localStorage.clear()`。
- **坑（真机找到的，2026-11-01）**：例行的 finding 以前算进「需要你」——收件箱页没了以后没人归档它，每天跑的例行让 Bot 永远停在需要你、「N 件事等你点头」越来越多。现在服务端 `pendingInbox`、名册 `pendingByBot`、侧栏 / 总览 `pending`、总览的列表都只数要拍板的（approval / draft / proposal）；finding 就是对话里的运行卡，新的算在 unseen 里。
- **带范围的规矩管不到按名字的 remote**：`git push origin` 的目标看不清（opaque，一期刻意的：Bash 工具的工作目录跨调用保留，闸不知道 `origin` 是哪个仓库的），带范围的 `do` 规则永远匹配不上——真机上 Bot 提了一条 `recipients: ["origin (路径)"]` 的规矩、用户采纳了、下次推送照样问，Bot 还编了个原因（「因为有 git commit」）。现在：闸在「有这类带范围的规矩、但目标看不清」时把原因写进拒绝信息（按 https 地址推送才会匹配）；`propose_policy` 的说明写明各范围匹配什么（recipients 不是 git remote，文件夹 / ssh 的 remote 不能设范围，要跟用户说会一直问）；主对话的系统提示说策略只看 Bot 自己的，Claude Code 的 allow / 权限模式管不到它（它建议过去 settings.json 放行），被拦只说系统给的原因。旧对话里模型自己说过的错话会跟着历史走，新对话里是对的。
- **真机实测（2026-11-01，super-nb.me / claude-sonnet-5-5，装好的 0.4.6 + 修正后的仓库构建，临时 HOME）**：建 Bot → 11.2 s 开场选择卡（A–D + 其它）→ 回答后 14.7 s 自己建例行（cron `0 9 * * *`、until 11-30、selfMade）+ 规矩卡，这段 $0.36；例行手动跑 2 次 18–21 s、$0.31–0.32、工具调用数 = 审计行数；批准卡 → 批准 → 接着做（真推到本地 bare 仓库）、拒绝 → 不做并说明；`propose_policy` 只出卡、采纳后才写进策略；用户再说话时 `<cw-bot-events>` 带上运行结论和批准结果（运行结论以前截在 200 字，现在 1200）；模板开场（PR 巡检）「我按『PR 巡检』来」+ 两个问题。三个 Bot 一共 $0.63（今天）+ 主对话各 $0.36 左右。
- **坑（e2e 找到的，2026-10-31，T13）**：进程内 MCP 的工具 schema 里有 `z.record(...)`（zod/v4，哪怕嵌在数组的对象里）时，SDK 的 `tools/list` 整个抛 `Cannot read properties of undefined (reading 'push')`，**这个服务一个工具都没有**——ccb 的 `SearchExtraTools` 说找不到，`ExecuteExtraTool` 回 `result: null`，模型以为做了。`propose_policy` 的 `scope: z.record(z.string(), z.unknown())` 就是这样把 Bot 的八个工具全弄没了；换成写明字段的 `z.object({...})` 或 `z.looseObject({})` 就好。查法：`InMemoryTransport.createLinkedPair()` 连上 `createSdkMcpServer(...).instance`，`client.listTools()`。self-mcp 的单测直接调 handler，看不出来。
