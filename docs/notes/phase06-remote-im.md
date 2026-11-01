# 远程 / 手机 / IM（阶段 6，2026-09-03）

- **第二个监听器**：`server/src/remote/service.ts` 的 `RemoteService` 在 `remote.enabled` 时用同一个 HTTP handler + upgrade 在 `0.0.0.0:<remote.port>`（默认 3091）再起一个 `http.Server`；socket 打上 `cwRemote` 标记，`authOk()` 对远程连接**必须**有令牌（主令牌或设备令牌），本地回环没配主令牌才放行，而且请求的 Host 得是 `127.x` / `localhost` / `[::1]`（防 DNS rebinding，「安全审计」SEC-01）；WS 的 Origin 必须和 Host 同源（`wsOriginOk`，SEC-11）。停止时要 `closeAllConnections()`，否则 `server.close()` 会等 keep-alive / ws 连接永远不返回。
- **配对**：`remote.pairCode` 出 6 位码（10 分钟、5 次尝试、单次有效），QR 里是 `http://<局域网 IP>:<port>/pair#<code>`；`/pair` 页面 `POST /api/pair {code,name}` 换到 32 字节设备令牌（meta.json 只存 sha256），服务端回 `cw_token` cookie（HttpOnly、SameSite=Strict，SEC-06），页面只跳 `/`，不再存 localStorage；手机之后全靠 cookie。前端 `authToken()`（`web/src/ws/client.ts`）只给桌面壳的 URL `?token=` 用。联邦对端兑换时带 `kind: 'peer'`，设备记录标成电脑（SEC-07）；配对的设备不能生成配对码 / 管设备 / 看密钥（`remote/device-limits.ts`）。设备表可改名 / 吊销（令牌缓存同步清）。
- 局域网 IP 排序：`refreshPrimary()` 用 UDP `connect(8.8.8.8:53)` 拿默认路由的源地址放到最前（Windows 上 VMware / WSL 的虚拟网卡名字不可靠，光靠名字过滤会把 `192.168.208.1` 排第一）。
- **SSH 隧道**：`server/src/remote/tunnel.ts` 用系统 `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort> target`（`BatchMode=yes` 免密），轮询本地端口可连才算 `up`（最多 20s），失败把 stderr 最后一行给 UI；`startCommand` 会先 `ssh target "<cmd>"` 跑一次（15s 超时）。主机存 `meta.remoteHosts`，UI 在设置 → 手机与其它电脑 → 更多选项（`HostsSection`）；连上后新窗口打开 `http://127.0.0.1:<local>/?token=`。
- **手机布局**：`App` 用 `matchMedia('(max-width: 760px)')` 切 `.app.mobile`：侧栏变抽屉（`drawer-open` + 背板，点会话自动收起），右侧面板变成底部抽屉（同一个 Dock，见「界面改版 阶段 7」），对话上方只有会话头一行（☰ 展开侧栏 / 标题 / ···，项目和分支灰字隐藏）。PWA：`/manifest.webmanifest` 由服务端直出，`web/public/sw.js` 只做 network-first（安装用，不做离线），只在非 localhost、非桌面壳注册；图标 `web/public/icon-*.png` 用 `scripts/icons.cjs`（Electron 离屏渲染 svg）生成。
- **IM 网关**：`server/src/im/` — `ImAdapter` 接口（start / stop / send(chatId, text, {buttons}) + 'message' 事件），Telegram（Bot API 长轮询，inline keyboard → callback_query）、Discord（Gateway ws，intents 含 MESSAGE_CONTENT，按钮是 components，交互用 type 6 回执）、Slack（Socket Mode：`apps.connections.open` 拿 ws，events_api / interactive 信封要 ack；频道里只响应 @提及）、钉钉（Stream 模式 `gateway/connections/open` → ws，`ping` 要回，回复走消息里的 `sessionWebhook`，过期后用 robot API）、飞书（`@larksuiteoapi/node-sdk` 的 `WSClient` 长连接 + `EventDispatcher`，按钮是 interactive card → `card.action.trigger`）、企业微信（群机器人 webhook，只能推送）。微信没有开放接口，不做。
- `ImRouter`：每个 (网关, 聊天) 绑定一个会话（`meta.imBindings`）；未授权用户只回一次提示（1 小时），`/pair <配对码>` 加入 `allowUsers`；命令 `/new /sessions /use /status /stop /allow /deny /mode /model /verbose /help`，其它 `/xxx` 原样转给会话；`result` → 回最后一段 assistant 文本 + 用时 / 费用；权限请求 → 带 允许 / 拒绝 按钮（`perm:<requestId>:allow`），AskUserQuestion → 选项按钮（`ask:<id>:<i>`），ExitPlanMode → 开始执行 / 继续讨论。密钥字段用 `SecretService.protect` 存成 `enc:`，wire 上打码 `••••••`，回传打码值不覆盖。
- `server/src/im/router.test.ts` 用假 adapter / pool 覆盖路由逻辑；`server/ws-phase6.mjs` 端到端跑远程监听 + 配对 + 设备令牌 + 隧道失败路径 + IM 配置。
- vitest 只认 `src/**/*.test.ts`；server 的 `tsconfig` 现在排除测试与 `__mocks__`，不然 `npm run build` 会把测试编译进 `dist/` 然后 vitest 连 dist 里的副本一起跑（mock 路径不存在 → 超时）。
- （历史：按真实时间计时的 `relay-link` / `signal` / `p2p` 测试曾在 `server/vitest.config.ts` 里单独一组最后跑；随「手机在外面也能连」删了，这组也没了。再有按真实时间计时、整套并行会被抢 CPU 的测试，照这个办法单独分组，别放宽断言。）

## 添加 SSH 机器…（阶段 E，2026-10-25）

- 「选机器」菜单最后一项打开 `features/remote/AddSshDialog.tsx`：地址 / 用户 / 密钥（更多：SSH 端口、对方端口、对方令牌）→
  「测试连接」= `remote.hosts.test`（`remote/ssh-probe.ts`：一次 `ssh -o BatchMode=yes -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new … curl/wget 127.0.0.1:<port>/api/health`，target 过 `assertTarget`，不许以 `-` 开头）。
  结果分 ok（Claude Web 在跑 / 没跑）、auth、hostkey、unreachable、no-ssh、error，各有一句话。没跑时填「启动命令」，
  只提示怎么装，不在对方机器上执行任何东西。「连接并加入」= `remote.hosts.set` + `peers.add { hostId }`。
- `refusedFromPeer` 新拒的：`vcs.tokens.*`、`wsl.*`、`remote.hosts.test`。
- 真机：本机没有 sshd 服务（没装），没测到 ok 那条路；e2e 第 36 期测到连不上的那条。
## 派活：从手机 / IM 交代任务（阶段 F3，2026-10-25）

- 派活在 app 里：手机布局侧栏抽屉「派活」、命令面板「派活…」（`web/src/features/cloud/CloudDialogs.tsx` DispatchDialog）。一句任务 + 机器（本机 / peer）+ 项目，默认 `settings['dispatch.last']`（还在的才用）。
- 服务端 `server/src/dispatch/`：`dispatch.start` → 项目文件夹、**项目的权限模式**（项目页「派活用的权限模式」= `Workspace.permissionMode`；没设就不传，pool 用 `ui.defaultMode`）开新对话、meta `origin: 'dispatch'` + `dispatchFrom`（远程连接来的算 'phone'）、发出任务；`peer` → `federation.request(peer, dispatch.start)`，回 `peer_<id>~<sid>`。侧栏行标「从手机派来 / 从 IM 派来」。
- 通知：hub 在派来的对话 result（做完 / 出错）和权限请求时广播 `notice`（`notify: true`），手机和桌面都收到；授权卡照常推到所有窗口（含手机）。
- IM：`/dispatch [项目名:] <任务>`（中文别名 `isDispatchCommand`，冒号全角半角都行，项目名不分大小写，对不上就整句当任务），开新对话、绑定这个聊天、按项目权限模式，结果和授权按钮照旧回到聊天。
