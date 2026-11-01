# 续接位置 / 费用 / 切换竞态（2026-10-01～02，真中转实测）

用两个中转、12 个 key 花额度实测出来的，脚本和报告在会话 scratchpad 的 `relay-test/`（不入库）。当时还有我们自己的引擎 ccb（2026-11-01 删了，见「只留 Claude」），下面只留对官方 Claude Code 还成立的部分。

- **续接位置**（`runtime/transcript-file.ts`）：官方 Claude Code 从最后一个带 `leafUuid` 的 `last-prompt` 接。`repairLeaf()` 在续接前、以及每个回合 result 之后（等这一轮最后一个回答落盘 `flushed()` 再 1.5 s）追加一条指向最新链条目的 `last-prompt`。最后一个带 leaf 的 `last-prompt` 写在所有链条目之后时（终端里 `/rewind` 过），以它为准、不动。`resumeSessionAt` 不能用来修这个：它是截断式 resume，会分叉。（历史：起因是 ccb 写的 `last-prompt` 不带 `leafUuid`，ccb 跑过的轮次换回官方后会被岔掉；老对话里还有这种轮次，修复照样管用。）
  - **官方二进制自己只在发出 prompt 时和进程退出时写 leaf**（2026-10-02 实测）：发 prompt 时写的 leaf 是回答之前那一条，退出时写的是它自己知道的最新一条（和 `cost-state` 一起）。所以它闲置时文件里的 leaf 一直落后一个回答，这时候在终端里 `claude --resume`，会丢掉网页最后那个回答。上面这条 result 后的修复就是为它加的。
  - 因为终端写入（`wroteElsewhere()`）而关掉一个闲置的官方进程时，它退出时写的 leaf 落在终端那几轮**后面**，看上去像一次 `/rewind`，下一次续接又会把终端那几轮岔掉。`pool.transcriptChanged()` 改走 `runner.yieldToOutside()`：关之前记下文件大小，关完之后调用 `repairLeaf(file, id, {ignoreLeavesFrom: 大小})`，从那个位置起写的 leaf 不算；如果终端在这之前 `/rewind` 过，就把它重新写到最后。
- **官方二进制把累计费用存在 transcript 的 `cost-state`**，续接时接着累计（`lastCostState()`）。
- **`result.total_cost_usd` / `modelUsage` 是进程内的累计值**（sdk.d.ts：「read the latest result rather than summing」），`usage` 才是每轮的。下游（composer 合计、账本、目标、IM、编排）全按每轮相加。`usage/turn-cost.ts` 的 `turnShare()` 在 runner 里把每个 result 改写成本轮的份额，进程累计值放在 `session_cost_usd`，`modelUsage` 只留本轮涨了的模型（账本按第一个键记模型）。计算规则：
  - 起点：transcript 最后一个 `cost-state`；
  - 累计值变小（换了进程、`/clear`）就当作重新开始；
  - 全零的 result（强制停止、启动失败）不动累计值。
- **改档 / 深度编排**：Claude Code 没有运行时的强度控制，`setEffort` / `setUltracode` 往对话里发 `/effort …`（改档同时离开深度编排）；开对话时就选了深度编排在第一条消息之前补发。见「思考强度 / 深度编排」。runner 的 `plan()` 返回 `{engine, key}`（key 只看压缩点和子代理模型），key 变了就重开进程；正在回答时等这一轮的 result 再重开（`respawnWhenIdle()`，不截断回合，后台子代理 / 工作流还在跑也等）。
- 历史（ccb 删了，代码也没了）：ccb 按模型名决定 thinking 导致 claude-opus-5-5 在中转上 400 的绕行（`ccbMisthinks` / `preferredRuntime`）、`ccbAccountEnv()`、`applyFlagSettings({effortLevel, ultracode})` 改档、ccb 不认 `--session-mirror`、交回 Claude 时其它 agent 镜像的 `.parked-<agent>`。
- **CLI 的 stderr**：自定义 `spawnClaudeCodeProcess` 时 SDK 不读它，所以错误只剩「exited with code 1」，没人读的管道还可能写满。runner 的 `spawnProcess()` 自己读：每行加 `[claude xxxxxxxx]` 前缀写进 server.log，留最后 4000 字；出错时 `cliSaid()` 取最后 3 行，拼成「（CLI 输出：…）」。
- **旧进程要真的结束**：SDK 的 close 在进程退出之前就 resolve，而且 Windows 上要等 2 s + 5 s 才杀。这期间旧进程还会替旧供应商答完一轮、扣费，窗口里看不到；同一个 id 上的新进程偶尔报「Session ID … already in use」。`endProcess()` 在 `respawn()` / `close()` 里给它 1.5 s 写完 transcript，然后 kill，再等最多 2 s。
- **切换竞态**（`session/swap.ts`）：
  - `openOnProvider` 对已有 id 的普通 open 也加会话锁。以前切换中途另一个窗口一开，就在旧供应商上起了进程，切换拿回这个进程、却记下了新供应商。
  - hub 的 `session.send / setModel / setEffort / setPermissionMode / setUltracode` 先 `await afterSwitch(id)`。以前切换那一两秒里发的消息报「session … is not open」，直接丢了。
  - `swapProviderNow` 打开后，发现进程跑的不是要的供应商（IM / 定时任务走 pool 不经锁、恰好在空档里开了它），就关掉重开。
  - 回合进行中被切换，补一个 `terminal_reason:'aborted_swap'` 的 result：编排节点忽略它，由 swapped 路径决定；目标会变成 blocked。
  - 切回账号显式传 `providerId:'claude'`。以前传 undefined，pool 会按记录接着用旧供应商；hub 的 `session.setProvider` 也收 `'claude'`。
- **终端里接着网页上闲置的对话聊**：runner 记下自己发过的 prompt uuid（`send()` 现在总是带 uuid），再加上启动时磁盘上最后一条 prompt。transcript 变化时，`pool.transcriptChanged()` → `wroteElsewhere()`：进程闲置满 3 s，而且最后一条人打的 prompt（`lastHumanPrompt()`，不算 tool_result / meta / `<command…>` / 压缩摘要 / 子代理）不是它发的 → 关掉这个 runner。窗口状态变成 closed，于是重读；下一条消息从磁盘续接。以前网页的下一轮用的是旧上下文，还把终端那几轮岔开、永久丢了。
- **分叉**前 `runner.flushed()` 等最多 3 s，直到上一个回答的 uuid 出现在 transcript 里（只看文件末尾 4 MiB）。CLI 在 result 之后约 2 s 才写最后一个回答，以前紧接着分叉会丢掉它。
- **测试连接**：
  - `--no-session-persistence`：以前每测一次都在 `其它文件夹 › Temp` 留一个「Reply with exactly: ok」对话，欢迎页的默认目录也被带偏；
  - `CLAUDE_CODE_MAX_RETRIES=1`；
  - 超时直接说超时（`runClaudeCli` 返回 `timedOut`）；
  - 列表里一个聊天模型都没有（只有图片模型的 key）就直接这么说。模型菜单和会话的模型列表也用 `isChatModel` 过滤。
- 在 bash 里用 `node -e` 改文件时，脚本里的 `\\d`、`\\(` 会被吃掉一层反斜杠（这次出过三次：`\w` 变成 `w`、`\d{2}` 变成 `d{2}`、`\s*\(` 变成 `s*(`）。正则用 Edit 改，改完 grep 一遍确认。
