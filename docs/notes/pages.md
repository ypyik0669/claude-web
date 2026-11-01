# 页面与入口：总览栏 / 定时任务补跑 / 预览服务器 / 更新内容 / 只聊天 / 跨对话生成文件 / 快捷键（2026-10-16）

五期「赶上官方桌面版」路线的最后一期。spec：`docs/superpowers/specs/2026-10-16-pages-design.md`。依据：官方 `desktop.md`
（Preview your app、Configure preview servers、Keyboard shortcuts、Accept a suggested prompt）、`desktop-scheduled-tasks.md`、
`claude-projects.md`（Overview）。

## 盘点时发现已经有的（别再做一遍）

定时任务的预设（每小时 / 每天 / 工作日 / 每周 + 时间，`SchedulesView` 的 `PRESETS`）、立即运行、扩展页（连接器 / Skills / 插件——就是
官方的 Customize）、右侧「生成的文件」、内置浏览器和 `web` MCP、快捷键速查、右侧面板的「总览」（`MissionPanel`）。

## 总览栏

- 没有另做一页：右侧面板本来就有「总览」（`features/panels/MissionPanel.tsx`，需要你 / 运行中 / 出错 / 空闲）。补了官方的 **待审**（分支有
  开着的 PR）、**落地中**（PR 已批准或开了自动合并）和「显示已解决」（最近 7 天归档的）。分栏是纯函数 `mission-lanes.ts` 的 `laneOf`。
- PR 数据不另开轮询：用 PR 条的共享缓存（`PrBar.tsx` 导出的 `usePrs`）。只有 PR 条看过的对话才进待审 / 落地中。审查结论来自
  GraphQL 的 `reviewDecision` → `BranchPr.review`。
- 官方 Projects 的云线程不做；协调者对话用第 4 期的跨对话工具代替。

## 定时任务

- **补跑**（`schedules/catch-up.ts` 的 `missedRun`）：错过 3 分钟以内算准时；7 天内错过的补跑一次（下一次从现在算，所以只补最近那次），
  并发 `notice`（`ServerEvent`，前端 toast，窗口不在前台时桌面通知）；更早的丢掉、重算下一次。以前是「过期 12 小时就重算」，电脑睡一晚
  早上的任务就没了。tick 每 30 秒一次，所以电脑醒来也走这条（不需要 powerMonitor）。
- **手动**（`manual`）：只有「立即运行」会跑。「立即运行」现在不改下一次的定时（以前每点一次往后推一个周期）。
- **每次在独立 worktree 跑**（`worktree`，只在「每次新开对话」时可选）：`--worktree sched-<任务 id 前 6 位>-<MMDDHHmm>`。
- 运行记录 `ScheduleRun.catchUp`。

## 只聊天

- 新对话「＋」菜单里的开关，只管这一个新对话（不做成默认值：默认会悄悄拿掉所有对话的工具）；附件行出现「只聊天 ×」标签。
- runner：`tools: []`（引擎自己的工具全关）、`strictMcpConfig: true`（用户设置文件里的 MCP 也不加载）、`mcpServers: {}`、不预授权、不加网吧插件。
- 会话 meta `chatOnly`，恢复 / 再打开时 hub 补回 `features.chatOnly`（features 本身不按对话存）。开着的只聊天对话输入框里有固定标签。
- 真引擎实测（官方二进制 haiku）：init 里 `tools: []`、`mcp_servers: []`，问它列文件 → 「NO TOOLS」，零工具调用。

## 更新内容

- `app.changelog { lang }` → 当前界面语言的 CHANGELOG 最近 5 版（`server/src/app/changelog.ts`；中文找 `CHANGELOG.zh-CN.md`，没有退回英文）。
  两份文件进了 `electron-builder.yml` 的 `files`（打包版在 `app.asar` 根，和开发时的仓库根一样是 `server/dist/app/` 往上三级）。
- 更新后第一次打开自动弹一次（`ui.lastSeenVersion` 和当前版本不同）；新装的只悄悄记下版本。命令面板「更新内容」、设置 → 应用更新里也能开。
  没做标题栏按钮：外框控件有计数测试，图标栏「更多」菜单的项数 ui-smoke 也在数。

## 跨对话的生成文件

- `artifacts.list` → `library/artifacts.ts`：最近 50 个本机 Claude 对话的 Write / Artifact，只收网页 / 文档 / 图片 / pdf / csv 这类
  （代码不算），文件还在的，新的在前，带来源对话。右侧面板 → 文件里一个可展开的组「最近所有对话生成的文件」，展开才去扫。

## 预览服务器

- 格式照官方 `.claude/launch.json`（`preview/launch.ts`）：允许注释和尾逗号，`port` 默认 3000，localhost 的 `url` 只能是同端口的 origin。
- `PreviewService`（`preview/service.ts`）：同一项目同一配置只起一个；`resolveSpawn`（Windows 上 `npm` 这类 `.cmd` 不经 shell）+ `killTree`；
  env = 本机环境变量 + 配置 env + `PORT`；端口被占：`autoPort: true` 换空端口、`false` 报错、没写报错并告诉怎么改；等端口通最多 60 秒，
  进程先退出就带最后 30 行输出报错；输出留最后 2000 行；应用退出时全停。
- 工具（`preview/tools.ts`，进程内 MCP）：`preview_start`（**不**预授权——起进程等于跑命令，第一次要用户批准）、
  `preview_logs`、`preview_stop`。起好后用 `web.browser(sid, 'open', { url })` 在内置浏览器打开。
- 自动验证：项目有 launch.json 且 `autoVerify !== false` 时，system prompt 追加一段「改完会影响运行结果的代码后，preview_start、截图 /
  读页面、看日志，修好再结束这一轮」。
- 真引擎实测（官方二进制 haiku，2026-10-16）：问权限 → 起在 4318 → 打开浏览器 → `preview_logs` 读到 `ready on 4318`。
- 没做：浏览器标签上的「停止」按钮、选中页面元素、Chrome 扩展。

## 快捷键与小交互

`Ctrl+/` 快捷键速查（F1 / ? 照旧；代码编辑器和终端里不拦，那里是注释）；下一句提示按 `→` 也能采用；打开的菜单里按 `1`–`9` 选第 N 项
（`dir-menu.ts` 的 `menuKey` 返回 `{ pick }`，Popover / 目录菜单都认）。

## 坑

- server 里 `server/src/<目录>/x.ts` 到仓库根是三级 `../../..`，不是两级（`changelog.ts` 第一版就错在这）。
- 菜单项的 `data-id` 必须来自 `features/composer/ids.ts` 的表（`reach.test` 会拦字面量）。
- 会话 meta 的类型有两份：`server/src/meta/store.ts` 的和 `protocol.ts` 的 `SessionMeta`，加字段两边都要加。

## 独立验证查出、已修（2026-10-16）

- 预览：Windows 上 `npm` 这类 `.cmd` 没加 `windowsVerbatimArguments`，Node 把引号又转义一次——命令找不到，参数里的 `&` 还会执行第二条命令；
  端口只查 127.0.0.1，Vite 在 `localhost`（Windows 上是 ::1）永远等不到、别人占在 ::1 / 0.0.0.0 的端口被当成空的；两次 preview_start 同时来
  会起两个、第一个成了孤儿。现在 `portFree` 查四个地址、`connects` 试两个回环、同一配置并发共用一次启动、`cwd` 不许出项目。测试里有真的 `.cmd`。
- 只聊天：以前只有窗口打开对话那条路补回 `chatOnly`；别的对话发消息、IM、目标、定时任务、换供应商重开都会把工具还回去，分叉也记在了临时 id 上。
  现在由 `RunnerPool.open` 统一从 meta 补，分叉在 CLI 给出真 id 时记。
- 「立即运行」碰上对话正忙 / 失败，不再改下一次的定时，也不说「1 分钟后重试」（手动任务没有定时器去重试）。
- 跨对话的生成文件：同一个文件路径写法不同（大小写、斜杠）只列一次。菜单数字键不数 + 菜单里的「频道」输入框。
- 已知限制（没改）：preview_start 的审批卡只显示配置名，不显示要跑的命令；选了「总是允许」后，Claude 改了 launch.json 再起也不会再问。

## 发布：产物的本机分享链接（阶段 F5，2026-10-25）

- 入口：文件右键「发布…」、生成的文件列表每行的分享按钮、命令面板「已发布的文件」。`server/src/publish/core.ts`（纯）+ `service.ts`；界面 `web/src/features/cloud/CloudDialogs.tsx`（PublishDialog / PublishedDialog）。
- 快照：页面本身 + 它用相对路径引用的、在同一文件夹里的文件（`localRefs` / `snapshotFiles`，最多 200 个、50 MB）复制进 `~/.claude-web/published/<id>/`；`index.json` 在 published 根上（不在任何快照目录里）。id = `randomBytes(16)` 的十六进制。重新发布 = 同 id 换快照（先写 `<id>.tmp-*` 再改名）。
- 路由 `/p/<id>/<path>` 在 HTTP handler **最前面**（主监听和远程监听共用一个 handler，所以局域网也能开），不看令牌也不接受令牌；`/p/` 开头的一切都归它：不是活快照里的文件一律 404（不会掉到静态文件把 app 的 index.html 给出去）。用 **原始 `req.url`** 判断（`new URL()` 会把 `/p/<id>/../x` 规范成 `/p/x`）；`resolveInside`：解码后拒绝 `..` 段、空字节、绝对 / 盘符路径，`resolve` + `realpath` 后必须在快照目录里（符号链接 / junction 出界拒绝），只给文件。
- 响应头 `PUBLISH_HEADERS`：`Content-Security-Policy: sandbox allow-scripts allow-popups`（没有 allow-same-origin → 不透明 origin，读不到 app 的存储，连 `/ws` 时 Origin 是 `null` 被 originOk 拒）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。
- 有效期 1 天 / 7 天 / 永久；过期的请求即 404 并清掉，`list()` 和启动后每小时 `sweep()`。撤回删目录。局域网链接只在远程监听开着时给（`remote.status().running` + 第一个局域网地址）。
- 发布到常开机器：`publish.toPeer` 把同样的文件 base64 发给 peer 的 `publish.receive`（相对路径逐段检查），链接是 peer 自己的地址（`via === 'direct'` 时）；撤回会请对方也撤。导出成单个 HTML：`inlineHtml` 把本地 css / js / 图片内联，写到 `~/.claude-web/exports/<名字>.html`（不写进用户的文件夹），路径复制到剪贴板。
- 调试：`node server/ws-phase38.mjs [port] [token]`。
