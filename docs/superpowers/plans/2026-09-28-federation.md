# 跨机器会话（联邦）实现计划

spec：`docs/superpowers/specs/2026-09-28-cross-machine-design.md` · 分支 `feat/federation` · 端到端 `server/ws-phase15.mjs`

## 任务

1. **id 编解码 + 协议类型**（`server/src/federation/types.ts`，protocol.ts `export *`）
   - `peerSessionId(peerId, remoteId)` → `peer_<peerId>~<remoteId>`；`parsePeerId(id)` → `{peerId, remoteId} | null`；`isPeerId()`。
   - `PeerInfo`（wire 形状，token 不出 wire）、`PeerState`、`SessionSummary.peer?: {id, name, offline?}`。
   - 请求 `peers.list / peers.add / peers.update / peers.remove / peers.handover`，事件 `peers.changed`；`RequestEnvelope.via?: string[]`；`hello` 带 `serverId / name`。
   - 测试：`types.test.ts`（往返、`~` 出现在远端 id 里、非法 peerId、多层前缀）。
2. **改写纯函数**（`server/src/federation/rewrite.ts`）
   - `FORWARD` 路由表：哪些请求可转发、哪些在本机处理（草稿 / 评分 / 置顶 meta）、其余拒绝。
   - `outbound(req, peerId)`：去前缀（sessionId / params.sessionId / sessionIds / requestId）。
   - `inbound(kind, data, peer)`：响应加前缀（session.open / info / fork / archive / delete / list / search）。
   - `rewriteEvent(event, peer)`：session.event/state/info、permission.request/resolved 加前缀；sessions.changed / library.changed 变成失效信号；其它事件丢弃；**已带 `peer_` 的事件丢弃**（不做多跳，也防两台互为 peer 时的事件回声）。
   - 测试：`rewrite.test.ts`。
3. **PeerClient**（`server/src/federation/peer-client.ts`）
   - `ws` 客户端连 `<url>/ws?token=&peer=<serverId>`；请求 / 应答按 id；30s 心跳（ping/pong 测延迟，10s 无 pong 断开）；断线指数退避 1s→30s；`hello` 里的 serverId 与本机相同 → 拒绝（把自己加成了 peer）。
   - 连接失败时用现有接口判断原因：`/api/health` 通 + `GET /api/file?token=` 返回 403 → `unauthorized`（令牌失效，停止重连）；否则 `offline`。
   - 测试：`peer-client.test.ts` 用本地 `ws` 假服务器（hello、应答、断线重连、403 判定）。
4. **FederationService**（`server/src/federation/service.ts`）
   - `meta.peers` + `meta.serverId`（MetaStore 追加字段），token 经 `SecretService.protect` 存 `enc:`；wire 上不带 token。
   - `add({url, code, name})`：代为 `POST <url>/api/pair` 拿设备令牌；`add({hostId})`：`TunnelManager.open(host)` 后用主机配置的 token 连 `http://127.0.0.1:<local>`，重连时重开隧道。
   - `route(req, {via, local})`：防环（via 含自己 → 拒绝）、多跳拒绝、按路由表转发 / 分拆批量（archive / delete 本机 + 各 peer）/ 合并 `sessions.list`（每 peer 5s 超时、30s 缓存、`sessions.changed` 失效、离线用上次缓存并置 `offline`）和 `sessions.search`。
   - `handover(sessionId, agent, model, cwd)`：通过 peer 读完整 transcript，走 `swapAgent` 的 imported 分支（= `handOverImported`，新本机会话 + 简报）。
   - 事件：peer 事件改写后 `emit('event')`，hub 只发给非 peer 客户端。
   - 测试：`service.test.ts`（假 PeerClient：路由、合并、离线缓存、防环、批量分拆、handover）。
5. **hub 接线（最小改动）**：Services 加 `federation?`；`broadcast(e, fromPeer)` 跳过 peer 连接；`onConnect(ws, req)` 标记 `?peer=` 连接、hello 带 serverId；消息处理前 `federation.route(...)`；`peers.*` 一行分发到 `federation/handlers.ts`。
6. **web**
   - `@/util`：`isImportedSessionId / nativeSessionId` 先剥 peer 前缀。
   - 侧栏：机器筛选（本机 / 各机器，`filter.ts` 加 `machine` 维度 + `machineCounts`），行上机器徽章，离线置灰；远端会话按机器分组。
   - `caps.ts`：离线 peer 全部只读；会话菜单「交给本机 agent 继续」（选 agent + 目录）。
   - ChatTile：远端会话只留 对话 / 产物 标签，其它显示「在该机器上查看」。
   - Mission Control：「其它机器上运行中」一栏（未在本窗口打开的远端 live 会话）。
   - 设置 → 远程 / 手机 → 「其它机器」：列表（名称 / 地址 / 状态 / 延迟 / 会话数）、添加（地址 + 配对码 或 SSH 主机）、改名、停用、移除、重新配对。
7. **端到端** `server/ws-phase15.mjs`：自己起 B（临时 HOME / CLAUDE_WEB_DIR / PORT=0 / 空闲远程端口），B 用 mock ACP 造会话；A 配对加入 B；断言列表 / 打开 + 发送收事件 / 权限往返 / B 下线后离线且本机列表正常。加入 `scripts/e2e.mjs`。
8. CLAUDE.md / README 小节、截图、自审、提交、报告。

## 裁决

| 裁决 | 理由 | 代价 |
| --- | --- | --- |
| 权限 `requestId` 也加 `peer_<id>~` 前缀 | `permission.resolved` / `permission.respond` 只有 requestId，没有 sessionId，不加前缀无法路由、也可能与本机撞号 | 前端看到的 requestId 变长，无影响 |
| peer 连接用 URL 参数 `peer=<serverId>` 自报身份，hub 不把「从 peer 来的事件」再发给 peer 连接 | 两台互为 peer 时 `sessions.changed` 会在两边无限回弹 | 依赖对端也是本版本；老版本对端会忽略这个参数（仍然安全，因为我们丢弃带 `peer_` 前缀的事件） |
| 令牌失效判定用现有 `/api/file?token=`（403 = 令牌无效、400 = 令牌有效） | spec 要求不新增接口；upgrade 失败时服务端直接 destroy socket，拿不到状态码 | 依赖 `/api/file` 先鉴权再校验参数的顺序（ws-phase15 覆盖） |
| 已连接期间被吊销的设备不会被远端踢掉（`RemoteService.revoke` 不关已有 socket），下次重连时才显示「令牌失效」 | 不改远端的吊销语义（阶段 6 的行为） | 吊销到生效之间有延迟（直到断线） |
| SSH 方式的 peer 不另存 token，连接时读 `remoteHosts` 里该主机的 token | spec 原话「用主机配置里的 token」；主机配置改了 token 立即生效 | 主机被删后该 peer 无法连接（状态显示错误） |
| `session.switchAgent` 对远端 id 直接拒绝，交接走 `peers.handover {sessionId, agent, model, cwd}` | 交接需要本机 cwd（远端路径在本机多半不存在），原请求没有这个参数 | 多一个请求类型 |
| `sessions.list` 带 `limit` 时先合并再截断 | 本机与远端混排按时间排序 | 每个 peer 仍返回完整列表（缓存 30s） |
| 远端会话在侧栏按机器分组（不参与本机工作区分组） | 远端 cwd 与本机工作区不可比 | — |
| 草稿 / 评分 / 置顶等 meta 对远端 id 在本机存（不转发） | 这些本就是本机 UI 状态 | 另一台机器看不到这台的置顶 |
| 转发请求超时 60s（`session.open` 120s） | 远端 open 会起进程 | — |
