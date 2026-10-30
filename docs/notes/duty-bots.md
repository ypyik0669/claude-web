# 值班 Bot（2026-10-30）

spec：`docs/superpowers/specs/2026-10-30-duty-bots-design.md`；一期的计划和各任务记录在 `.superpowers/sdd/2026-10-30-duty-bots-phase1/`。Bot = 住在电脑里、按例行（Routine）定时干活的 Claude 对话，动作过一道策略闸，要人拍板的事进收件箱。

- **目录**：`<CLAUDE_WEB_DIR>/bots/`。每个 Bot 一个目录 `<id>/`：`bot.json`（章程、例行、策略、预算、输出）、`runs/index.jsonl`（每次运行一行，同 id 再追加一行、读时取最后一行）、`runs/<runId>.audit.jsonl`（这次运行每个工具调用的判定：级别、依据、规则、结果）、`state/<routineId>.json`（预检指纹、上次结论、检查点）、`state/<routineId>.checkpoint.md`（长任务的进度，Bot 自己写）、`trust.json`（批准次数）。根上：`inbox.json`、`scheduler.lock`(+`.take`)、`stop.request.json`、`held.json`（勿扰时段攒下的 IM 推送）。服务端代码 `server/src/bots/`，前端 `web/src/features/bots/`。
- **流水线**（`pipeline.ts` 的 `runRoutine`）：预检脚本 → 指纹没变就跳过（`skipped`）→ 开一个新对话（resume 时开原来那个）→ 先挂上闸再发提示词 → 等 result / 超时 / 硬停 → 验收脚本 → 写运行记录 → 输出（收件箱 finding、`<draft>` 进草稿、追加文件；IM 由 service 推）。连续失败 3 次停用这条例行。费用是这个对话在账本里的累计。
- **`drivenBy: 'schedule'` 复用定时任务的那个值**：意思是「没人坐在窗口前」，runner 不加给人看的提示（节点图提示等），不新加一个枚举。真正区分 Bot 对话的是 `gated: true`（服务端设的，窗口发来的 `session.open` 会被 `clientSessionParams` 去掉）。
- **策略闸只在 Claude 的对话上**：Codex / ACP 不认 `gate`，开出来不是 gated 的直接判失败（「对话不经过策略检查」），不跑。**gated 对话用 SDK 的 PreToolUse hook**，不是 canUseTool：settings 的 allow 规则、权限模式、`allowedTools`（MCP 工具全在里面，SDK 会警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`）都会让 canUseTool 根本不被调用。hook 自己 600 s 超时、闸 590 s 不答就拒绝；闸里出任何错都是拒绝（fail closed）——放过去就会弹一张没人看的权限卡。canUseTool 那边只复用 hook 的答案。
- **「要问」= 拒绝并排队，不挂起**：挂着等人批，SDK 会一直等、整轮卡死、超时也算在这次运行上。现在是拒绝这一步（告诉模型「已放进收件箱，先做别的」）、收件箱加一条 approval、运行照常结束；批准后用同一个对话 resume（`trigger: 'resume'`），`approveOnce` 让完全相同的那次调用（工具名 + 键排序的 input 的 sha1）放行一次，审计依据 `user`。
- **级别**：`deny` 永远先看（范围只要碰到一个值就算）→ 放开（`unleashed`）→ 自动驾驶 → 带范围的规则 → 不带范围的规则 → 默认（读 / 本地写 / 浏览器做，装东西做了告诉我，发出去 / 付钱 / 删除要问）。
- **带范围的 `do` 规则对 shell 只认得清楚的**：纯 HTTP 客户端（curl / wget / irm / iwr）和 `git push <https-url>`；其它（裸主机、ssh、代理、展开出来的目标、`git -c` / 会执行程序的传输方式…）都是 opaque，只能走要问。审批时可以带范围（域名 / 频道 / 收件人 / 金额上限 / 到期，或明确同意的「无限制」），范围必须写明用在哪儿，付钱的要写上限。**已知的类级绕过留给二期隔离**：`python -c`、`node -e`、`git -c core.fsmonitor=…`、`npm exec -c …` 这类「让解释器跑任意代码」的写法，一期的分类器看不穿。
- **调度租约**：`scheduler.lock` 记 pid / host / instance / 时间，`.take` 用 `wx` 独占创建保护「读 → 写 → 再读」，两个进程（桌面版和无窗口的值班服务）同时发现租约过期也只有一个拿到。只有持有者跑 Bot、写 bot.json / inbox.json；别的窗口点「停」写 `stop.request.json`，持有者 watch + 每次 tick 取走执行。丢了租约的调度器立刻停掉在跑的运行。tick 30 s。
- **默认来源是 API / 网关**（设置 `bots.defaultProvider`），不是 Claude 订阅：无人值守的自动化跑在订阅上不合服务条款。档位（便宜 / 平衡 / 最好）只在智能路由组上映射成策略虚拟模型，Claude 上「最好」= opus，其它来源用它自己的默认模型。
- **值班模式**（`duty.ts`，设置里的开关，`bots.duty.install`）：把 server 注册成本用户的无窗口服务，关了窗口 Bot 照跑。Windows 是登录任务 → wscript 隐藏跑 `duty.vbs`（崩了重启、见到 `duty.stop` 或 `duty.cmd` 没了就停）→ `duty.cmd` 设好环境起 server，pid 写 `duty/duty.pid`；mac / Linux 是 launchd / systemd 用户单元。和桌面版谁跑 Bot 由上面的租约定。
- **预检 / 验收脚本**：Windows 走 `powershell.exe`，其它 `sh`；硬停会杀掉正在跑的脚本。
- **总管**：一期只是占位——内置、不能删、不能有例行，不干活；转派是二期。
- **界面**：设置在「通用」页里的「值班 Bot」一块（设置页数上限 15，不另开一页）。新建对话框的「保存并先跑一次」是真跑一次（不是影子模式，影子模式在二期）。桌面版收件箱在总览（右侧面板 mission）的「需要你」里，手机上是 Bot 页的第一个标签。
- **调试**：`CLAUDE_WEB_DIR=/tmp/x npm start`（别碰自己的 `~/.claude-web`），建一个 Bot，`bots.runNow`，看 `bots/<id>/runs/index.jsonl` 和 `runs/*.audit.jsonl`；对话本身在对话列表里。`window.__cwBots.inject({ bots, inbox, runs, load })` / `open(id)` / `state()` 是前端调试入口（服务端下次推送会覆盖，tick 每 30 s 推一次 load）。
- **测试**：`node server/ws-phase42.mjs`（e2e 默认列表里，自己起 server）：真引擎（ccb）+ 假 Anthropic 上游，不花 token——模板 14 个、建 Bot、跑一次（finding、费用是数字）、`git push origin main`（仓库没有 remote，不出网）被闸拒绝进收件箱、批准后 resume 同一对话且这次放行、放开后不再问、在上游挂住时硬停、总管删不掉。ui-smoke 的「bots」一段用注入的数据：两行、负载条「在跑 1」、新建对话框 14 张模板、Esc 先关对话框再关页面、总览里两条带「批准」。
- **坑**：e2e 的阶段脚本自己起 server 时要设 `CLAUDE_WEB_SYSTEM_LANG: 'zh-CN'`，不然单跑时闸的提示是英文，断言中文会失败。跑 e2e 前先 `npm run build -w server`（脚本跑的是 `server/dist`）。
