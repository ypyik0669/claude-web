# 搜索在内置浏览器里 / 网页上的鼠标键盘 / 操控电脑（2026-10-10，用户要求）

用户原话：「不要 tavily，就尝试走现在各大开源 agents 的那种内置浏览器搜索工具和功能」「computer use 应该是有两种，一种是 in app browser computer use，一种是整个电脑 computer use」。**下面和「图标栏 / 分区 / 联网」一节冲突的地方，以这一节为准**（末尾有清单）。

- **搜索 = 在内置浏览器里打开结果页再读出来**（`server/src/web/search.ts` + `engines/pages.ts`，窗口这边 `web/src/features/browser/search-page.ts`）：
  - 服务端只定地址和读法：`resultPageUrl(engine, query, env)`（`CW_DDG_URL` / `CW_BING_URL` / `CW_GOOGLE_URL` / `CW_YAHOO_URL` / `CW_BAIDU_URL` 可以把某一家指到假服务，只给测试用），发 `browser.command {op: 'search', args: {engine, url}}` 给托管浏览器的桌面窗口；窗口回 `BrowserSearchPage {url, title, text, candidates[{title, href, alt?, snippet}], failed?}`；服务端 `readResultPage()` 把候选链接变成结果（`unwrapResultUrl`：DDG 的 `/l/?uddg=`、Bing 的 `/ck/a?…u=a1<base64url>`、Google 的 `/url?q=`、Yahoo 的 `/RU=…/RK=`、百度的 `mu` 属性）并认出验证页（地址落在 `sorry` / `captcha` / `anomaly`，或者几乎没列出东西而正文是「不是机器人」那套话）。**解析在服务端，页面里只做收集**（`page-agent.js` 的 `results()`：正文区里带标题的链接），所以换读法不用改注入脚本。
  - **顺序**：`auto` 在浏览器里是 DuckDuckGo → Bing → Yahoo → 百度（Google 只能点名用，它对自动化最敏感）；没有桌面窗口时还是服务端自己抓 Bing → DuckDuckGo（`RUN` 表里有 fetch 实现的只有这两家，别的回 `NEEDS_BROWSER`）。相关性检查（`relevance.ts`）现在对除 Brave 以外的每一家都做。冷却照旧（被拒 60 s、连不上 5 分钟，只在 auto 下跳过）。**Tavily 整个删了**（`RETIRED_KEY_SETTINGS`：老的 `web.search.tavilyKey` 启动时从 meta.json 删掉、wire 上照样打码）；Brave（要密钥，走接口）还在。
  - **实测**（2026-10-10，这台挂着代理的机器，`node scripts/browser-smoke.cjs --real`，MCP 进程 → server → 窗口 → 隐藏页面）：DuckDuckGo「node.js stream backpressure」1.3 s、「rust tokio select macro」1.1 s、「提示缓存 怎么用」3.3 s，全部对题。同一台机器上 v0.2.0 的服务端抓取：Bing 16 次里 2–4 次对题，DDG 头两次之后连续 202。差别在于这是一张真的浏览器页面：脚本跑了、cookie 在、UA 是 Chrome。
  - **隐藏的搜索页**（`search-page.ts`）：`<webview>`，`position:fixed; left:-20000px; visibility:hidden`，1280 × 900，和 Agent 的标签同一个 partition（所以用户在内置浏览器里做过一次的验证对它也算数）。最多 3 张同时读（`MAX_PAGES`，模型常在一轮里发几个搜索），空闲 3 分钟关掉（一张页面是一个进程）。时间上限是它对服务端的承诺：文档 15 s 内要出来（`SEARCH_LOAD_MS`），出来后最多再等 2 s 就 `stop()`（`SEARCH_SETTLE_MS`），列表不到 3 条再给 2.5 s（`SEARCH_LIST_MS`）；加载不了回 `failed`（`ERR_…`），不抛。搜索不走每个对话那条命令队列（`host.ts`：`op === 'search'` 直接跑）。
  - **窗口不应答 ≠ 这家搜索不行**：`BROWSER_TIMEOUT_MS`（40 s）内窗口没回话（窗口卡死、被挂起），这次搜索剩下的部分由服务端自己抓，`onBrowserSilent` 让之后 2 分钟（`BROWSER_QUIET_MS`）都不再问窗口，窗口重新 `browser.host` 时清掉；不记到那家搜索的冷却上。`WebService.command(…, limitMs)`：搜索的命令超时是 45 s，别的仍是 30 s。
  - **`executeJavaScript` 会等页面加载完**（踩过，Electron 的行为）：主框架还在加载时 `webContents.executeJavaScript`（`<webview>` 的也一样）一直不返回，所以「一张图片永远不回」的页面读不了——搜索页和 Agent 的标签都是先等、等不到就 `stop()` 再读（`guest.ts` 的 `askable()`：3 s）。v0.2.0 里 Agent 打开这种网页是 30 s 超时报错，现在读得到已经出来的内容并带一句「还在加载」。
  - **UA**：`desktop/src/user-agent.ts` 的 `cleanUserAgent()` 去掉 `claude-web/x` 和 `Electron/x` 两段，`app.userAgentFallback` 在 ready 前设上（搜索网站看到 Electron 就给验证页或简化页）。**Google 登录页反过来**：洗过的 UA 说自己是 Chrome，`navigator.userAgentData` 却只有 Chromium，Google 当成冒充，直接回「This browser or app may not be secure」；Electron 原样的 UA 反而放行——所以 `accounts.google.com` / `accounts.youtube.com` 上换回原样的，见「内嵌浏览器（阶段 10）」的 Google 登录那条。
  - 摘要（`snippetOf`）去掉了结果块开头的显示网址和机器格式的日期（DDG、Bing 都这么排版）。
- **运行内核自带的 WebSearch 在我们的引擎上拿掉了**（`server/src/web/engine-search.ts`，runner 的 `disallowedTools: ['WebSearch']`；真引擎上数过：41 → 40 个工具）：它默认走上游项目托管的 Tavily 代理（用户的搜索词经过别人的服务器），用户说了不要。用户自己选过后端的不动（进程 env 或 settings 文件 `env` 里的 `WEB_SEARCH_ADAPTER`、settings 的 `webSearchAdapter`：`userPickedSearchAdapter()`）。官方二进制不动：它的 WebSearch 是 Anthropic 那边执行的服务端工具。所以模型手里只有 `mcp__web__web_search` 一个搜索工具（它仍是唯一不问权限的工具）。
- **`browser_computer`（网页上的鼠标键盘，第 11 个 `web` 工具）**：动作 `screenshot / left_click / right_click / middle_click / double_click / triple_click / mouse_move / left_click_drag / scroll / type / key / wait`，坐标是**最近一张截图**里的像素（`ops.ts` 的 `toView()` 换算成页面的 CSS 像素；截图的宽高由桌面壳随图一起回，`desktop/src/jpeg-size.ts`），每个动作回一张新截图。`guest.ts` 用 `<webview>.sendInputEvent` 发鼠标 / 滚轮 / 按键，打字走 `insertText`（中文不经过键盘事件）。只作用在这个对话的 Agent 标签上，要桌面窗口（没有就 `NEEDS_DESKTOP`），和其它网页操作一样问权限。按键名（`parseKey`）认 `Page_Down` / `BackSpace` / `Return` / `KP_Enter` 这些写法；**没人认识的多字符名字不发任何键**（以前会发它的第一个字母）。
- **操控电脑 = 我们自己的 MCP 服务器 `computer`**（`server/src/computer/`，Windows；工具名照 Claude Code 自带的 computer-use：`request_access`、`screenshot`、`left_click`…共 29 个）：
  - **为什么不是「直接调 Claude Code 自带的」**（都实测过）：① 官方 Claude Code 的 computer use 只在 macOS 的终端界面里；② 我们的引擎带 `--computer-use-mcp` 起来的那个服务器，工具是空壳（回「not wired to a session」），它的 Windows 后端用的是 Bun 专有接口加 Python，node 构建里跑不了；③ **`computer-use` 这个名字被两个引擎保留**：我们的引擎直接报 `Invalid MCP configuration: "computer-use" is a reserved MCP name`，官方二进制静默丢掉。所以服务器叫 `computer`（工具是 `mcp__computer__*`；握手里的名字是 `claude-web-computer`），两个引擎都连得上。
  - **结构**：`mcp.ts`（stdio 入口，裸 JSON-RPC）→ `service.ts`（一次调用 → 闸 → helper → 给模型的话；调用串行）→ `helper-win.ts`（每个 MCP 进程一个常驻 `powershell.exe`，`Add-Type` 编译一小段 C#：SendInput、截屏、窗口 / 进程查询；脚本内容寻址写到 `<dataDir>/runtime/computer/helper-<sha8>.ps1`，纯 ASCII、没有反斜杠和反引号；进程先设成 per-monitor DPI aware，截图和指针是同一套真实像素）。纯函数：`grants.ts`（授权表和闸）、`apps.ts`（应用名怎么对上窗口）、`coords.ts`（截图缩到长边 ≤ 1568，坐标来回换算）、`keys.ts`（按键串 → 虚拟键）、`tools.ts`（工具表）。只看主显示器。
  - **闸**（`grants.ts` 的 `gate()`，`TOOL_NEEDS`）：第一次授权之前什么都不截、什么都不发；发输入的动作（点、拖、滚、打字、按键、写剪贴板）要求**最前面的窗口**属于授权的应用，按位置的还要求**那个位置下面的窗口**也是；helper 在真正发出去的那一刻再核对一遍「最前面的还是刚才看的那个」，不是就什么都不发（`changed`）。截图不过滤别的窗口（`screenshotFiltering: 'none'`，授权卡上写明了「能看到整个屏幕」）。
  - **Claude Web 自己永远不是目标**（Agent 不能去点它自己的授权按钮）：桌面版按 exe 认（`CW_COMPUTER_SELF_EXE`，launcher 在 Electron 下给），网页版只能按窗口标题认（标题里有「Claude Web」）——所以 **`web/index.html` 的 `<title>` 必须含它、页面里不许改 `document.title`**，`grants.test.ts` 有一条扫源码的测试钉着。
  - **授权卡上没写的就不做**：`request_access` 可以带 `clipboardRead` / `clipboardWrite` / `systemKeyCombos`，卡片只在带了的时候写「还会：…」；服务端真的强制——没批过就 `read_clipboard` / `write_clipboard` 报错，带 Windows 键的组合、alt+Tab、alt+Esc、ctrl+Esc 不发（`keys.ts` 的 `isSystemCombo()`；alt+F4、ctrl+Tab 这类应用自己的快捷键不算）。
  - **谁来批准：Claude Web 自己，不是对话的权限模式**。「完全放开」「自动判断」下工具调用根本不会问用户，而这是整台电脑。所以 `mcp__computer__*` 全部预先放行（runner 的 `allowedTools`，`computerAllowedTools()`），`request_access` 到了 MCP 进程里再回头问我们：`askHost()` → `POST /api/computer/ask`（`computer/http.ts`：只认回环、远程监听器 404、Bearer 是每次启动随机的密钥，以文件交给进程：`<dataDir>/runtime/computer-mcp/<server pid>.token`）→ `ComputerAccess.ask()`（`computer/access.ts`）发一条 `permission.request`（`toolName: 'mcp__computer__request_access'`，input 是清洗过的 `{apps, reason, …}`），任何窗口（配对的手机也行；IM 机器人收不到这张卡）用现成的 `permission.respond` 回答；4 分钟没人答 = 没批；问的进程走了就撤卡；对话关了就以「对话已关闭」作答；对话不在本机池里的直接拒绝、不出卡。hub 的快照（`pendingOf()`）把这些和 runner 自己的待答请求合在一起。
  - **前端**：`web/src/features/computer/computer-tools.ts`（纯）：步骤文字（「点击屏幕: (120, 89)」「用键盘输入: …」「看屏幕」）、授权卡的标题和内容。授权卡是停靠卡的第四种（`DockKind = 'access'`，`PermissionCards.tsx` 的 `AccessRequest`）：它说要做的事、应用列表、还会做什么、允许意味着什么（`ACCESS_NOTE`），按钮「不允许」/「允许操控」。**键盘永远批不了它**（`dockDecide()`：Enter 和 Ctrl+Enter 都是 `ignore`，`why: 'access'`，卡片和状态行说「按键不会允许」）；有字 + Enter 仍是带理由的拒绝。没有「总是允许」。别处也批不了：总览（Mission Control）里它只有一行字（要操控哪些应用、「打开对话再决定」），没有那里别的请求都有的「允许」；IM 机器人收不到它。
  - **开关**：`+` 里的「操控电脑」只在服务端那台机器能做时才是开关（`engine.info` 的 `computerUse` = `computerSupported()`，现在只有 win32；`capabilities.ts` 的 `capabilitiesFor(env)` / `usable(f, env)`），否则那一行写「暂不可用 · 目前只支持 Windows」。只给 Claude 对话（runner 在 `features.computerUse` 时才把 `computer` 放进 `mcpServers`）。**每个对话重新开**：`ONE_TIME_KEYS = ['computerUse']`，从欢迎页带着它发出一个对话后，`afterStart()` 把它从默认值里去掉。服务端那个旧的默认能力设置（meta.json `defaultFeatures`：不带 features 打开的对话、编排的节点会用它）经 `defaultFeaturesOf()` 去掉 `computerUse`——默认值永远开不了它。
  - 远端（`peer_`）对话：`computer` 跑在那台机器上，卡片由那台机器的 server 发出；按设计它和别的权限请求一样经联邦转发过来，**没有测过**。
- **调试 / 验证**：
  - `node server/ws-phase24.mjs`（e2e 默认列表里，自己起 server，约 40 s）：真引擎（只启动、不发消息）+ 真 `computer` MCP 进程：`engine.info`、密钥文件、带这个能力的 Claude 对话确实被交给了 `computer`（引擎报 connected、29 个工具）而不带的没有、`/api/computer/ask` 的 401 / 400 / 未打开的对话、卡片到每个窗口并出现在快照里、允许 / 带话拒绝 / 提问方走掉 / 对话关闭、远程监听器 404；Windows 上再走一遍真的 `request_access` → 卡片 → 拒绝什么都不给 → Claude Web 自己不出卡直接拒 → 允许后才授权 → 截图回来 → 没授权的应用在前面时输入被拒（用「滚轮转 0 格」来验，闸坏了也不会动任何东西）。
  - `node server/ws-phase23.mjs`：搜索那部分改成了「窗口答 `search` 命令」，加了 `browser_computer`。
  - `node scripts/browser-smoke.cjs [--real]`：隐藏搜索页（本机假的 DDG / Bing 结果页、验证页 → 下一家、永远加载不完的结果页 2.4 s 读出来、同时五个搜索最多用三张页面）、`browser_computer` 的每个动作在真 `<webview>` 里（点击、双击、带修饰键、右键、中文打字、Ctrl+A、拖动、滚轮两个方向）、MCP 整条链路。`--real` 用真的搜索网站（保留代理环境变量）。
  - ui-smoke：`+` 里操控电脑那一行按 `engine.computerUse` 分两种断言；授权卡用注入的请求（内容、按钮、Enter / Ctrl+Enter 不应答且说明、点击才允许、有字 = 拒绝）。smoke-packaged（Windows）：`computer` 的入口能从 `app.asar` 里用 Electron-as-node 起来、列出 29 个工具。另外在一个 `electron-builder --win dir` 打出来的未安装包上手工驱动过一次（scratchpad 的 `cu/packed-computer.mjs`）：从包里起的 `computer` 进程能把 helper 起起来（脚本写到数据目录）、截图回来、没授权的应用在前面时输入被拒、没申请就读不了剪贴板。**第一次 `request_access` 要等 helper 起来**（PowerShell 现编那段 C#），打包版里实测约 10 秒，之后的调用是即时的；`--win dir` 的包没有 `app-update.yml`，所以 smoke-packaged 的「自己下载新版本」那条在这种包上必然失败（和这里的改动无关）。
  - 引擎上数工具 / 试服务器名字的小脚本在 scratchpad 的 `cu/`（`engine-tools.mjs`、`engine-cu.mjs <名字>`），不入库。
  - **没验的**：真模型自己决定去搜、去点、去操控电脑（这台机器的引擎没有登录账号，验到的是整条链路由 MCP 协议直接驱动）；macOS / Linux 上只验了「不提供」；操控电脑的 `write_clipboard`、启动应用（`open_application` 从开始菜单找）、UWP 应用、多显示器只有单测；远端对话。
- **踩过的坑**：
  - bash 的 heredoc（带引号的也一样）喂 Python 时吃反斜杠这件事这一轮又中了三次（正则里的 `\\`、模板字符串里的 `\.`、测试标题里的 `\'`）。改文件的脚本一律用 Write 写成文件再跑，跑完 grep 一眼。
  - 设置页文案里的「搜索引擎」会被文案闸拦下（「引擎」是实现词）：写「搜索网站」「哪一家」。
  - 相关性检查对每一家都做之后，测试里的假结果页标题必须带查询词，不然会被当成「不对题」换下一家。
  - 窗口答搜索的超时（40 s）比普通命令的（30 s）长：命令计时器先响的话，「窗口沉默」就认不出来了。
- **「图标栏 / 分区 / 联网」一节里不再成立的说法**：
  - 「搜索默认 `auto` = Bing 的结果页 → 不行换 DuckDuckGo 的 HTML 页」「Tavily / Brave 要密钥（`web.search.tavilyKey`）」「不用密钥的搜索在真实网络上靠不住……只是个兜底」「工具描述、`weak` 的提示叫模型优先用自己的搜索工具」→ 见上：有桌面窗口时在内置浏览器里搜，没有 Tavily，模型没有别的搜索工具。服务端抓取那条路（没有窗口时）靠不住的结论仍然成立。
  - 「引擎自带的 WebSearch 不动」→ 在我们的引擎上拿掉了（用户自己选过后端的除外）。
  - 「`web` 的工具：`web_search` 和 `browser_open / read / find / click / type / press_key / scroll / back / screenshot`」→ 多了 `browser_computer`，共 11 个。
  - 「操控电脑现在用不了……`featureArgs()` 不再传它……`capabilities.ts` 的那一行带 `unavailable`」→ Windows 上能用了（见上）；`--computer-use-mcp` 仍然不传，`unavailable` 只在服务端不是 Windows 时出现。
  - 「设置 → 联网：搜索引擎和密钥」→ 「用什么搜索」下拉（自动 / DuckDuckGo / Bing / Google / Yahoo / 百度 / Brave Search），只有 Brave 要密钥。

## 浏览器的调试工具：控制台 / 网络 / 页面结构 / 等待 / 标签 / 视口（2026-10-24，阶段 B 任务 6）

- **工具**（`server/src/web/mcp.ts`，`web` 一共 17 个浏览器 / 搜索工具）：`browser_console {errors_only?}`、`browser_network {failed_only?}`、`browser_snapshot {}`、`browser_wait {text?, ref?, timeoutMs ≤ 20000}`、`browser_tabs {action: list|switch|new|close, id?, url?}`、`browser_viewport {preset: auto|phone|tablet|desktop}`。都要桌面版（没有窗口时 `NEEDS_DESKTOP`）；op 名 `console / network / snapshot / wait / tabs / viewport`（`protocol.ts` `BrowserOp`），答案多了 `console[] / network[] / tabs[]`。权限（只读的不问）是任务 7 的事，这里只给了诚实的 `readOnlyHint`。
- **一页一个调试器，大家共用**（`desktop/src/guest-debug.ts`）：`acquire(guest, 'viewport' | 'capture' | 'snapshot')` / `release`，最后一个放手才 `detach`（而且只在是我们 attach 的时候）。视口回到自适应不会把控制台记录弄没，记录也不会把视口留住。`message` / `detach` 监听每次 attach 只装一次；页面销毁时 `forgetGuest` → `forgetDebug`。
- **记录**：第一次读控制台 / 网络时才开（`Runtime.enable` 会把之前的 console 消息补发过来，`Log.enable` 补浏览器自己的行，比如 404 的 `Failed to load resource`）；之前的网络请求补不回来，开的时候用页面的 `performance` 资源计时补一份（方法不确定的写 `?`，状态来自 `responseStatus`），第一次读网络时附一句说明。各留最后 200 条，记到页面关掉。Electron 自己的安全警告（`node:electron/…`，没打包时）不记。
- **页面结构**：`Accessibility.getFullAXTree` 压成每行一个元素（地标、标题、带名字的图 / 表单 / 区域、所有能操作的），其余（generic、静态文字）只把孩子往上交；一个父元素下的 option 最多 25 个再加一行「还有 N 个」；最多 400 行，web 侧再截到 12 000 字。能操作的那几行用 `DOM.resolveNode` + 一次 `Runtime.callFunctionOn` 问 page-agent 的 `refFor(el)` 拿编号——和 `find / click` 同一套编号，看到就能点。读不到树的时候退回 page-agent 自己的元素表并说明原因。page-agent 升到 `v: 4`（多了 `has` / `refFor`）。
- **等待**：`peek` 不走 `askable()`（那个会在页面加载超过 3 秒时 `stop()`，而等待多半就是在等加载），一次只挂一个探测，超时算没等到。ref 不在页面上了立刻报错。
- **标签**：`state.ts` 的 `agentTab` 先看这个对话 switch / new 过去的那个（`setAgentCurrent`，不存盘），再退回第一个；只列 / 只切 / 只关 `agent === sessionId` 的标签；`new` 只收 http(s)。别的工具在没有页面的新标签上直接说「先 browser_open」。
- **视口**：和 ⋯ → 视口菜单同一条路——`patchTab({viewport})` + `applyViewport`（从 `BrowserPanel.tsx` 挪到 `guest.ts`，等壳子应用完才返回，壳子换 UA 时会自己重新载入），然后照常 glance。
- **踩过的坑 / 和预想不一样的**：
  - Electron 44 上开着 DevTools 时 `debugger.attach` **不会失败**（第二个客户端），控制台、结构、视口都照常；`NO_DEBUGGER` 那句错误只在 attach 真抛错时出现。
  - 没有 `<meta name=viewport>` 的页面在手机视口下 `innerWidth` 是 980（移动端的默认布局宽度），不是 390——验视口要么加 meta，要么看 `screen.width`。
  - 换成手机 UA 会重新载入页面：之前点出来的状态（标题改了之类）会没。
  - 这台机器的 bash 工具里 heredoc 带 `\'` 或 `\\` 时整条命令会解析失败（不只是吃反斜杠）：脚本一律先用 Write 写成文件再跑。
- **验证**：单测 `desktop/src/guest-debug.test.ts`（共用 / DevTools 抛错 / 记录 / 补资源计时 / 结构压缩 / 编号）、`web/src/features/browser/ops.test.ts`（截断、过滤、等待超时、标签只列自己的）、`server/src/web/{mcp,service}.test.ts`。真机：临时 HOME / `CLAUDE_WEB_DIR` / `--user-data-dir` 起桌面版，CDP 里调 `window.__cwBrowser.carryOut`，本机假页面（加载时 `console.error('boom')`、一张 404 的图、点了才 fetch 一个 500 并晚 0.8 s 出字、40 个 option 的 select），48 项全过；脚本没入库（scratchpad `t6check/check.cjs`）。

## Windows UI Automation（2026-10-28，P6）

- `helper-win.ts` 里嵌的 C# 多了 `uia.snapshot` / `uia.act`（`System.Windows.Automation`，编译时带 `UIAutomationClient` / `UIAutomationTypes` / `WindowsBase`）：快照前台窗口（可带 title / process 过滤）的角色、名字、值、automationId、className、bounds、enabled、offscreen、focused、patterns、children；最多 800 节点 / 深 14 / 每节点 100 个子节点。动作 `invoke`、`value`（ValuePattern.SetValue）、`toggle`、`select`（含按 item 名字选）、`expand`、`collapse`，以及鼠标点击兜底。每个动作前都过现有的 `Check` / `Settle` 最后一刻守卫。
- `helper-automation.ts`（新的 `HelperAutomation`）把 helper JSON 映射成 `UiaSnapshot`，把 `AutomationAction` 翻成 `uia.act` / 现有输入操作；ref 必须带 `AutomationTarget`（role / name / automationId / bounds + owning window app），ref 过期就拒绝，不猜。
- `service.ts`：ref 带控件身份和所属窗口的 exe / description / product；结构化动作和低层输入走同一条 probe → gate → act 路径，并额外检查 **ref 所属窗口**也授权了（否则一个已授权的前台窗口可以拿来对后面未授权的窗口做 UIA 动作——这个洞补上了）。`computer_task` 的步骤同样过守卫；`win+…` / `alt+Tab` 等系统组合仍要 `systemKeyCombos`；`collapse` 入了动作表。`mcp.ts` 只在 Windows helper 存在时构造 `HelperAutomation`，其它平台保持 fail-closed。
- 测试：`server/src/computer` 14 文件 / 210 通过 / 1 跳过。真机用一个 scratch WinForms PowerShell 窗口验过 snapshot、`ValuePattern.SetValue`、Invoke、点击兜底、Toggle、Expand、按名字 Select、Collapse，以及完整 `request_access → computer_observe → computer_find → computer_act value / invoke`。**没验的**：Office / 浏览器 / 记事本之外的第三方应用、UWP / ApplicationFrameHost、模态对话框、混合 DPI 多显示器、非英文控件名。

## 允许的网站 / hover·drag·select·eval / Agent 的光标 / 接管（2026-10-24，阶段 B 任务 7）

- **新工具**（`server/src/web/mcp.ts`，`web` 现在 21 个浏览器 / 搜索工具）：`browser_hover {ref}`（真鼠标移过去，`mouseenter` / `:hover` 菜单会出来）、`browser_drag {from, to}`（按下 → 按着走 10 步 → 松开；HTML5 原生拖放没单独验过）、`browser_select {ref, value}`（`<select>`：值、显示的字完全一样、再包含；触发 input + change）、`browser_eval {script}`（≤ 20 000 字；有 `return` 当函数体，否则先当表达式、解析不了再当函数体；promise 等 10 s；结果 JSON，函数 / DOM 节点 / 循环写成字，≤ 8 KB，当页面数据框起来）。page-agent 升到 `v: 5`（`point` / `select`）。
- **闸在服务端**（`server/src/web/site-gate.ts` + `service.ts` 的 `gated()`）：会改页面的 op（click / type / key / scroll / computer〔截图和 wait 除外〕/ hover / drag / select / eval）先判网站：这个对话的标签现在在哪——上一次回答里的 `page.url`，不知道就先发一个 `read {probe: true}` 问。`file:` 页面一律拒（完全放开也拒）；没有主机的页（about:blank）只有脚本要问；不在 `web.browser.allowedSites` 里 → 在对话里挂一张卡（`permission.request`，`toolName: 'browser.site'`，input `{host, op, tool}`，脚本另带 `eval / script（前 400 字）/ scriptLength`）。总是允许 = `allow` + `updatedInput.allow = 'always'`（脚本的不认）→ 主机名追加进列表。权限模式「完全放开」不问网站，**脚本照样每次问**。卡的通道和操控电脑一样（`SiteAsk`：`permission` / `permissionResolved` 事件、`pendingFor`、`respond`、对话关了 `drop`、4 分钟没人答算拒绝；不是这台机器上打开的对话 → 直接拒）。
- **判过的网站随 op 一起发**（`args.site`）：窗口那边标签已经去了别的网站就回 `cw-site-changed:<现在的地址>`，服务端按新网站再判一次（只重来一次）——用户在两次调用之间自己点走了也不会越权。
- **列表规则**（`siteAllowed`）：`example.com` 只这一个主机；`*.example.com` 含它和所有子域；端口不算；IP 只等于它自己、通配符永远不配 IP；大小写、末尾的点不算；整条网址也认它的主机。
- **卡**：`PermissionCards.tsx` 的 `SiteRequest`（`[data-id=site-card][data-host][data-op]`，`data-act=allow|always|deny`），脚本用代码块显示；空输入框按 Enter = 允许一次网站，**脚本只能点**。
- **Agent 的光标**（`cursor.ts` 总线 + `AgentCursor.tsx`）：ops 在 hover / drag / select / click / type / computer 时报坐标（页面自己的像素 + 页面大小），光标按 webview 元素的框换算，所以手机视口缩小居中时也对得上；按下有涟漪；停 2.5 s 后淡出；只是画，不挡输入，截图里没有。钩子 `[data-id=agent-cursor][data-shown]`、`[data-id=agent-ripple]`。
- **接管 / 交还**：Agent 条上的 `[data-id=takeover]` / `[data-id=giveback]`（`[data-taken=true]`），`state.ts` 的 `setTakenOver(sessionId, on)` 把这个对话记进 `takenOver`（修正一轮起按对话记，见下）。接管期间 host.ts 对这个对话除了读以外的 op（以及服务端的 probe）直接回「用户接管了浏览器……」，读页面照常。只在窗口内存里（窗口关了就没了），不进 meta.json。
- **修正一轮（2026-10-25）改了的行为**：
  - **网站检查以窗口看到的真地址为准**：服务端判过的会改页面的 op **一定**带 `site`（没主机的页也带 `''`）；窗口拿 webview 自己的 `getURL()` 比（不是页面 agent 报的——页面能伪造 `__cwAgent`），不带 `site` 的直接拒（「这个操作没有经过网站检查」），每个回答里的 `page.url / title` 也换成 webview 的。`blob:` 页按它的来源算主机。`browser_tabs`（new / switch / close）之后服务端忘掉这个对话的 `lastUrl`，下次改页面先 probe；`browser_tabs new` 的网址和 `browser_open` 一样过 `urlRefusal`（元数据地址、链路本地、带用户名密码的都拒）。
  - **接管属于对话**：`state.ts` 的 `takenOver: string[]`（会话 id），不再记在标签上——接管后新开的标签也在接管下；`isTakenOver(sid)`。接管时 host.ts 中止这个对话正在跑的 op（`AbortSignal`，每一步前查，拖到一半也停）并让它的标签停止加载。接管期间只放行读（read / find / snapshot / screenshot / console / network / wait、`browser_tabs list`）；open / back / viewport / tabs new·switch·close 都拒。
  - **卡住的 op**：一个 op 在窗口里最多 28 s（`OP_LIMIT_MS`），`browser_eval` 15 s（`EVAL_LIMIT_MS`）；脚本超时后壳把这个页面的渲染进程结束再重新加载（`desktop:browser:recover`），队列接着走。`browser_eval` 先解析（不运行）决定当表达式还是函数体，只跑一次。
  - **总览栏**的网站请求不给「允许」按钮（看不到网站和脚本），写「想在网站 … 上操作网页（打开对话再决定）」。`browser_network` 的地址里 token / code / sig 之类参数的值换成 `…`。控制台 / 网络记录在主框架换页（`did-navigate`）时清空；两个同时的第一次查看共用一次启动。
  - 真机：`scripts/browser-smoke.cjs` 的 `fixwave` 段（伪造地址、自己跳到别的主机、换标签后再点、接管打断拖动），`scripts/ui-smoke.cjs` 的 `browser-b` 段末尾（同目录资源、被拒的本地页、`while (1) {}` 超时后下一个 op 照常）。
- **验证**：`site-gate.test.ts`、`service.test.ts`（probe、一次 / 总是、通配、脚本每次问、完全放开、拒绝、file:、网站变了、接管）、`ops.test.ts`（含在 Node 里真跑 `evalSource`）、`server.test.ts`（没打开的对话在新网站上点击被拒、窗口一个点击都没收到）；`scripts/browser-smoke.cjs` 的 `t7` 段（真 Electron）；e2e 第 23 期用 mock ACP 的真对话走卡片 / 总是允许写列表 / 脚本每次问。

## 自动检查改动（2026-10-24，阶段 B 任务 8）

- `web/src/features/browser/auto-verify.ts`：一轮结束（`onTurnEnd`，在自动打开之后）——设置 `web.browser.autoVerify` 不是 false（没设 = 开）、这一轮没出错、不是别的机器的对话、桌面版（`desktop.guestDebug`）、这一轮成功写过前端文件（`.html/.htm/.css/.scss/.less/.js/.mjs/.jsx/.ts/.tsx/.vue/.svelte`）、开着预览标签（localhost / 127.x / [::1] / `.claude/launch.json` 在跑的服务器的地址；这个对话自己的 Agent 标签优先，再前台的，再最新的）→ `checkPage`：先看一眼控制台（让记录开起来）、记下时间、`reload`（≤ 15 s）、再等 0.8 s、取这之后的 error（≤ 20 条），有才截图。
- `Runtime.enable` 会把之前几次加载的 console 补发过来，带的是原来的时间戳——所以按「重新加载之后」的时间筛，不按条数。
- 有报错 → 这一轮的改动文件卡下面一条 `VerifyChip`（`[data-id=verify-chip][data-state=checking|errors][data-count]`，「预览有 N 个报错」点开看列表，`data-act=verify-fix`「让 Claude 修」、`data-act=verify-dismiss`）；没报错什么都不留。「让 Claude 修」把截图 + 报错文字作为一个附件放进输入框（任务 5 的 inbox），输入框空着才填一句话——**从不自动发**。状态在窗口内存里（`useVerify`），不进 meta.json。
- 真机：`window.__cwBrowser.checkPage(tabId)` 给脚本用。

## 「完全放开」什么都不问（2026-10-26，用户决定，spec 14.4）

- 上面两处的旧规则改了：「操控电脑不看权限模式」「脚本在完全放开下也问」都不再成立。对话处于 `bypassPermissions` 时，服务端自己弹的卡一张都不弹、动作直接执行：`needsAsk()` 第一行就回 `'no'`（网站和 `browser_eval` 都是）；`ComputerAccess.ask()` 在「对话不在本机就拒」之后、出卡之前看 `AccessDeps.mode(sid)`，是 `bypassPermissions` 就直接 `{granted:true}`，不发事件、不进待答。
- 其它五种模式不变：脚本每次问，网站按允许列表问，操控电脑每次问。没传 `mode` 的 `ComputerAccess`（测试、旧调用）照旧每次问。
- 模式来源和浏览器闸同一个：`index.ts` 的 `modeOf = (sid) => pool.get(sid)?.info.permissionMode`，两边共用。这是用户明确的取舍：「完全放开」的对话可以直接控制任意应用。
- 「完全放开」下不声不响批下的应用，对话离开「完全放开」后**仍然有效**：沿用「之前批过的留着」的设计，`computer/service.ts` 的 `grants` 不随模式清空，跟这个对话的 `computer` MCP 进程同生同灭。
- 界面上的说法跟着改了：模式说明（`terms.ts`）、+ 菜单的操控电脑（`capabilities.ts`）、允许的网站页、脚本卡都写了「完全放开时不问」；给模型看的 `computer/tools.ts` 说明也加了 full access 的例外。
- 以后新加的服务端询问也照这条：先看模式。测试：`site-gate.test.ts`、`service.test.ts`、`access.test.ts` 里五种模式照旧 / 完全放开零张卡。
- 端到端（`server/ws-phase40.mjs`，2026-10-26 Task 4）：两个 Claude 引擎上完全放开时 ego_browser 和 `browser_eval` 都零张卡、
  照跑、结果回到模型；默认模式整轮各恰好一张服务端的卡；mock ACP / mock Codex 的对话里 ego_browser 默认一张、完全放开零张。
- **`browser_eval` 只问一次**（修正轮）：服务端每次都问脚本，所以 Claude 把 `mcp__web__browser_eval` 放进了 `webAllowedTools`，
  ACP / Codex 对它自己的提示直接答（`launcher.ts` 的 `SERVER_GATED` 表，和 ego_browser 一起）。以前默认模式会弹两张。
  click / type 等**没动**：它们只在网站不在允许列表时由服务端问。
- Codex 对 MCP 工具调用的审批（`mcpServer/elicitation/request`，`_meta.codex_approval_kind = 'mcp_tool_call'`）以前被回 -32601
  = 没批；现在普通的卡问用户，我们的 ego_browser / browser_eval 直接 accept（服务端自己问）。细节在「ego lite 作为 Agent 的第一浏览器」。
- **完全放开时操作过的网站自动进「允许的网站」**（2026-10-26，用户决定，spec 14.4 最后一条）：`bypassPermissions` 下内置浏览器
  点击 / 输入 / 填表等改页面的 op（`MUTATING_OPS`，截图 / wait 除外）成功后、以及 `browser_open`（落地页的地址）/ `browser_tabs new`
  （带网址）之后，那个主机名追加进 `web.browser.allowedSites`，同时记进旁边的 `web.browser.allowedSitesAuto`（列表本身仍是
  `string[]`，旧数据照读；记号只对也在列表里的主机算数）。判断在 `site-gate.ts` 的 `autoAllowHost(op, url, mode)`：只认
  http(s) 页（about:blank / file: / data: / chrome: / blob: 都不加），localhost 和 IP 照加（和总是允许一致）；已被列表覆盖
  （含 `*.`）的不重复加。**脚本（`browser_eval`）不加**，ego_browser 不碰这张表。写走 `service.ts` 的 `allowSite(site, auto)`
  （和总是允许同一个函数，写入串行、每次读当时的列表），**不 await**：写失败只 `console.warn`，动作照常。总是允许一个带记号的站会
  去掉记号；允许的网站页删一项两边都删。页（`AllowedSites.tsx`）打开时和删之前都先 `settings.get` 拿服务端当下的两项——web 的
  store 只在启动时读设置，服务端自己加的站否则看不到，删的时候还会把它覆盖掉。测试：`site-gate.test.ts`、`service.test.ts`、
  `service-ego.test.ts`、`allowed-sites.test.tsx`；e2e `ws-phase40.mjs` 最后一段（完全放开点新站零卡且进列表带记号，默认模式再点
  零卡，另一个新站仍然问）。
  - 修正轮（2026-10-26）：`gated()` 只读一次模式，问不问和自动加都按这一个值（卡挂着时切到完全放开、答允许一次 → 不加）。
    自动加先同步查 `siteAllowed`，已在列表的不写。**两个键在内存里一步改完**（`setSites`：读两项、两次 `setSetting` 中间不 await
    ——`meta.setSetting` 同步赋值、之后整份按顺序存盘），所以不需要写队列，两个并发的改动不会拿到旧的列表或旧的记号；总是允许和
    自动加一样**不等存盘**（卡死的保存不会让点击等到 MCP 超时，失败只 `console.warn`）。删除改成服务端请求 `web.allowedSites.remove {host}`（两个键一起删，
    回 `{sites, auto}`；不带 sessionId，属于 `rewrite.ts` 说的「联网是各机器自己的」，不用进联邦路由表），页面不再整表写回。
    **跳转后落到的站才是加进去的那个**：`browser_open` / `browser_tabs new` 用回答里 `page.url`（落地页），没有时才用请求的地址。

## 「允许的网站」是内置浏览器唯一的说了算（2026-10-27，用户决定，spec 14.4）

- 以前默认模式下 `browser_open` 只弹 Claude 自己的卡（打开不过网站闸），已允许的网站上 `browser_scroll` 也弹 Claude 自己的
  「Claude 想滚动网页」——和允许的网站页上的说法对不上。现在：**完全放开以外的五种模式，不在列表里的网站只问一次（服务端的网站卡），
  在列表里的什么都不问**，Claude / Codex / ACP 都不再弹它们自己的卡。脚本（`browser_eval`）照旧每次一张服务端的卡；完全放开照旧零卡
  （并把网站自动加进列表）；ego_browser 不变。
- **打开也过闸**（`site-gate.ts` 的 `OPENING_OP = 'open'`，`needsAsk('open', 地址的主机)`）：`service.ts` 的 `browse()` 在
  `browser_open` 和带网址的 `browser_tabs new` 上先 `urlRefusal`、再 `openGate()`——不在列表里 → 卡 `{host, op:'open',
  tool:'browser_open'|'browser_tabs'}`，**答之前页面不加载**（拒绝 = 窗口一个命令都收不到）。允许一次 = 这一次打开；总是允许 =
  `allowSite`（不等存盘）。没有桌面窗口、由服务端去抓页面时也一样先问（不问就抓等于绕过列表）。`open` 不进 `MUTATING_OPS`：
  那张表是窗口拿「标签现在的真地址」比的；打开比的是要去的地址。卡标题「Claude 想打开 example.com（这个网站还没允许过）」
  （`permission-dock.ts`），卡上「要做的事：打开这个网站」。
- **不问的**：读当前页（read / find / snapshot / screenshot / console / network / wait / viewport / `browser_tabs` list·switch·close、
  不带网址的 new）——那一页的网站在打开时已经允许过或答过。`browser_back` 也不问：回到的是这个标签自己加载过的页。
  **点链接 / 跳转 / 页面脚本自己换页**落到别的网站时不在落地前拦（webview 的 `will-navigate` 是同步的，要拦就得先挡下再异步问
  服务端，重定向和 `location=` 还拦不全）——取舍：这是在已允许（或答过）的网站上的动作的后果；落地后的**第一个改页面的动作**按真地址
  （`args.site` + 窗口的 `cw-site-changed`）再判，新网站照样问。所以能「读到」没允许过的网站的路只有跟着链接走，不能在上面动手。
- **预览服务器**：`index.ts` 改走 `web.openPreview(sid, url)`——`.claude/launch.json` 起的本机开发服务器（localhost / *.localhost /
  127.x / ::1）不问；`launch.json` 的 `url` 可以写任何地址、模型也能改这个文件，所以不是本机的照常问。
- **全部浏览器工具预先允许**（`launcher.ts` 的 `SERVER_GATED` 表，现在是 ego_browser + 20 个 `browser_*`）：Claude 的
  `webAllowedTools()` 带上它们（我们的引擎走 `ExecuteExtraTool` 时 runner 按里面的工具名放行，见「ego lite」笔记）；ACP 的
  `isServerGatedAcpCall` / Codex 的 `isServerGatedCodexElicitation` 按表精确匹配：名字锚定（`mcp__web__x` / `x` /
  `x (web MCP Server)`）、ACP 的 kind 只认缺省 / null / `other`（Gemini 系把所有 MCP 工具都报成 other；`fetch` / `read` 是 agent
  **自己的**抓网页 / 读文件工具的 kind，标题是它自己拼的，认了就可能放过同名的内置工具——宁可多一张卡）、参数是普通对象且键 ⊆
  该工具 inputSchema 的键、必填键都在（脚本工具的 `script` 必须是字符串）、对话确实拿到了 web 服务器（ego_browser 还要 ego 工具）。
  表和 `mcp.ts` 的 schema 由 `launcher.test.ts` 对齐。**没放进去的**：`web_search`（本来就单独预先允许）、两个 guide、改用户设置的
  `character_assign` / `theme_apply` / `theme_delete`（照旧问）。
- **每个浏览器工具都过服务端的闸**（逐个核过 `service.ts` 的 `tool()`）：open / tabs new → `openGate`；click / type / press_key /
  scroll / computer（截图、wait 除外）/ hover / drag / select / eval → `gated()`；其余是读当前页或 back / viewport（同一页重载）。
  没有哪个工具能带着新地址绕过去（`browser_read` 等不收网址参数）。`browser_open` / `browser_tabs` 进了 `mcp.ts` 的 `ASKING_TOOLS`
  （6 分钟调用超时，够等卡）。
- 文案：允许的网站页、联网页那一行、网站卡的说明和「总是允许」的提示都改成「打开、操作都不再问；不在列表的第一次问一次」。
- 测试：`site-gate.test.ts`（open 在五种模式 × 新 / 已允许 / `*.`、完全放开）、`service.test.ts`（问一次、拒绝不加载、总是允许后
  scroll / click / 再打开零卡、tabs new、读不问、没窗口也问、预览）、`launcher.test.ts`（表 = schema、每个工具的 ACP / Codex 正反例：
  像的标题、错的 kind、多的键、少的必填、别的服务器）、`server.test.ts`（没打开的对话打开不在列表的站被拒、没抓）、
  `permission-dock.test.ts`；e2e `ws-phase40.mjs` 的 `siteRule`：两个 Claude 引擎（我们的走 ExecuteExtraTool）+ mock ACP / Codex
  （它们自己对 open / scroll / click 的提示零卡，像的那个照样有卡）：默认模式打开新站恰好一张（网站卡，总是允许）、那个站上 scroll /
  click 零张、再开一个新站一张、脚本一张；完全放开全零。

## 出图的工具在我们的引擎上不延迟（2026-10-26，spec 14.2）

- ccb 把 MCP 工具藏在 `ExecuteExtraTool` 后面，结果整个 `JSON.stringify` 成文字，截图就成了 base64 字。规则：**会返回图片的工具带
  `_meta: ALWAYS_LOAD`（`server/src/mcp/always-load.ts`），别的不带**。这里涉及：`browser_screenshot`、`browser_computer`，
  `computer` 的 `screenshot`、`zoom`、`computer_batch`（`computer/tools.ts` 的 `def(…, PICTURE)`）。完整清单和 e2e（`ws-phase41.mjs`）
  见「ego lite 作为 Agent 的第一浏览器」的坑一节。

## agent-desktop：Windows + macOS 的「操控电脑」（2026-11-04，用户要求）

- 新 MCP 服务器 `desktop`（`server/src/computer/desktop-mcp.ts`），用 vercel-labs/agent-desktop（Apache-2.0，Rust）读无障碍树、按 ref 操作：snapshot / find / act / press / launch / window / wait / screenshot / mouse / clipboard + request_access / list_apps，12 个工具。Windows 上和旧的 `computer` 一起给，macOS 上只给它（`computerSupported` 现在是 win32 或 agent-desktop 有构建的平台）。
- **1.1.0 的正式版没有 `agent-desktop mcp` 子命令**（文档里有）：每个工具调用起一次命令行，单次 0.1–2 s。
- 程序不打包：第一次用时从 GitHub release 下载（`agent-desktop.ts`，钉 1.1.0 + SHA-256），放 `<数据目录>/tools/agent-desktop/1.1.0/`；`CW_AGENT_DESKTOP_BIN` 可指向别的副本。下载在主进程开对话时就开始（走用户代理），MCP 进程里也会等它。
- 授权闸同 `computer`：request_access → 同一张授权卡；ref 只能用在读它的那个应用上；坐标 / 截整屏要求至少授权过一个应用；剪贴板单独授权。
- 真机验过（Windows）：下载 + 校验、list_apps、snapshot（Chrome 103 个 ref 约 1.9 s）、find。**没验的**：macOS（辅助功能权限提示）、真模型自己驱动、未签名程序被 SmartScreen 拦的情况。

## 操控电脑在对话里开关（2026-11-04，用户：在聊天界面点不开，应该放在聊天里）

- 进行中的对话里，`+` 的「操控电脑」「控制 Chrome」能开关（`LIVE_FEATURES`，protocol.ts），其它能力仍是开对话时定死（`LIVE_CAPS_NOTE` 说哪两项能改）。请求 `session.setFeatures`（已进联邦路由表）→ 记进 `SessionMeta.liveFeatures`（之后重开这个对话还带着，分叉不带）→ 在跑的 runner `setFeatures()`：改 features / `extraArgs.chrome`，**这一轮结束后**重启进程（`respawnWhenIdle`），下一句起生效。
- 输入框上方的小条 `features/computer/ComputerPill.tsx`：开着时显示「操控电脑已开」或「正在操控 · 已允许 …」+「关掉」。允许过的应用：`ComputerAccess` 在「允许」/ 完全放开时 emit `granted` → `runner.noteComputerApps` → `info.computerApps`；进程重启时清空（MCP 进程连同授权一起没了，要重新问）。
- 模型中心的「操控」页删了（`ControlPage.tsx` 一直是空数组的占位，从没接上任务）。

## 别动用户已经打开的文件（2026-11-04，真机测试时出事）

- 测试时 `launch notepad` 接管了用户开着的记事本（Win11 记事本是单实例 + 标签），`set_value` 把当前标签「mobbin脚本.js」整个换掉；UIA 的 SetValue 不进撤销记录，Ctrl+Z 撤不回。
- 现在：`DesktopService` 在 snapshot / find 时记下每个 ref 的值；`set_value` / `clear` 打到已有文字的 ref 上默认拒绝，要 `overwrite: true`（说明里写只在用户要求替换时传）。`launch` 前先 list-apps，应用已经在跑时结果里提醒「这是用户自己的窗口，先 ctrl+n 新建再写」。服务器说明里加了同样的规矩；授权卡的 ACCESS_NOTE 写明「已经打开的窗口和文件它也能改」。
- 以后真机测 `desktop` 工具：只用自己新开、确认是空的窗口，或者只读（snapshot / find / screenshot）。
