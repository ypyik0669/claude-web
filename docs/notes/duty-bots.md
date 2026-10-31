# 值班 Bot（2026-10-30）

spec：`docs/superpowers/specs/2026-10-30-duty-bots-design.md`；一期的计划和各任务记录在 `.superpowers/sdd/2026-10-30-duty-bots-phase1/`。Bot = 住在电脑里、按例行（Routine）定时干活的 Claude 对话，动作过一道策略闸，要人拍板的事进收件箱。

- **目录**：`<CLAUDE_WEB_DIR>/bots/`。每个 Bot 一个目录 `<id>/`：`bot.json`（章程、例行、策略、预算、输出）、`runs/index.jsonl`（每次运行一行，同 id 再追加一行、读时取最后一行）、`runs/<runId>.audit.jsonl`（这次运行每个工具调用的判定：级别、依据、规则、结果）、`state/<routineId>.json`（预检指纹、上次结论、检查点）、`state/<routineId>.checkpoint.md`（长任务的进度，Bot 自己写）、`trust.json`（批准次数）。根上：`inbox.json`、`scheduler.lock`(+`.take`)、`stop.request.json`、`held.json`（勿扰时段攒下的 IM 推送）。服务端代码 `server/src/bots/`，前端 `web/src/features/bots/`。
- **流水线**（`pipeline.ts` 的 `runRoutine`）：预检脚本 → 指纹没变就跳过（`skipped`）→ 开一个新对话（resume 时开原来那个）→ 先挂上闸再发提示词 → 等 result / 超时 / 硬停 → 验收脚本 → 写运行记录 → 输出（收件箱 finding、`<draft>` 进草稿、追加文件；IM 由 service 推）。连续失败 3 次停用这条例行。费用是这个对话在账本里的累计。
- **`drivenBy: 'schedule'` 复用定时任务的那个值**：意思是「没人坐在窗口前」，runner 不加给人看的提示（节点图提示等），不新加一个枚举。真正区分 Bot 对话的是 `gated: true`（服务端设的，窗口发来的 `session.open` 会被 `clientSessionParams` 去掉）。
- **策略闸只在 Claude 的对话上**：Codex / ACP 不认 `gate`，开出来不是 gated 的直接判失败（「对话不经过策略检查」），不跑。**gated 对话用 SDK 的 PreToolUse hook**，不是 canUseTool：settings 的 allow 规则、权限模式、`allowedTools`（MCP 工具全在里面，SDK 会警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`）都会让 canUseTool 根本不被调用。hook 自己 600 s 超时、闸 590 s 不答就拒绝；闸里出任何错都是拒绝（fail closed）——放过去就会弹一张没人看的权限卡。canUseTool 那边只复用 hook 的答案。
- **「要问」= 拒绝并排队，不挂起**：挂着等人批，SDK 会一直等、整轮卡死、超时也算在这次运行上。现在是拒绝这一步（告诉模型「已放进收件箱，先做别的」）、收件箱加一条 approval、运行照常结束；批准后用同一个对话 resume（`trigger: 'resume'`），`approveOnce` 让完全相同的那次调用（工具名 + 键排序的 input 的 sha1）放行一次，审计依据 `user`。
- **级别**：`deny` 永远先看（范围只要碰到一个值就算）→ 放开（`unleashed`）→ 自动驾驶 → 带范围的规则 → 不带范围的规则 → 默认（读 / 本地写 / 浏览器做，装东西做了告诉我，发出去 / 付钱 / 删除要问）。
- **带范围的 `do` 规则对 shell 只认得清楚的**：纯 HTTP 客户端（curl / wget / irm / iwr）和 `git push <https-url>`；其它（裸主机、ssh、代理、展开出来的目标、`git -c` / 会执行程序的传输方式…）都是 opaque，只能走要问。审批时可以带范围（域名 / 频道 / 收件人 / 金额上限 / 到期，或明确同意的「无限制」），范围必须写明用在哪儿，付钱的要写上限。**已知的类级绕过留给二期隔离**：`python -c`、`node -e`、`git -c core.fsmonitor=…`、`npm exec -c …` 这类「让解释器跑任意代码」的写法，一期的分类器看不穿。
- **Bot 改不了自己的策略和审计**（`policy/self-guard.ts`，放开了也一样）：Write / Edit / MultiEdit / NotebookEdit 落在 `bots/` 下就拒绝，只有这个 Bot 自己的 `state/` 例外；路径先 resolve、realpath（junction / 8.3 / `..`）、Windows 上大小写折叠。网络路径先折回本机盘符：`\\localhost\c$\…`、`\\127.0.0.1\…`、`\\<本机名>\…`、`\\?\UNC\…`、`\\.\C:\…` 都当 `C:\…` 判（验收时发现过 `\\localhost\c$` 绕过）；折不回来的共享（别的主机、命名共享）要问。映射盘符（`net use V: \localhostc# 值班 Bot（2026-10-30）

spec：`docs/superpowers/specs/2026-10-30-duty-bots-design.md`；一期的计划和各任务记录在 `.superpowers/sdd/2026-10-30-duty-bots-phase1/`。Bot = 住在电脑里、按例行（Routine）定时干活的 Claude 对话，动作过一道策略闸，要人拍板的事进收件箱。

- **目录**：`<CLAUDE_WEB_DIR>/bots/`。每个 Bot 一个目录 `<id>/`：`bot.json`（章程、例行、策略、预算、输出）、`runs/index.jsonl`（每次运行一行，同 id 再追加一行、读时取最后一行）、`runs/<runId>.audit.jsonl`（这次运行每个工具调用的判定：级别、依据、规则、结果）、`state/<routineId>.json`（预检指纹、上次结论、检查点）、`state/<routineId>.checkpoint.md`（长任务的进度，Bot 自己写）、`trust.json`（批准次数）。根上：`inbox.json`、`scheduler.lock`(+`.take`)、`stop.request.json`、`held.json`（勿扰时段攒下的 IM 推送）。服务端代码 `server/src/bots/`，前端 `web/src/features/bots/`。
- **流水线**（`pipeline.ts` 的 `runRoutine`）：预检脚本 → 指纹没变就跳过（`skipped`）→ 开一个新对话（resume 时开原来那个）→ 先挂上闸再发提示词 → 等 result / 超时 / 硬停 → 验收脚本 → 写运行记录 → 输出（收件箱 finding、`<draft>` 进草稿、追加文件；IM 由 service 推）。连续失败 3 次停用这条例行。费用是这个对话在账本里的累计。
- **`drivenBy: 'schedule'` 复用定时任务的那个值**：意思是「没人坐在窗口前」，runner 不加给人看的提示（节点图提示等），不新加一个枚举。真正区分 Bot 对话的是 `gated: true`（服务端设的，窗口发来的 `session.open` 会被 `clientSessionParams` 去掉）。
- **策略闸只在 Claude 的对话上**：Codex / ACP 不认 `gate`，开出来不是 gated 的直接判失败（「对话不经过策略检查」），不跑。**gated 对话用 SDK 的 PreToolUse hook**，不是 canUseTool：settings 的 allow 规则、权限模式、`allowedTools`（MCP 工具全在里面，SDK 会警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`）都会让 canUseTool 根本不被调用。hook 自己 600 s 超时、闸 590 s 不答就拒绝；闸里出任何错都是拒绝（fail closed）——放过去就会弹一张没人看的权限卡。canUseTool 那边只复用 hook 的答案。
- **「要问」= 拒绝并排队，不挂起**：挂着等人批，SDK 会一直等、整轮卡死、超时也算在这次运行上。现在是拒绝这一步（告诉模型「已放进收件箱，先做别的」）、收件箱加一条 approval、运行照常结束；批准后用同一个对话 resume（`trigger: 'resume'`），`approveOnce` 让完全相同的那次调用（工具名 + 键排序的 input 的 sha1）放行一次，审计依据 `user`。
- **级别**：`deny` 永远先看（范围只要碰到一个值就算）→ 放开（`unleashed`）→ 自动驾驶 → 带范围的规则 → 不带范围的规则 → 默认（读 / 本地写 / 浏览器做，装东西做了告诉我，发出去 / 付钱 / 删除要问）。
- **带范围的 `do` 规则对 shell 只认得清楚的**：纯 HTTP 客户端（curl / wget / irm / iwr）和 `git push <https-url>`；其它（裸主机、ssh、代理、展开出来的目标、`git -c` / 会执行程序的传输方式…）都是 opaque，只能走要问。审批时可以带范围（域名 / 频道 / 收件人 / 金额上限 / 到期，或明确同意的「无限制」），范围必须写明用在哪儿，付钱的要写上限。**已知的类级绕过留给二期隔离**：`python -c`、`node -e`、`git -c core.fsmonitor=…`、`npm exec -c …` 这类「让解释器跑任意代码」的写法，一期的分类器看不穿。
- **Bot 改不了自己的策略和审计**（`policy/self-guard.ts`，放开了也一样）：Write / Edit / MultiEdit / NotebookEdit 落在 `bots/` 下就拒绝，只有这个 Bot 自己的 `state/` 例外；路径先 resolve、realpath（junction / 8.3 / `..`）、Windows 上大小写折叠。网络路径先折回本机盘符：`\\localhost\c$\…`、`\\127.0.0.1\…`、`\\<本机名>\…`、`\\?\UNC\…`、`\\.\C:\…` 都当 `C:\…` 判（验收时发现过 `\\localhost\c$` 绕过）；）realpath 出来是网络形式，同样折回再判；建盘符 / 共享 / 链接的命令（net use、New-PSDrive、subst、mklink、New-Item -ItemType Junction…）要问。shell 命令里出现 bots 目录（`$HOME`、`%USERPROFILE%`、`../`、数据目录名等写法）要问。
- **调度租约**：`scheduler.lock` 记 pid / host / instance / 时间，`.take` 用 `wx` 独占创建保护「读 → 写 → 再读」，两个进程（桌面版和无窗口的值班服务）同时发现租约过期也只有一个拿到。只有持有者跑 Bot、写 bot.json / inbox.json；别的窗口点「停」写 `stop.request.json`，持有者 watch + 每次 tick 取走执行。丢了租约的调度器立刻停掉在跑的运行。tick 30 s。
- **默认来源是 API / 网关**（设置 `bots.defaultProvider`），不是 Claude 订阅：无人值守的自动化跑在订阅上不合服务条款。档位（便宜 / 平衡 / 最好）只在智能路由组上映射成策略虚拟模型，Claude 上「最好」= opus，其它来源用它自己的默认模型。
- **值班模式**（`duty.ts`，设置里的开关，`bots.duty.install`）：把 server 注册成本用户的无窗口服务，关了窗口 Bot 照跑。Windows 是登录任务 → wscript 隐藏跑 `duty.vbs`（崩了重启、见到 `duty.stop` 或 `duty.cmd` 没了就停）→ `duty.cmd` 设好环境起 server，pid 写 `duty/duty.pid`；mac / Linux 是 launchd / systemd 用户单元。和桌面版谁跑 Bot 由上面的租约定。
- **预检 / 验收脚本**：Windows 走 `powershell.exe`，其它 `sh`；硬停会杀掉正在跑的脚本。
- **总管**：一期只是占位——内置、不能删、不能有例行，不干活；转派是二期。
- **界面**：设置在「通用」页里的「值班 Bot」一块（设置页数上限 15，不另开一页）。新建对话框的「保存并先跑一次」是真跑一次（不是影子模式，影子模式在二期）。桌面版收件箱在总览（右侧面板 mission）的「需要你」里，手机上是 Bot 页的第一个标签。
- **调试**：`CLAUDE_WEB_DIR=/tmp/x npm start`（别碰自己的 `~/.claude-web`），建一个 Bot，`bots.runNow`，看 `bots/<id>/runs/index.jsonl` 和 `runs/*.audit.jsonl`；对话本身在对话列表里。`window.__cwBots.inject({ bots, inbox, runs, load })` / `open(id)` / `state()` 是前端调试入口（服务端下次推送会覆盖，tick 每 30 s 推一次 load）。
- **测试**：`node server/ws-phase42.mjs`（e2e 默认列表里，自己起 server）：真引擎（ccb）+ 假 Anthropic 上游，不花 token——模板 14 个、建 Bot、跑一次（finding、费用是数字）、`git push origin main`（仓库没有 remote，不出网）被闸拒绝进收件箱、批准后 resume 同一对话且这次放行、放开后不再问、在上游挂住时硬停、总管删不掉。ui-smoke 的「bots」一段用注入的数据：两行、负载条「在跑 1」、新建对话框 14 张模板、Esc 先关对话框再关页面、总览里两条带「批准」。
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
