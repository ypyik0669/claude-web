# 同步 / 出网守卫（2026-10-26，spec 统一模型来源 §8）

历史：这篇原来还写了插件（`server/src/plugins/`：来源定义 JSON、可执行插件的子进程隔离与权限批准、`net.Socket` 侧门（SEC-02）、市场与一键安装、未验证包要明确同意（SEC-08）、签名远程目录）、远程共享（`server/src/share/`：`share` 密钥组、只收窄的规则、日 / 周 / 月额度、LAN 监听）和 OTLP 导出（`server/src/telemetry/`）。2026-11-01 随模型网关一族全删了（见「只留 Claude」）；代码在那之前的提交里。还留着的：插件的解包层挪成 `privacy/model/archive.ts`（隐私模型下载的 tar.gz 解压，同样拒绝绝对路径、`..`、盘符、设备名、链接，限制条目数和大小）。

## 同步（`server/src/sync/`）

- `backup.ts`：文件格式 `claude-web-sync` v1。明文部分：供应商（去掉 apiKey 和本机学到的 / 缓存的字段：models、modelNames、modelEfforts、modelContext、modelsAt、modelsError）、设置里的 `models.*`。任何设置值里像绝对路径的（`C:\`、`\\`、`~/`、`/home/…`）都去掉（`stripPaths`）。导入时 `isPublicSetting` / `isPrivateSetting` 再查一遍：伪造的文件设不了 `ui.*`、`network.proxy`、`remote.*`。（历史：以前还带账号引用、网关组、密钥组、`routing.*`。）
- 加密部分（`crypto.ts`）：口令 → scrypt（N=2^15, r=8, p=1）→ AES-256-GCM，带 AAD；口令至少 8 个字。里面是供应商 key、`privacy.*` 设置（spec：凭据与隐私配置用独立口令）。没口令就只导出明文部分。导入时 scrypt 参数有上限，伪造的文件吃不掉内存。
- `merge.ts`：逐项。设置按 key 合并，本机独有的保留；供应商的**凭据两边不同 = 冲突，两份都留**，传入的另存为「名字（同步）」（新 id 加后缀），绝不覆盖；文件把同一个供应商指到别的地址时本机的密钥不跟过去。本机没有 key 而文件有 → 补上。
- WS（`sync/types.ts`）：`sync.export { passphrase? }` → `{ filename, text }`（浏览器用 Blob 下载）；`sync.import { text, passphrase? }` → 预览（token，10 分钟，解密后的东西只在内存）；`sync.apply { token, skip }`；`sync.cancel`。界面 `web/src/features/sync/SyncPanel.tsx`，挂在图标栏「用量与隐私」→ 备份（`model-hub/pages/SettingsPage.tsx`）。
- 远程同步（2026-10-28，P9）：`remote.ts` + `backends/{webdav,s3,github}.ts` 把同一份 backup 放到 WebDAV / S3（SigV4）/ GitHub（contents API）。地址只收 http(s)、凭据全走 `SecretService`（状态只回圆点，保存时圆点表示保留、空串表示删除）；WebDAV 用 LOCK / If / ETag，S3 用条件请求，GitHub 用 blob sha；推送前拿锁、失败也解锁，拉取只产生 `SyncPreview`，确认后走同一个 `sync.apply` 合并。设置存 `settings['sync.remote']`，界面是同一页「备份与同步」里的 `RemoteSyncPanel`。错误按 HTTP 401/403/404/409/412/429 分开说原因。测试 `remote.test.ts` / `backends.test.ts` 全部注入 fetch，不碰真网络。

## 出网守卫（2026-10-28，从 Magpie 移植）

- `server/src/net/netguard.ts`（`guardedFetch({policy})`）：用户填的地址在请求前查每个 DNS 答案；直连时在连接那一刻再查一次（防 DNS rebinding），每次重定向都重查。三档：`public` 只公网（隐私模型下载）、`lan` 也许局域网、`local` 再加本机（WebDAV / S3 / GitHub 同步）。云元数据（169.254.169.254）和 link-local 一律拒，IPv6 里藏的也拒。走代理时只做第一次检查（名字由代理解析，`proxy.proxiedFor()`）。
