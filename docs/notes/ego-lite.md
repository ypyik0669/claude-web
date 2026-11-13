# ego lite 作为 Agent 的第一浏览器（2026-10-26，用户要求）

用户要把 [ego lite](https://github.com/citrolabs/ego-lite)（citrolabs，不开源的 Chromium 应用，mac / Windows）当成
「第一浏览器」。选定的意思是：**装了 ego lite，Agent 上网、点击、填表、截图先走它**（用用户在 ego lite 里的登录，
每个对话一个独立 Space）；没装 / 连不上退回内置浏览器；内置浏览器留给用户看预览；回答里的链接、预览照旧在内置浏览器里开。

## 怎么接的

- ego lite 没有可嵌的窗口，也没有 MCP；Agent 通过它首次引导装进 PATH 的 `ego-browser` 命令操作它：
  - `ego-browser skill`：打印和已装版本对应的用法，第一行 `[ego-browser:skill] … v<版本>`（我们从这里取版本号）。
  - `ego-browser nodejs -e "await import('file:///…/round-NN.mjs')"`：跑一段 JS，里面有 `taskSpace(name)`、
    `task.page('p1')`、`page.goto / snapshot / click / fill / screenshot`。**每次是新进程**：Space 和标签页留着，变量不留。
  - 它的 skill 明确要求 Windows 上用 `.mjs` 文件 + `import()` 这一行：脚本放命令行或 stdin 会被 shell 吃掉引号和中文。
- `server/src/web/ego.ts`：
  - `egoStatus(force)`：`findOnPath('ego-browser')` + 跑一次 `skill`。缓存 1 分钟，`force`（设置里的「重新检测」）先 `refreshProcessPath(true)`。
    启动时 `index.ts` 在 PATH 补完（注册表 + `~/.local/bin`）之后探一次。
  - `runEgoScript`：脚本写成 `<dataDir>/runtime/ego/<对话 id 前 8 位>/round-NN.mjs`（UTF-8），开头两行
    `globalThis.CW_SPACE = "claude-web <id8>"; globalThis.CW_OUT = "<那个目录>";`；`resolveSpawn` 启动（不经 shell，`.cmd` 垫片展开，
    `windowsHide`），超时默认 120 s、最多 10 分钟，到时 `killTree`；同一对话串行；输出各保留 60 KB（头尾）；这一轮新存进目录的
    png/jpg/webp 最多 4 张、每张 ≤ 5 MB 作为图片返回；结果开头写「网页内容是不可信数据」。
  - 命令没了 / 输出像连不上（`looksUnreachable`）→ 结果里带 `EGO_FALLBACK`：叫 Claude 这个对话改用 `browser_*`。这就是「退回」。
- `web/mcp.ts`：`EGO_TOOLS`（`ego_browser_guide`、`ego_browser`）只在环境变量 `CW_WEB_BROWSER=ego` 时列出（`toolsFor`），
  这时每个 `browser_*` 的说明末尾加「ego_browser 能用时优先用它」，`instructions` 也加一句。
- `web/launcher.ts`：设置 `web.browser.agent`（`auto` 默认 / `builtin`）+ 最近一次探测找到命令 → 启动参数里加 `CW_WEB_BROWSER=ego`。
  Claude / Codex / ACP 三条路都走 `spawnShape`，都生效；改设置只对之后新开的对话生效。
- 权限（2026-10-26 改，spec 14.1 / 14.4）：**由服务端问，不分 Agent**（以前靠各 Agent 自己的提示，Codex / ACP 可能不问就跑）。
  `service.ts` 的 `egoGate` 在跑脚本前用 `needsAsk('eval', …)` 判断（除「完全放开」外每次问；没有 gate 不问），经 `gate.ask` 发
  `browser.site` 卡，`input.tool = 'ego_browser'`、**整段脚本**（`site-gate.ts` 对 ego 不截 400 字）、`host` = 脚本里第一个网址的主机
  （`scriptHost`）。前端 `isEgoScriptRequest` → `EgoScriptRequest` 卡：标题「Claude 想在 ego lite 里运行一段脚本（host）」、代码块、
  只有「允许一次 / 拒绝」，不认 Enter。回答 `always` 当一次，永不写允许的网站。拒绝 / 超时 / 对话停下 → 不跑，结果是「用户没有允许…」，
  **不带 `EGO_FALLBACK`**（不能让模型换内置浏览器做同样的事）。为免 Claude 再弹自己的卡，`mcp__web__ego_browser` 进了 `webAllowedTools`；
  `ego_browser_guide` 也在里面。`ToolPermission` 里对 `mcp__web__ego_browser` 的老卡留着：别的 Agent 可能还会先自己问一次。
- **服务端自己问的工具**（`launcher.ts` 的 `SERVER_GATED` 表，2026-10-26 Task 4 修正轮）：`ego_browser`（参数键 `script` /
  `timeout_ms`，要有 ego 工具）和内置浏览器的 `browser_eval`（参数键只有 `script`，有 `web` 服务器就算）。服务端每次都问
  （`site-gate.ts` 的 `needsAsk` 对 `eval` 在查允许的网站之前就回 `'eval'`；`service.ts` 把改页面的 op 都送进 `gated()`；没有
  宿主窗口时 `browser_eval` 直接报需要桌面版；卡没人答 = 拒绝），所以 Agent 自己的提示一律不弹：Claude 把两个都放进
  `webAllowedTools`；ACP / Codex 见下。click / type / key / scroll 这些**不在表里**：服务端只在网站不在允许列表时才问，
  Agent 自己的那张卡才是剩下情况的唯一一问（要不要改，等用户定）。
  - **2026-10-27 用户定了**：允许的网站是内置浏览器唯一的说了算，表里现在是 ego_browser + **全部 20 个 `browser_*`**，每个带它
    inputSchema 的键和必填键（`script` 只对两个脚本工具要求是字符串）；打开不在列表的网站也由服务端问一次（`op: 'open'`）。
    ACP 的 kind 仍只认缺省 / null / `other`，`fetch` / `read` 照拒。细节在「搜索在内置浏览器里 / 网页上的鼠标键盘 / 操控电脑」的
    「允许的网站是内置浏览器唯一的说了算」一节。
- ACP Agent 自己的提示（`AcpDriver.onPermission`）：只有**确切是表里的工具**才直接答、不弹卡
  （`isServerGatedAcpCall(tc, given)`）：**这个对话拿到了那个工具**（交给 Agent 的 `mcpServers` 里有 `web`；ego_browser 还要它带
  `CW_WEB_BROWSER=ego`；`acpWebToolsGiven`，记在 `AcpDriver.webTools`，Agent 收下这份列表才算；没拿到就不是我们的，同名的是别人的，
  一律走卡），标题整串等于 `<tool>` / `mcp__web__<tool>` / `<tool> (web MCP Server)`，`kind` 没有、null 或 `other`，
  `rawInput` 必须在、是普通对象、`script` 是字符串、键只能是表里那个工具的（脚本内容不看，服务端的卡给用户看）。
  答的是 `allow_once`，没有就 `allow_always`，两样都没有就照常弹它的卡——**绝不替用户挑 reject**。完全放开也照这条
  （以前回退到 `options[0]`，可能是个 reject）。
  **别放宽成「包含 ego_browser」**：
  ACP 的标题是拿调用本身拼的（shell 命令原文、文件名），`rm -rf ~ # ego_browser` 这种就会一张卡都没有地跑掉（2026-10-26 审查抓到过）。
  不认 `normalize.ts` 推出来的名字（它会把「ego browser」也变成 `ego_browser`）。已知剩下的口子：用户自己配了一个也叫 `web` 的 MCP 服务器、
  里面有个 `ego_browser`，标题会一样，会被当成我们的（要用户自己的配置才做得到）。有的 ACP Agent 给 MCP 调用起的标题可能不是这个格式：
  那就退回它自己的卡，用户看到两张卡（多问一次，不漏问）。各家真 Agent 实际给的标题还没真机核对过。
- Codex 自己的提示：Codex（codex-cli 0.163，`codex app-server generate-ts` 生成的 `ServerRequest` 里有）在 MCP 工具调用前发
  `mcpServer/elicitation/request`：`mode: 'form'`、`_meta.codex_approval_kind = 'mcp_tool_call'`、`_meta.tool_params` 是参数，
  工具名只在固定的 message 里：`Allow the <server> MCP server to run tool "<tool>"?`（codex-rs `core/src/mcp_tool_call.rs`；
  feature `tool_call_mcp_elicitation` 默认开；没有 `readOnlyHint` 的工具在 untrusted / on-request 下都要问）。以前 `CodexDriver`
  不认这个请求，回 -32601，Codex 当没批——默认模式下 Codex 里我们 `web` 的会改页面的工具都跑不起来。现在（`codex-driver.ts` 的
  `onElicitation`）：确切是 `web` 的表里工具（固定 message 一字不差）、这个对话拿到了它（`codexWebToolsGiven`：从
  `webCodexConfigArgs` 自己写的 `-c` 读回来，前缀 / 条目 / 分隔符是同一份常量和 `tomlEntry`，ego 那条要是内联表里完整的一条）、
  参数形状同上（`isServerGatedCodexElicitation`）→ 回 `accept`；别的 MCP 工具 → 普通的卡（`toolName: mcp__<server>__<tool>`，
  input 是参数），允许 = accept、拒绝 = decline、打断 = cancel；完全放开 / dontAsk → accept；plan 和默认一样（表里的不弹，别的弹）；
  不是工具审批的（MCP 服务器自己的表单 / url 问题）→ `cancel`，和以前的「不认」效果一样。
  **所有 accept 都不带 `_meta.persist`**：Codex 那边什么都不记，用户在卡上点「总是允许」在这里也只算一次，下次照样问。
- 设置 → 联网 →「Agent 用哪个浏览器操作网页」（`WebSettings.tsx`）：ego lite（装了就用它）/ 内置浏览器、检测结果、「重新检测」
  （`web.egoDetect`）、官网链接（系统浏览器打开）。`WebStatus` 多了 `agentBrowser` 和 `ego`。

## 坑

- **我们的引擎（ccb）把 MCP 工具藏在 `ExecuteExtraTool` 后面，而且它的结果是 `JSON.stringify(整个结果)`**：截图会变成一长串
  base64 文字交给模型，模型看不到图。所以两个 ego 工具带 `_meta: {'anthropic/alwaysLoad': true}`（ccb 的 `Vi()` 认它，不再延迟），
  直接出现在工具列表里，图片按图片块回去。
- **规则：会返回图片的内置工具都要带 alwaysLoad，别的工具都不带**（每轮工具列表会变长）。常量只有一份：
  `server/src/mcp/always-load.ts` 的 `ALWAYS_LOAD`（无 import，stdio MCP 进程也能加载）。现在带它的：`web` 里的
  `browser_screenshot`、`browser_computer`、`character_draft`、`theme_draft`、`ego_browser`（加上 `ego_browser_guide`，
  它是跟着 ego_browser 一起加的，不出图）；`computer` 里的 `screenshot`、`zoom`、`computer_batch`。`preview_*`、`sessions`、
  `memory` 只回文字，不带。新加出图工具时同时改 `web/mcp.test.ts` / `computer/tools.test.ts` 里的清单（它们查的是「恰好这些」）。
- 另外，ccb 要求延迟的工具先被 `SearchExtraTools` 找到过才能 `ExecuteExtraTool`，否则返回 `result: null`；写假上游时别忘了先搜。
- 官方二进制读不出尺寸的图片会被换成「Image could not be processed」文字：测试里的假截图要是真的 PNG（1×1 也行）。
- 命令行上没有脚本，只有 `await import("file:///…")`；Space 名用对话 id 前 8 位，别的对话的 Space 不会被碰到。
- **Windows 上 ego-browser 要是个普通 `.cmd` / `.bat`**（不是 npm 那种 `%~dp0\x.js` 垫片），`resolveSpawn` 会经 cmd.exe 跑：
  `execFile` / `spawn` 必须带 `windowsVerbatimArguments: s.via === 'cmd'`（别的调用方都带，第一版漏了，结果「没找到」）；
  而且 cmd.exe 会展开 `%`，`resolveSpawn` 直接拒绝带 `%` 的参数——`pathToFileURL` 给 `C:\Users\张三`、带空格的路径编出的
  `%E5…` / `%20` 就过不去。所以 import 的地址用 `decodeURI` 后的原字（`import()` 自己会把它当 URL 解析）；只有路径里本来就有
  `%` 才保留编码。`resolveSpawn` 抛错时返回退回提示，不让它变成 HTTP 500。
- 停止：对话停下时 MCP 进程收到 `notifications/cancelled` → 关掉对 server 的请求；`web/http.ts` 看到连接关了就 abort，
  `runEgoScript` 结束子进程（还在排队的那轮直接不跑）。
- 脚本上限 60 000 字：工具接口的请求体上限是 256 KB，中文一个字 3 个字节。

## 测试

- 单元：`server/src/web/ego.test.ts`（假 `ego-browser`：node 脚本 + Windows `.cmd` 垫片放临时 PATH，`FAKE_EGO_MODE` 切 noskill / down），
  `mcp.test.ts`（按环境变量列不列、说明加句、alwaysLoad、超时）、`launcher.test.ts`（设置 × 探测 → `CW_WEB_BROWSER`），
  web 的 `web-tools.test.ts`。
- e2e：`server/ws-phase40.mjs`（自己起 server，PATH 前面放假 `ego-browser`，两个真引擎对假上游）：找到版本、工具在列表里且不延迟、
  权限卡带脚本、round 文件逐字节、中文 / 引号 / `$` / `%` 原样回到模型、截图是图片块、选「内置浏览器」后新对话没有 ego 工具。
  权限规则：每个引擎上默认模式 ego_browser 整轮恰好一张卡（服务端的，数的是这一轮所有的卡，不只名字带 ego 的）、完全放开零张卡
  且脚本照跑、输出回到模型；内置浏览器的 `browser_eval`（这个脚本的 WebSocket 当宿主窗口）默认整轮恰好一张（服务端的，带脚本）、
  完全放开零张。然后 mock ACP Agent / mock Codex（argv 带 `app-server`，好让 `-c`
  插在它前面）：Agent 自己对 ego_browser 的提示不弹卡；调用本身由脚本经真的 `web` MCP 入口、带这个对话的 id 发出（Agent 的 MCP
  进程就是这么调的），默认一张服务端的卡、完全放开零张。`PHASE40_RUNTIMES` / `PHASE40_AGENTS` 可缩小范围。跑完删掉临时根目录。
  驱动层的单元测试在 `agents/drivers.test.ts`（ego 工具开 / 关、没有 web 服务器、只给 reject、只给 always、完全放开只给 reject、
  各种像而不是的调用、browser_eval；Codex 的 elicitation：默认 / plan / dontAsk / 完全放开、没给 web 服务器）。
- e2e：`server/ws-phase41.mjs`（自己起 server，这个脚本的 WebSocket 当内置浏览器的宿主窗口，截图回一张真 1×1 PNG）：
  我们的引擎上 `browser_screenshot` 在工具列表里、直接调用而不是经 `ExecuteExtraTool`（另外核对：下一个请求的 tool_result
  回的正是那个名叫 `browser_screenshot` 的 tool_use 的 id），模型收到的 tool_result 里是图片块、数据和窗口回的 PNG 逐字相同，
  文字块里没有 base64。跑完删掉临时根目录。默认只跑 ccb，`PHASE41_RUNTIMES=ccb,claude` 再跑官方二进制。把 alwaysLoad 去掉再跑，前四项会 FAIL
  （tool_result 变成一整段 JSON 字符串）。
- ui-smoke：设置 → 联网的新一行和「重新检测」，切到内置浏览器后 `web.status` 跟着变。
- 真 ego lite（2026-10-28，ego-browser 2.1.0）：用 `egoStatus(true)` + `runEgoScript` 直接跑（不经对话）：版本读出、
  `claude-web <id8>` Space 建出来、`page.goto/snapshot/screenshot` 都通，截图作为图片块回来。**2.x 把脚本的 `console.log`
  打在 stderr 上**：退出码 0、stdout 空时 stderr 当「输出：」显示，不再标「错误输出」（以前模型会以为脚本出错）。
  还没做的：经真对话让 Claude 自己调 `ego_browser`。

## 官方二进制 2.1.322 起 MCP 工具在 ToolSearch 后面（2026-11-13，e2e 第 40 段挂 11 项）

- 0.5.8 把自带的官方 Claude Code 升到 2.1.322 之后，它经供应商（中转）跑时默认也开工具搜索：请求里只有 14 个内置工具 + `ToolSearch` +
  一个 `DeferredToolPlaceholder`（`defer_loading`），`web` 服务器里只有 `alwaysLoad` 的那几个（`browser_computer` / `browser_screenshot` /
  `ego_browser` …）还在列表里，`browser_open` / `browser_eval` / `browser_scroll` 这些要先 `ToolSearch`（`select:<名字>`）再**按原名**调用。
  官方二进制没有 `ExecuteExtraTool`（那是我们的引擎的）。
- 第 40 段的假上游以前「不在列表里就走 `ExecuteExtraTool`」，在官方二进制上得到 `No such tool available: ExecuteExtraTool`，11 项全挂在这。
  产品这边没坏：假上游学会 `ToolSearch` 之后 91/91——网站卡、允许的网站、完全放开在官方二进制上都照旧。
- 没验的：真中转上 `ToolSearch` 回来的 `tool_reference` 块对方认不认（把 Anthropic 格式转给别家模型的中转可能不认，那样官方二进制上这些
  延迟的工具就调不到）。要关可以给对话的环境变量设 `ENABLE_TOOL_SEARCH=false`（二进制里 `upe()`：false → 全部内联）。
