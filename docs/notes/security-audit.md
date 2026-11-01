# 安全审计（2026-10-31，用户要求）

只读审计，基于 `f069c7a`（0.4.6）。每条是一个可以单独派发的任务：编号、位置、怎么被打、建议怎么修、状态。
修完一条就把状态改成「已修（提交 xxx）」，并把新的经验写进对应模块的笔记。行号会漂，以函数 / 代码片段为准。

## 状态总览

| 编号 | 级别 | 标题 | 状态 |
| --- | --- | --- | --- |
| SEC-01 | 高 | 浏览器版无 token 时 DNS rebinding → 远程执行 | 已修（2026-11-01） |
| SEC-02 | 高 | 可执行插件网络沙箱可经 `tty` 绕过 | 已修（2026-11-01，短期修法；OS 层隔离未做） |
| SEC-03 | 高 | 手机壳托管服务器是最高信任根 | 已解决：整块删除（2026-10-31） |
| SEC-04 | 中 | 慢速转发没有前向保密 | 已解决：整块删除（2026-10-31） |
| SEC-05 | 中 | 配对链接泄露 = 10 分钟内完全控制 | 已解决：「复制配对链接」随整块删除；局域网配对码仍是 6 位 / 10 分钟 / 5 次 |
| SEC-06 | 中 | 局域网直连明文 HTTP、监听 0.0.0.0、token 进 URL / 非 HttpOnly cookie | 部分修（2026-11-01）：cookie / 设备权限 / 文案；TLS 未做 |
| SEC-07 | 中 | 联邦「来自对端」限制由客户端自报 | 已修（2026-11-01） |
| SEC-08 | 中 | 插件市场签名非强制、公钥未内置 | 已修（2026-11-01）：未验证要显式确认；没有内置公钥（fork 没有官方目录） |
| SEC-09 | 中 | 托管程序下载的校验值与二进制同源 | 已修（2026-11-01） |
| SEC-10 | 中 | API key 明文出现在子进程命令行；Linux 只 base64 | 已修（2026-11-01）：macOS 实测；Windows / Linux 只有单测 |
| SEC-11 | 中 | 本机任意 localhost 页面可连 `/ws`（无 token 模式） | 已修（2026-11-01，随 SEC-01） |
| SEC-12 | 低 | 手机远程的元数据泄露（固定频道名、IP、时序） | 已解决：整块删除（2026-10-31） |
| SEC-13 | 低 | 公开的 TURN 口令 / 匿名 mosquitto 可被滥用 | 已解决（代码已删；coturn / mosquitto 在上游的 VPS 上，不归本 fork 管） |
| SEC-14 | 低 | 一台手机配多台电脑互不隔离 | 已解决：整块删除（2026-10-31） |
| SEC-15 | 低 | IM `/pair` 配对码无失败次数上限 | 待修 |
| SEC-16 | 低 | 完全放开模式下的操控电脑授权离开模式后仍有效 | 待修 |
| SEC-17 | 低 | 深链接 `q=` 预填指令可被用于社工 | 记录 |
| SEC-18 | 低 | 同步解密 `setAuthTag` 不校验 tag 长度 | 待修 |
| SEC-19 | 低 | 主 token 比较非定长时间 | 待修 |
| SEC-20 | 低 | 浏览器模式 url-guard 不拦回环 / 本应用端口 | 待修 |

## 高

### SEC-01 浏览器版无 token 时 DNS rebinding → 远程执行（已核对代码）
- 位置：`server/src/index.ts` 的 `authOk`：`if (!token && !viaRemote) return true`；`upgrade` 里的 `originOk`：`originHost === req.headers.host` 即放行。整个 server 没有 Host 白名单。
- 攻击：用户 `npm start` / `npm run dev`（不设 `CLAUDE_WEB_TOKEN`）→ 访问 `http://evil.com:3090`，evil.com 重绑定到 127.0.0.1 → Origin、Host 都是 `evil.com:3090`，`/ws` 连上 → 开 bypassPermissions 对话跑命令；`GET /api/file?path=~/.ssh/id_rsa` 读文件。上传接口的 `sameOriginRequest`（`cloud/same-origin.ts`）同样被绕过。
- 不受影响：桌面版（`desktop/src/server-host.ts` 每次启动生成随机 token）。
- 修法：没有 token 时，主监听口只接受 Host 为 `127.0.0.1` / `localhost` / `[::1]`（带端口）的 HTTP 和 WS；或浏览器模式也默认生成 token（打印带 token 的地址）。同时收紧 SEC-11。
- 验证：e2e 里伪造 `Host: evil.com:3090` + 同 Origin 的 WS 和 `/api/file`，应被拒。
- **已修（2026-11-01）**：`cloud/same-origin.ts` 加 `loopbackHost`，`authOk` 无 token 的分支改成 `return loopbackHost(req.headers.host)`，
  所以 `/ws`、`/api/file`、上传都只认 Host 为 `127.x` / `localhost` / `[::1]` 的请求（远程监听口本来就要令牌，不受影响；
  静态页、`/api/health`、`/pair`、发布快照、网关这些不经 `authOk` 的照旧）。没选「默认生成 token」：浏览器版要换成带 token 的地址，改动面大。
  真机验证（临时 HOME、无 token）：`Host: evil.example` 的 `/api/file` 403、WS 被拒；`127.0.0.1` / `localhost` 照常。单测在 `same-origin.test.ts`。

### SEC-02 可执行插件网络沙箱可经 `tty` 绕过（子代理实测）
- 位置：`server/src/plugins/runtime.ts` BOOTSTRAP 的 `BLOCK` 集合（没有 `tty`、`readline` 等）。
- 攻击：`Object.getPrototypeOf(require('tty').ReadStream.prototype).constructor` 就是 `net.Socket`，可以直接 TCP 外连；Node 24 + `--permission`（无 `--allow-net`）下实测连接确实发出。原生网络拦截只在 Node 25+ 才有（runtime.ts 里 `--allow-net` 那段），Electron 内置 Node 版本待核实。
- 影响：插件绕过 `permissions.network` 白名单外传拿到的 secret；配合 SEC-01 / WS 无 Origin 放行，可连本机 3090 完全逃逸。
- 修法：短期补 `tty`、`readline` 以及其它能间接拿到 net 构造器的内置模块，并加测试（用 tty 路径外连必须失败）；长期改 OS 层隔离（macOS sandbox-exec / Linux 命名空间 / Windows AppContainer）或升级到原生 `--allow-net`。
- **已修（2026-11-01）**：没去补 BLOCK 名单（总会漏），改成从源头堵：bootstrap 先自己加载 net / dgram，把 `Socket.prototype.connect`、
  `Server.prototype.listen`、`dgram.Socket` 的 bind / connect / send 换成抛错并锁死，tty / stdin / 以后再发现的路子拿到的都是死的 Socket。
  测试先复现（插件经 tty 原型连测试里的 TCP 服务器，连上了），修后被拒且服务器零连接。Electron 44 内置 Node 24.19，也没有 `--allow-net`。
  还没做：OS 层隔离（长期）；已打开的 fd 用 `new Socket({fd})` 包装不受影响，但子进程只继承 stdio 和 IPC 管道。

### SEC-03 手机壳托管服务器是最高信任根
- 位置：`server/src/remote/anywhere/service.ts` 的 `DEFAULT_SHELL_URL`；`web/src/shell/sw.ts` + `integrity.ts`（只核对缓存里的壳文件，网络回答不核对）；部署 `scripts/deploy-shell-vps.sh`、`deploy/shell-site/`。
- 攻击：控制壳 origin 的任何人（VPS root、Cloudflare DNS 账号、`claude-web-shell` GitHub 组织成员、本仓库发版权限 / 构建依赖、站点仓库每天的自动发布）可以下发恶意壳 → 读 IndexedDB `cw-shell` 里所有电脑的设备令牌 → 完全控制这些电脑。端到端加密不防它，因为解密代码就来自这台服务器。
- 修法（可分几步）：
  1. 运维：VPS 只密钥登录（已是）、Cloudflare / GitHub 开 2FA、站点仓库去掉 `schedule` 自动发布改手动。
  2. 壳自校验：SW 安装后把壳文件哈希「钉住」，新版本需要经电脑签名的版本清单（电脑通过已建立的加密通道告诉手机可信的壳哈希），对不上就拒绝并提示。
  3. 文档 / 设置页说明信任关系，支持一键自托管壳。

## 中

### SEC-04 慢速转发没有前向保密
- 位置：`server/src/remote/anywhere/core/keys.ts` 的 `relayKey()`：HKDF(K, 手机随机数 ‖ 电脑随机数)，K = sha256(设备令牌)，随机数在 K 加密的 hello / ack 里。
- 攻击：长期录下公共 broker 上的密文，日后拿到设备令牌或电脑 meta.json 的 `tokenHash`，就能解开过去所有转发流量（对话、文件、终端）。直连走 DTLS（ECDHE），不受影响。
- 修法：hello / ack 各带一个 ECDH（P-256 或 X25519，WebCrypto 都有）临时公钥，relay key = HKDF(K ‖ ECDH 共享密钥, 随机数, 'relay')。这是跨版本协议（手机壳和电脑版本不同），要加协议版本字段、老端退回旧派生。

### SEC-05 配对链接泄露 = 10 分钟内完全控制
- 位置：`service.ts` 的 `pairUrl()` / `pairLink()`；设置页「复制配对链接」。`remote/service.ts` 配对码 10 分钟、5 次。
- 攻击：链接经 IM 发送、截图、剪贴板同步泄露，拿到的人在有效期内先配对，得到完全权限的设备令牌。
- 修法：配对成功后电脑端弹确认（显示设备名 / UA / IP，用户点「允许」才发令牌）；或缩短复制链接的有效期；新设备配对后在电脑上醒目通知并可一键吊销。

### SEC-06 局域网直连明文 HTTP、0.0.0.0、token 位置
- 位置：`server/src/remote/service.ts` 监听 `0.0.0.0`；`index.ts` 设 `cw_token` cookie（无 HttpOnly / Secure）、接受 `?token=`。
- 攻击：同一 Wi-Fi 嗅探设备 token → 完全控制（还能 `remote.pairCode` 生成新码、`env.reveal` 看环境变量明文、吊销别的设备）。
- 修法：远程监听口加 TLS（自签证书 + 二维码里带指纹钉住）；cookie 加 HttpOnly；token 不进 URL（WS 首帧鉴权或子协议头）；设置页写明「配对 = 完全控制」，推荐「在外面也能连」/ SSH 隧道。考虑给设备分权限（禁止已配对设备生成配对码、查看密钥）。
- **部分修（2026-11-01）**：
  - `/api/pair` 的 cookie 改 `HttpOnly; SameSite=Strict`；`/pair` 页面不再把令牌写进 localStorage（还会删掉旧的），手机只靠 cookie，令牌不再进 WS / `/api/file` 的 URL。之前配对的手机 localStorage 里还有令牌，重新配对一次就干净了。
  - 配对的设备（局域网连接、联邦对端）一律不能做：`remote.set / pairCode / devices.revoke / devices.rename`、`env.reveal`、`im.pairCode`、`secrets.migrate`（`remote/device-limits.ts`，hub 在路由前查）。
  - 设置页说明改成「配对 = 把电脑交给它；生成配对码 / 管理设备 / 看密钥只能在这台电脑上做；不在一个网络用 SSH 隧道」。
  - 没做：局域网 TLS（手机浏览器对自签证书只能弹警告，钉指纹要自带壳）。同一 Wi-Fi 能嗅探的人仍能拿到 cookie 里的令牌——别在公共网络上开。

### SEC-07 联邦「来自对端」限制由客户端自报
- 位置：`server/src/federation/service.ts` 的 `fromPeer = via.length>0 || ctx.peerConn`；`ws/hub.ts` 从 `?peer=` 取 `peerConn`；`federation/rewrite.ts` 的 `refusedFromPeer`。
- 攻击：对端拿的是普通设备 token，连接时不带 `?peer=`、请求不带 `via`，就能 `peers.*`、WSL / SSH、`vcs.tokens.*`。
- 修法：在服务端按 token 记录「这是联邦对端」（配对时打标），由 token 决定，不信客户端参数；文档写明信任模型。
- **已修（2026-11-01）**：设备记录加 `kind: 'peer'`。联邦 `peers.add` 兑换配对码时带 `kind: 'peer'`；以前配的对端第一次带 `?peer=` 连上来也会被永久标成 peer（只能变严，不能变回）。
  hub 判 peer 连接 = `?peer=` 或令牌是 peer，所以对端换个不带 `?peer=` 的连接也逃不出 `refusedFromPeer`。e2e 15 全过（39/39）。
  剩下：SSH 方式的对端用的是对方的主令牌，主令牌本来就是完全控制，这条规则管不到它。设置页设备列表给 peer 标「电脑」。

### SEC-08 插件市场签名非强制、公钥未内置
- 位置：`server/src/plugins/market-service.ts`（条目有签名才验）、`market.ts`（没配公钥时收未签名目录）、按 URL 直接安装不要求哈希。声明式远程目录用内置 `CATALOG_PUBLIC_KEYS`（目前空，等于关着）。
- 修法：内置官方公钥；官方目录强制签名；第三方 / 按 URL 安装醒目标「未验证」，二次确认。
- **已修（2026-11-01）**：配了公钥的目录，每个条目必须有签名或 sha256（受目录签名保护），签名错的直接拒；其它一律 `verified: false`（无公钥目录 / 按 URL / 本地文件），
  `plugins.install` 不带 `acknowledgeUnverified: true` 就拒（服务端拦，不只是界面）。新 `plugins.install.check` 先下载算 sha256 给对话框看，确认后带着这个 sha256 安装，服务端核对是同一份。
  插件页加了「已验证 / 未验证」标和「从地址安装」。没有内置公钥：这个 fork 没有官方目录。细节在「插件 / 同步 / 远程共享」笔记。界面没在真 app 里点过。

### SEC-09 托管程序下载的校验值与二进制同源
- 位置：`server/src/engines/manager.ts` 下载段（GitHub asset digest / 同 release 的 checksums；`allowUnverified` 且无 `sha256` 时任何哈希都装）。
- 修法：在签名的来源目录 / `bundled.json` 里固定每个版本的 sha256；无固定哈希的版本必须用户确认并显示哈希；`allowUnverified` 只在显式设置里开。
- **已修（2026-11-01）**：`bundled.json` 里每个平台的 sha256 当作固定值（`engines/manifests/pins.ts`，另可加 `pins` 块）。固定版本：哈希不对就丢，发布里没有那个文件就停；
  没固定的版本（同 release 的 digest / checksums 只拿来比对、显示「和发布附带的一致」）一律要用户在面板里确认具体哈希，`allowUnverified` 必须和下载文件的 sha256 一起来才算数。
  以前自动记成 `release` 的版本重装时会再问一次。细节在「免费来源与托管程序」笔记。确认对话框没在真 app 里点过。

### SEC-10 API key 明文出现在子进程命令行；Linux 只 base64
- 位置：`server/src/secrets/service.ts`：macOS `security add-generic-password ... -w <明文>`；Windows DPAPI 把 base64 明文放在 `-Command`；Linux scheme `plain`。
- 攻击：同机其它用户 / 进程在执行瞬间 `ps` 看到明文。
- 修法：macOS 不再把值放进 argv（`-w` 不带值时 `security` 从终端交互读，子进程里不好用；可用 `security -i` 交互模式经 stdin 喂命令，或 keytar 类原生绑定，先实测）；Windows 把明文经 stdin 传给 PowerShell；Linux 用 libsecret（`secret-tool store` 从 stdin 读），没有就明确告诉用户是明文存储。
- **已修（2026-11-01）**：密钥只走 stdin。macOS `security -i` + `add-generic-password -X <hex>`（行长 4095 上限，长值拆成 `#0..n` 几项，`enc:keychain-parts:`），读用 `-g` 解析；
  Windows PowerShell 从 `[Console]::In` 读；Linux 有 `secret-tool` 就用 libsecret（`enc:libsecret:`），没有或存失败就是 `plain`，设置页「方式」会显示出来。旧格式照常能读。
  macOS 实测（临时钥匙串项、含引号 / 换行 / 中文 / 9 KB，`ps` 轮询 400 次没见到值）；Windows / Linux 只有单测（Windows 待确认 `-Command` 下 `[Console]::In` 读得到 stdin）。

### SEC-11 本机任意 localhost 页面可连 `/ws`（无 token 模式）
- 位置：`index.ts` `originOk` 的正则放行 `http://localhost:任意端口`、`127.0.0.1:任意端口`。
- 攻击：本机其它开发服务器的页面（被投毒的依赖、Jupyter）直连 3090。
- 修法：随 SEC-01 一起：Origin 只认本服务自己的端口（和 dev 时的 vite 端口）。
- **已修（2026-11-01）**：WS 升级改用 `wsOriginOk`：没有 Origin（Node 客户端、联邦对端）放行，有就必须和 Host 同 host:port。
  dev 时 vite 代理不改 Host（没设 `changeOrigin`），页面 `127.0.0.1:5173` 连过来 Host 也是 `:5173`，照样同源。

## 低（记录 / 顺手修）

- **SEC-12 元数据泄露**：每台设备频道名固定，公共 broker / VPS 看得到 IP、在线时间、流量大小。可选：频道名按天轮换（HKDF info 加日期）。
- **SEC-13 公开 TURN 口令 / 匿名 mosquitto**：口令在 `core/lists.ts` 的 `DEFAULT_TURN`，按设计公开；靠 coturn 限额和 `denied-peer-ip`。mosquitto 匿名可被刷满连接。可选：TURN 改短期 HMAC 凭据（`use-auth-secret`，电脑经加密信道下发）；mosquitto 按 IP 限连接数。
- **SEC-14 一台手机配多台电脑互不隔离**：同源 iframe 共享 IndexedDB。已写进 README / spec §8；长期可按电脑分子域或分 origin。任何 UI XSS 在手机上会升级成「偷所有电脑令牌」——保持 Mermaid `securityLevel: 'strict'`、不渲染原始 HTML。
- **SEC-15 IM `/pair` 无失败上限**：`server/src/im/router.ts`。照远程配对加 `MAX_TRIES`，用完作废。
- **SEC-16 完全放开模式下的操控电脑授权**：`server/src/computer/access.ts` 完全放开不弹卡，离开模式后授权仍在。修法：离开该模式时清掉期间自动给的授权。
- **SEC-17 深链接 `q=`**：`deep-link.ts` 只预填不发送；可在预填时显示「这段文字来自外部链接」提示。
- **SEC-18 `setAuthTag` 不校验长度**：`server/src/sync/crypto.ts`，加 `authTagLength: 16` / 显式检查 16 字节。
- **SEC-19 主 token 非定长比较**：`index.ts` `presented === token`，改 `timingSafeEqual`。
- **SEC-20 浏览器模式 url-guard**：`server/src/web/url-guard.ts` 不拦回环和本应用端口，agent 在浏览器里可访问本机服务。和 SEC-01 一起看。

## 核对过、没问题的

- 牵线信封：AES-256-GCM，AAD = 频道名，5 分钟时间窗 + 随机数 LRU 防重放（`core/envelope.ts`）。
- 转发 IV = 方向 ‖ 序号，同 key 每方向只开一次，不会重用（`core/relay-link.ts`）。
- 直连 DTLS 指纹在加密的 offer / answer 里，broker 无法中间人。
- bridge 只连远程监听口、不连 3090；配对通道只放 `POST /api/pair`；设备通道只认本设备令牌（`bridge.ts`）。
- 配对码：`randomInt` 6 位、10 分钟、5 次；设备令牌 32 字节随机、只存 sha256。
- gateway / share：回环 / 私网限制、CORS 白名单、密钥加盐 + `timingSafeEqual`。
- Electron：`contextIsolation`、无 `nodeIntegration`、webview 去 preload、IPC `fromOurWindow`、`openExternal` 协议白名单、`file:` guard。
- 操控电脑：PowerShell 走 stdin JSON，`Start-Process` 目标来自内置表 / `Get-StartApps`，无注入点。
- 主题 Worker：独立 CSP `default-src 'none'` + lockdown；`frameHtml` 转义、颜色白名单。
- 同步加密：scrypt N=2^15、AES-GCM 随机 IV、AAD、外来 KDF 参数有上限。

## 派发建议

「在外面也能用」2026-10-31 整块删除（SEC-03 / 04 / 05 / 12 / 13 / 14 随之解决；VPS 和手机壳站点是上游的，本 fork 不用管），下面这些条目留作记录。
剩下的顺序：SEC-01（+11、19、20 同一处，小改动）→ SEC-02 → SEC-10 → SEC-06 → SEC-07 → 其余。
每个任务的完成标准：修复 + 回归测试（能复现攻击的用例必须失败）+ `npm run typecheck && npm test`，涉及界面文字的跑 i18n 检查。
