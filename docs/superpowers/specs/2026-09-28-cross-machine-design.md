# 跨机器会话 设计（子项目 3）

日期：2026-09-28 · 状态：用户授权一次性实施

## 目标

多台机器上各跑一个 claude-web，在任意一台的侧栏里看到所有机器的会话（标明机器），直接打开、续聊、审批权限、中断；也能把远程会话「交给本机某个 agent 接着干」。

## 基础（已有）

阶段 6 的 `RemoteService`（`0.0.0.0:<remote.port>` 第二监听器，必须带令牌）、6 位配对码换设备令牌（`POST /api/pair`）、SSH 隧道（`remote/tunnel.ts`，`meta.remoteHosts`）。

## 设计

- **联邦是服务端做的**（不是浏览器直连多个服务器）：新目录 `server/src/federation/`。每个已连接的远端 = 一个 `PeerClient`：到远端 `/ws` 的 WebSocket 客户端（令牌放 `?token=`），断线指数退避重连（1s→30s），心跳 30s。
- **加入一台机器**两种方式：
  1. 局域网 / 任意可达地址：填 `http://<ip>:3091` + 远端「设置 → 远程 / 手机」显示的 6 位配对码 → 本机 server 代为 `POST /api/pair` 拿设备令牌。
  2. SSH：复用 `meta.remoteHosts` + 隧道，隧道 `up` 后用主机配置里的 token 连 `http://127.0.0.1:<local>`。
  存 `meta.peers: { id, name, url, via: 'direct'|'ssh', hostId?, token(enc: 经 SecretService), enabled, addedAt }`；wire 上 token 打码。
- **会话 id**：远端会话在本机显示为 `peer_<peerId>~<远端 id>`（`~` 分隔，无冒号，peerId 只含 `[a-z0-9]`）。前缀解析 `parsePeerId()` 放在 `protocol.ts`（web 共用）。
- **代理**：hub 在处理请求前检查 sessionId：是 `peer_` 前缀就把请求（去掉前缀）转发给对应 PeerClient 并把响应原样返回；可转发的请求：`session.open/send/interrupt/close/setModel/setPermissionMode`、`permission.respond`、`transcript.load`、`session.fork`、`library.rename/archive/delete`、`sessions.search`（合并）。远端推来的 `session.event/state/info`、`permission.request/resolved`、`sessions.changed` 把 id 加上前缀后在本机广播。其它请求（fs / git / terminal 等）**不转发**——远端的文件在远端，本期不做远程文件浏览（界面对远端会话隐藏 工作台里的 文件/Git/搜索 标签，显示「在该机器上查看」）。
- **列表合并**：`sessions.list` = 本机库 + 每个在线 peer 的 `sessions.list`（缓存 30s，`sessions.changed` 时失效）；每条 `SessionSummary` 加 `peer?: {id, name}`。peer 离线时显示上次缓存并置灰（只读），不阻塞本机列表（每个 peer 5s 超时）。
- **防环**：转发的请求带 `via: [serverId...]`，自己已在链上就拒绝；每个 server 启动时生成并持久化 `serverId`（meta）。不做多跳：远端返回的会话里已经带 `peer` 的（它自己的 peer）不再合并。
- **交接到本机**：会话菜单「交给本机 agent 继续」= 通过 peer 读完整 transcript → `handOverImported` 同一路径（新本机会话 + 简报），cwd 用本机默认工作区（远端路径在本机大多不存在，让用户确认 / 选目录）。
- **安全**：只用设备令牌；本机不向远端暴露任何新接口（联邦是出站连接）；远端吊销设备后本机显示「令牌失效，请重新配对」。

## 界面

- 设置 → 远程 / 手机 下新增「其它机器」：列表（名称、地址、状态 在线/离线/令牌失效、延迟、会话数）、添加（地址+配对码 或 选 SSH 主机）、改名、停用、移除。
- 侧栏：来源筛选里增加机器维度（「本机 / <机器名>」），每行远端会话带机器徽章；Mission Control 显示远端运行中的会话。

## 测试

- 单元：id 编解码、请求转发路由表、事件改写、离线缓存、防环。
- 端到端 `server/ws-phase15.mjs`：同一台机器起**两个** server（不同临时 HOME / 端口，B 开远程监听），A 用配对码加入 B，断言 A 的列表里出现 B 的会话（B 上用 mock ACP 造一个）、A 打开并发送一轮能收到事件、权限请求往返、B 下线后 A 显示离线且本机列表不受影响。加入 `scripts/e2e.mjs` 默认列表。
