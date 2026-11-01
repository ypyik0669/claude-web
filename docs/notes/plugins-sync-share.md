# 插件 / 同步 / 远程共享（2026-10-26，spec 统一模型来源 §4.3、§8）

## 插件（`server/src/plugins/`）

两种，永不混用：

- **来源定义**（`declarative.ts`）：`<数据目录>/plugins/*.json`（跟 `CLAUDE_WEB_DIR`）。只是数据：endpoint、protocol（anthropic / openai / openai-responses / gemini）、auth（bearer / x-api-key / both / none）、models（上下文、最大输出、tools / images / reasoning / stream、free、mayTrain）。未知字段丢掉；endpoint 必须 https（http 只给本机 / 私网），URL 里不许带账号密码。文件可以是 `{ id, name, sources: [...] }`，也可以是单个来源对象（id 取文件名）。
- **可执行插件**（`runtime.ts`）：`plugins/<文件夹>/plugin.json` + 入口（CommonJS）。manifest 声明 `hooks`（`request-before` / `response-after` / `source-provider`）和 `permissions`（`network` 主机名、`fileRead` 路径、`secrets` 名字）、`timeoutMs`（默认 10 s，上限 60 s）、`maxOutputBytes`（默认 64 KB，上限 1 MB）。

可执行插件怎么隔离：

- 单独的 Node 子进程（Electron 下 `ELECTRON_RUN_AS_NODE=1`），`windowsHide: true`，**环境变量只给最小集**（不继承我们的 key / 代理）。
- 有 `--permission`（Node 22.13+）或 `--experimental-permission` 时开权限模型：只读自己的文件夹、bootstrap、声明的路径；子进程 / worker / addon 默认禁。没有时 `isolation: 'process'`，界面写「单独进程」。
- bootstrap（`BOOTSTRAP`，启动时写到 `plugins/.runtime/host.cjs`）在 require 层拒绝 net / http / https / tls / dns / child_process / worker_threads / vm 等；`globalThis.fetch` 换成 `host.fetch`，走父进程：只许 https、只许声明的主机、请求体过隐私钩子（`setPluginPrivacyHook`，隐私模块启动时注册；钩子抛错 = 不发）、超时、4 MB 上限、不跟随重定向、去掉 set-cookie。
- 拒绝 require 不够：`net.Socket` 不用 require('net') 也拿得到（`tty.ReadStream` / `WriteStream` 继承它，`process.stdin` 可能就是一个），
  它的 `connect()` 照样外连（SEC-02，Node 24 + `--permission` 实测连得出去；Node 24 / Electron 44 的 Node 24.19 都没有 `--allow-net`）。
  所以 bootstrap 在挡 require 之前自己加载 net / dgram，把 `net.Socket.prototype.connect`、`net.Server.prototype.listen`、
  `dgram.Socket.prototype.{bind,connect,send}` 换成抛错并锁死（不可写、不可重定义）。http / tls / undici 最后都走 Socket.connect，一并堵住。
  不挡 `tty`：supports-color 之类的库要 `tty.isatty`。测试：`runtime.test.ts`「a real child cannot open sockets through a side door」。
- 每次调用有超时，超时**杀子进程**，下一次调用重新起；stdout / stderr 截到上限，界面显示最后一段。
- 密钥：只有声明过、且用户批准过的名字才给；目前支持 `provider:<供应商 id>` = 那个供应商的 key（SecretService 解密后只发给这个子进程）。
- 批准绑在 manifest 的哈希上（main + hooks + permissions），manifest 一变就要重新确认（`plugins.enable` 带 `approve: true`）。状态在 meta.json 设置 `plugins.state`（只有 enabled / approvedHash，没有秘密）。

接入点（**还没接线**，留给对应模块）：

- 渠道目录：`pluginSources()`（`declarative.ts`）返回 `SourceSummary[]`（id `plugin:<插件>/<来源>`，kind 暂用 `provider`），channels 的投影里 append 一下即可；原始定义用 `pluginSourceDefs()`。
- 网关：`PluginService.runHook('request-before' | 'response-after', payload)`，按名字顺序跑所有启用且批准的插件，出错 / 超时跳过、请求照常。gateway/service.ts 的 `attempt` 调它（merge-1 接上）：request-before 在隐私脱敏之后（插件只见占位符）、每个重试变体都过一遍；response-after 只给整段非流式回答，在隐私还原之前（passthrough 时请求改 `accept-encoding: identity`，仍是压缩的回答不过插件）。payload 是 `GatewayHookPayload`（source / model / path / body），插件返回 null 或同样的 body 时原字节不变；没有启用的插件声明这个 hook 时什么都不调（`hasHook`）。流式回答不过 response-after。
- 远程目录：`verifyRemoteCatalog(body, sig)` 用 Ed25519 验签后只解析成来源数据；`mergeRemoteCatalog` 不覆盖用户改过 / 关掉 / 删掉的。`CATALOG_PUBLIC_KEYS` 现在是空的——发版带上公钥前远程层不生效。

WS：`plugins.list / reload / enable / disable / remove`（remove 只删插件目录里的东西）。界面 `web/src/features/plugins/PluginList.tsx`，启用可执行插件前用 `dlg.confirm` 列出权限。

### 市场与一键安装（P7）

- 设置在 meta.json 的 `plugins.market`：`{ url, publicKey? }`。`url` 必须是 https；`publicKey` 是 Ed25519（PEM 或 base64 SPKI DER）。`plugins.market.set / status / refresh`。
- 目录格式：`{ entries: [...] }`，可以再加 `signature`（base64 Ed25519，签 `JSON.stringify(entries)`）。配了公钥就必须有签名，验不过就整份丢弃；条目本身和 `plugin.json` 走同一套 `market.ts` / `manifest.ts` 校验。条目可带 `sha256`（下载字节的 SHA-256）和 `signature`（下载字节的 Ed25519 签名），`kind: 'declarative' | 'executable'`（默认 executable）。
- 缓存：`<plugins>/.market/catalog.json`（0600，保存原始 body 和 URL；每次 status 都重新按当前公钥验签），内存里也留一份。刷新失败保留上一份好缓存。
- 安装 `plugins.install { id? , url? , path? , sha256? , acknowledgeUnverified? }`：下载上限 64 MB、最多 5 次重定向且每一跳都要 https；先校验 SHA-256 / 签名，再解包。zip 用 `import/zip.ts` 的读取器，tar.gz 自己解析；解包层（`plugins/archive.ts`）拒绝绝对路径、`..`、盘符、设备名、链接，限制条目数 / 单文件 / 总大小；去掉共享的顶层文件夹后写进 `<plugins>/.tmp/install-*`，再 `plugin.json` 校验、`main` 必须存在，最后 rename 成 `<plugins>/<id>`。声明式则是一个 `.json`，通过 `parseDeclarative` 后写成 `<plugins>/<id>.json`。装完 `reload()`；**安装过程不 require / 不启动任何下载的代码**，可执行插件仍要启用时批准权限。
- **验证与未验证（SEC-08，2026-11-01）**：我们没有官方签名私钥，不内置公钥（`CATALOG_PUBLIC_KEYS` 也是空的，远程来源目录因此一直不生效）。规则：
  - 配了公钥：目录必须签名且验得过（否则整份丢弃）；每个条目还得用 `signature` 或 `sha256`（被目录签名覆盖）钉住字节，两样都没有的条目丢进 `errors`（「没有签名或校验值」）。有 `signature` 就必须验过，`acknowledgeUnverified` 也压不过验不过的签名。这样的条目 `verified: true`，直接装。
  - 没配公钥的目录、`url` 直接安装、`path` 本机文件：一律 `verified: false`（`reason: 'unsigned-catalog' | 'url' | 'file'`），条目上的 `signature` 没法验，忽略。**服务端**要求 `plugins.install` 带 `acknowledgeUnverified: true`（handlers 只认字面量 `true`），否则拒绝——不靠界面。`id` 和 `url` 一起给时不查目录，按 url 算未验证（防止借条目的验证）。
  - `plugins.install.check { id? | url? | path?, sha256? }`：下载 + 做全部检查但不装，回 `{ verified, reason?, sha256, size, kind, id?, name?, source }`（source 去掉账号和 query）。界面对未验证的先 check，`dlg.confirm`（danger + focusCancel，「仍然安装」）里写明是未经验证的代码、会在这台电脑上运行（声明式写成请求和密钥会发到它的地址），列出来源 / SHA-256 / 大小；确认后 install 时把这个 sha256 带上，服务端按它核对（重新下载了一次，确认的字节和装进去的必须是同一份）。
  - 请求里的 `sha256` 一律强制核对，条目的 `sha256` 也核对（两者都有就都得对）。安装结果 `installed` 带 `verified` 和 `sha256`。
  - 界面：市场卡片「已验证 / 未验证」chip；市场页下面一块「从地址安装」（地址 + 可选 SHA-256）。测试：`market-service.test.ts` 的 `unverified packages (SEC-08)`。
- 同名插件不覆盖：先删再装。id 以 `.` 开头（含 `.` / `..`）一律拒绝，否则会被 reload 跳过或跳出插件目录。
- 界面：`web/src/features/model-hub/pages/PluginsPage.tsx` 的「市场」页（地址 / 公钥、保存、刷新、条目卡片、安装中状态、空 / 错误状态）。

## 同步（`server/src/sync/`）

- `backup.ts`：文件格式 `claude-web-sync` v1。明文部分：供应商（去掉 apiKey 和本机学到的 / 缓存的字段：models、modelNames、modelEfforts、modelContext、modelsAt、modelsError、promptEffortModels、no*）、账号引用（id、kind、名字、并发、每日上限、邮箱 / 套餐，**没有凭据**）、网关组（成员和模型映射）、密钥组（共享权限，不含密钥本身——密钥每台机器自己发）、设置里的 `routing.*` / `models.*`。任何设置值里像绝对路径的（`C:\`、`\\`、`~/`、`/home/…`）都去掉。
- 加密部分（`crypto.ts`）：口令 → scrypt（N=2^15, r=8, p=1）→ AES-256-GCM，带 AAD；口令至少 8 个字。里面是供应商 key、账号凭据和代理、`privacy.*` 设置（spec：凭据与隐私配置用独立口令）。没口令就只导出明文部分。导入时 scrypt 参数有上限，伪造的文件吃不掉内存。
- `merge.ts`：逐项。设置 / 网关组 / 密钥组按 key 和字段合并，本机独有的保留；供应商 / 账号的**凭据两边不同 = 冲突，两份都留**，传入的另存为「名字（同步）」（新 id 加后缀），绝不覆盖。本机没有 key 而文件有 → 补上。
- WS：`sync.export { passphrase? }` → `{ filename, text }`（浏览器用 Blob 下载）；`sync.import { text, passphrase? }` → 预览（token，10 分钟，解密后的东西只在内存）；`sync.apply { token, skip }`；`sync.cancel`。界面 `web/src/features/sync/SyncPanel.tsx`。
- 远程同步（2026-10-28，P9）：`remote.ts` + `backends/{webdav,s3,github}.ts` 把同一份 backup 放到 WebDAV / S3（SigV4）/ GitHub（contents API）。地址只收 http(s)、凭据全走 `SecretService`（状态只回圆点，保存时圆点表示保留、空串表示删除）；WebDAV 用 LOCK / If / ETag，S3 用条件请求，GitHub 用 blob sha；推送前拿锁、失败也解锁，拉取只产生 `SyncPreview`，确认后走同一个 `sync.apply` 合并。设置存 `settings['sync.remote']`，界面在「设置 → 备份与同步」的 `RemoteSyncPanel`。错误按 HTTP 401/403/404/409/412/429 分开说原因。测试 `remote.test.ts` / `backends.test.ts` 全部注入 fetch，不碰真网络。
- 坑：账号直接写 meta（`saveUpstreams`），UpstreamService / sidecar 不会马上知道新账号，可能要重启或刷新一次。

## 远程共享（`server/src/share/`）

- 不加第二个监听：共享密钥就是网关密钥，放在 `share` 密钥组里（第一次建时 `allowLan: true`，IP 白名单默认三段私网）。每把钥匙多一个 `GatewayKey.share`（`ShareRules`：routeGroupIds、models、concurrent、daily / weekly / monthly 的 requests / tokens）和 `period` 计数（ISO 周、月）。
- 检查在 `upstreams/keys.ts`：`verify()` 返回 `effectiveGroup(组, share)`——只收窄不放宽（来源取交集，模型两张表都要过，并发取小的；收窄成空就是 `~none~`，不会退回「全部」）；`canSpend()` 查日 / 周 / 月额度；`recordUsage()` 记周 / 月。这样网关 `serveRequest` 不用改。
- 局域网：用网关已有的 LAN 监听（默认关）。它只服务 `/v1…`、`/v1beta…`、`/healthz`，管理接口永远不在那上面；远程请求和本机走同一条 `run()`（协议转换、隐私、审计日志）。
- WS：`share.status / share.lan.set / share.keys.create / share.keys.update / share.keys.delete`，改完发 `gateway.changed`。界面 `web/src/features/share/ShareDrawer.tsx`（地址、白名单、密钥、权限、额度、今天 / 本周 / 本月用量）。
- 已知：周 / 月额度用完时 `retry-after` 仍是到午夜的秒数（serveRequest 里的 secondsToMidnight）。

## 三个界面

都是自包含组件，网关页挂载：`PluginList`、`SyncPanel`、`ShareDrawer`。样式沿用网关页的 `gateway-tab / gateway-card / gateway-row`。

## 出网守卫 / OTLP / 插件系统级隔离 / 共享额度重试时间 / 远程目录（2026-10-28，从 Magpie 移植）

- **出网守卫** `server/src/net/netguard.ts`：用户填的地址在请求前查每个 DNS 答案；直连时在连接那一刻再查一次（防 DNS rebinding），每次重定向都重查。三档：只公网（插件市场 / 包、远程目录、插件的 `host.fetch`）、也许局域网和本机（WebDAV / S3 / GitHub 同步、OTLP 收集器）、直装地址（保留市场原有的 localhost 放行）。云元数据（169.254.169.254）和 link-local 一律拒，IPv6 里藏的也拒。走代理时只做第一次检查（名字由代理解析，`proxy.proxiedFor()`）。
- **OTLP 导出** `server/src/telemetry/otlp.ts`：默认关。读请求记录的批次，不碰网关；只发模型、来源、路由组、协议、状态、错误码、耗时、token——不发 key id、客户端 IP、提示词。收集器的请求头用 SecretService 加密，界面只看得到名字。请求记录关了就没东西可导，面板会说。peer / 手机只能看不能改。
- **插件系统级隔离**：Node 权限模型（`--permission`；读只限插件目录，写只限 `.data/<id>` + 声明的路径），子进程 / worker 默认关，要 manifest 声明 + 用户批准（批准对话框和插件列表会列出「启动别的程序」「开后台线程」，启动程序算危险项）。内存默认 256 MB（32–1024），启动后降到低于正常的 CPU 优先级。Windows 上再多要原生模块。**打包后的 Electron 44（Node 24.19）验过**：`--permission` 在，写数据目录 ok，写外面 / 读家目录 / 起子进程都是 `ERR_ACCESS_DENIED`。
- **共享密钥的重试时间**：以前一律回「本地午夜」——周 / 月额度的调用方每晚白跑一趟，日额度其实按 UTC 午夜重置，非 UTC 时区差几小时。现在 `share/limits.ts` 的 `quotaRetryAfter`：日 = 下一个 UTC 午夜，周 = 下一个本地周一，月 = 下月 1 号，几个都用完取最晚的。
- **签名远程目录**：不内置官方地址。用户填 https 地址 + Ed25519 公钥后立刻取、验签，超过 24 小时后台再取；签名不对保留上一份好的；关掉立刻不算。模型中心 → 设置里有「远程模型目录」和「导出到 OpenTelemetry」两块。
