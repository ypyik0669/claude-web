# 手机在外面也能连（2026-10-01，已删除 2026-10-31）

**2026-10-31 整块删掉了**（本仓库是 fork，用户决定：安全风险大、用不上）。原因见「安全审计」笔记的 SEC-03 / 04 / 05 / 12 / 13 / 14：
手机壳托管服务器是能偷走所有设备令牌的信任根，慢速转发没有前向保密，配对链接泄露即被控制，公共 broker 和上游的 VPS 能看到元数据。

删掉的东西（要找旧代码看删除前的提交 `f069c7a` 或之前）：
- `server/src/remote/anywhere/`（MQTT 牵线、WebRTC 直连、慢速转发、bridge）、`web/src/shell/`（手机壳，`web/vite.shell.config.ts`、`web/shell.html`）、`web/src/ws/tunnel.ts`（iframe 里换成通道的 WebSocket）。
- 设置页的「在外面也能用」开关、二维码的「在哪都能用 / 只在局域网」切换、「复制配对链接」、更多选项里的 broker / STUN / 手机页面地址 / 最近连接（`AnywhereMore.tsx`、`anywhere.ts`）。
- `node-datachannel` 依赖和 `electron-builder.yml` 的 asarUnpack、`smoke-packaged` 的 WebRTC 检查；`scripts/shell-smoke.cjs`、`server/ws-phase21.mjs`、`scripts/deploy-shell-vps.sh`、`deploy/shell-site/`、`.github/workflows/pages.yml`；i18n 的 `EN_SHELL` 区；`vite.config.ts` 的首屏入口大小闸（只为转发存在）。
- 协议：`RemoteStatus.anywhere`、`RemotePairCode.anywhereUrl`、`remote.set` 的 `anywhere`、`LinkKind`、`AnywhereStatus`；`RemoteService` 的 `pairUrlHook` / `currentPair` 和 `paired` / `pairEnded` / `revoked` 事件。

留下的：
- 局域网远程监听口、配对、设备令牌、SSH 隧道、联邦（「其它电脑」）都不变。
- 「不让电脑睡眠」（`remote.keepAwake`）留在「手机与其它电脑」页，现在由 `RemoteStatus.keepAwake` 带出。
- meta.json 里老的 `remote.anywhere*` 设置不再有人读，留着无害。
- 脚本里的 `CW_NO_PUBLIC_BROKERS=1` 已经没有作用，留着无害。

外面的服务器：
- VPS `cw.y0p66y9.me`（Caddy 上的手机壳、mosquitto、coturn）和 GitHub 组织 `claude-web-shell` 的站点是上游的，不归本 fork 管，
  这边不用处理；代码里已经没有对它们的引用，不会再连过去。
- 已经配对过「在哪都能用」的手机，在电脑升级后就连不上了（通道没人应答），要的话改用局域网配对。
