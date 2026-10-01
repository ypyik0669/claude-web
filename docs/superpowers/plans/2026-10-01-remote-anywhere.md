# 手机在外面也能连电脑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机不在家里 Wi-Fi 时也能用完整界面：经公共 MQTT 牵线，WebRTC 直连，打不通时经公共 MQTT 加密慢速转发；电脑端把通道桥接到现有远程访问入口（3091）。

**Architecture:** 传输无关的核心（密钥派生 / 信封 / 帧 / MQTT 客户端 / 牵线 / 两种 Link）放在 `server/src/remote/anywhere/core/`，只用 Web 标准 API，server 直接 import、web 经 `@anywhere` 别名 import。电脑端 `AnywhereService` 接受连接，把帧桥接到 `127.0.0.1:<远程端口>`；手机端是 GitHub Pages 上的壳（`web/src/shell/`），界面在同源 iframe 里、文件经通道取自电脑，Service Worker 把 `app/` 下的请求转给通道。

**Tech Stack:** TypeScript、node-datachannel 0.33.x（含 `node-datachannel/polyfill` 的 W3C `RTCPeerConnection`）、Web Crypto（HKDF / AES-GCM）、MQTT 3.1.1 over WSS（自写最小客户端）、Vite 第二套配置、Service Worker、Electron `powerSaveBlocker`。

**Spec:** `docs/superpowers/specs/2026-10-01-remote-anywhere-design.md`

## Global Constraints

- 用户零配置：不注册、不装 App；项目不运营服务器。只用公共服务，列表可在设置「更多选项」里改。
- 只桥接到远程访问监听器（socket 带 `cwRemote`，必须有设备令牌）；**绝不**连主入口 3090。
- `core/` 不 import `node:*`，只用 `globalThis.crypto.subtle`、`WebSocket`、`TextEncoder/TextDecoder`、`Uint8Array`。
- 默认牵线 broker（顺序即优先级）：`wss://broker.emqx.io:8084/mqtt`、`wss://broker-cn.emqx.io:8084/mqtt`、`wss://test.mosquitto.org:8081/mqtt`、`wss://public.cloud.shiftr.io`（用户名 / 密码 `public` / `public`）、`wss://broker.hivemq.com:8884/mqtt`。**转发只用** mosquitto、shiftr、hivemq（`relay: true`）。
- 默认 STUN：`stun:stun.cloudflare.com:3478`、`stun:stun.hitv.com:3478`、`stun:stun.miwifi.com:3478`、`stun:stun.chat.bilibili.com:3478`、`stun:stun.l.google.com:19302`。
- 密钥：设备 `K = sha256(设备令牌)`（32 字节），配对 `K = P`（二维码里的 16 字节随机数）；HKDF-SHA256，salt 设备 `cw-anywhere-v1` / 配对 `cw-pair-v1`；info `topic` → 16 字节 → 频道 `cw1/<32 位 hex>`；info `signal` → AES-256-GCM 密钥；转发密钥 = HKDF(K, salt = 手机随机数 ‖ 电脑随机数（各 16 字节）, info `relay`)。
- 信封：base64url(iv 12 字节 ‖ 密文+tag)，AAD = 频道名 UTF-8；时间差 > 300 000 ms 丢弃；随机数见过（LRU 2048）丢弃；`from` 是自己丢弃。
- 时限：`hello` 无 `ack` 15 000 ms；ICE 20 000 ms 后改走转发；电脑每频道每分钟最多回 30 次 `hello`。
- 帧：1 字节类型 + 4 字节流 id（大端）+ 负载；分片 16 384 字节；`bufferedAmount` > 1 048 576 暂停。
- 转发限制：每条有效载荷 ≤ 12 288 字节、每秒 ≤ 20 条、窗口 32 条、1 500 ms 未确认重传；单个 HTTP 响应 ≤ 2 097 152 字节；`/api/file`、`/api/attachments` 在转发下由电脑拒绝（413，正文 `慢速转发时不能预览 / 上传文件`）。
- 设置键（meta.json `settings`）：`remote.anywhere`（缺省 = 开）、`remote.keepAwake`（缺省 = 开）、`remote.anywhere.brokers`、`remote.anywhere.stun`、`remote.anywhere.shellUrl`（缺省 `https://ypyik0669.github.io/claude-web/`）。
- 文案：默认界面不出现 MQTT / WebRTC / STUN / ICE（`wording.test.ts` 的闸）；报错走 `@errors` 的「中文说明 + 原文」。
- 二维码：`<shellUrl>#p=<base64url(JSON {v:1, ps:base64url(P), code, pc:电脑名})>`。
- 测试只用临时 HOME + `CLAUDE_WEB_DIR`；单测和 e2e 用本机 mock broker，不连公共 broker。
- 提交身份 `ypyik0669 <112962935+ypyik0669@users.noreply.github.com>`；提交前扫 `sk-` 和 0 字节文件；改带反斜杠的内容用 Edit / Write。

## Review Focus

1. 手机切网络（Wi-Fi ↔ 5G）时正在用的直连断开：界面应在几秒内自动重连（先直连、不行转发），草稿和对话都在 → Task 7 的「直连断开后重拨」测试。
2. 已吊销的手机拿旧令牌重连：牵线不回应、已建立的通道立刻断 → Task 8 的吊销测试。
3. 两个broker 同时送达同一条牵线 / 转发消息：只处理一次 → Task 5、Task 6 的去重测试。
4. 慢速转发下打开图片预览：明确提示而不是一直转圈 → Task 8（电脑 413）+ Task 12（壳把 413 正文显示成提示）。
5. 电脑版本升级后手机缓存的是旧界面：按新版本重新取首屏文件，不混用新旧文件 → Task 12 的缓存键测试。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `server/src/remote/anywhere/core/keys.ts` | HKDF 派生、`Room`、base64url |
| `server/src/remote/anywhere/core/envelope.ts` | 牵线消息加密 / 解密、防重放 |
| `server/src/remote/anywhere/core/frames.ts` | 帧编解码、分片 |
| `server/src/remote/anywhere/core/mqtt.ts` | 最小 MQTT 3.1.1 客户端 + `Brokers`（多 broker、去重、重连） |
| `server/src/remote/anywhere/core/signal.ts` | 频道收发（`SignalChannel`） |
| `server/src/remote/anywhere/core/relay-link.ts` | 转发 Link（序号、重排、重传、限速） |
| `server/src/remote/anywhere/core/p2p-link.ts` | 直连 Link + `dial()`（手机侧）/ `Acceptor`（电脑侧） |
| `server/src/remote/anywhere/core/mux.ts` | 在 Link 上跑 WebSocket 流和 HTTP 请求 |
| `server/src/remote/anywhere/core/index.ts` | 对外导出 + 默认 broker / STUN 表 |
| `server/src/remote/anywhere/__mocks__/mqtt-broker.mjs` | 测试用最小 broker（可设丢包） |
| `server/src/remote/anywhere/rtc.ts` | 惰性加载 node-datachannel polyfill |
| `server/src/remote/anywhere/service.ts` | `AnywhereService`：频道管理、桥接、状态 |
| `server/src/remote/anywhere/bridge.ts` | 帧 ⇄ 本机远程入口的 WS / HTTP |
| `web/src/shell/*` | 壳：页面、SW、设备存储、连接 UI |
| `web/vite.shell.config.ts` | 壳的构建（产物 `web/dist-shell/`） |
| `web/src/util/app-url.ts` | 相对路径助手 |
| `.github/workflows/pages.yml` | 发版时部署壳 |
| `server/ws-phase21.mjs` | 端到端 |

---

### Task 1: node-datachannel 能装、能跑、能打包

**Files:**
- Modify: `package.json`（根 dependencies）、`server/package.json`、`electron-builder.yml`（`asarUnpack` 加 `"**/node_modules/node-datachannel/**"`）、`scripts/smoke-packaged.mjs`
- Create: `server/src/remote/anywhere/rtc.ts`、`server/src/remote/anywhere/rtc.test.ts`

**Interfaces:**
- Produces: `loadRtc(): Promise<{ RTCPeerConnection: typeof globalThis.RTCPeerConnection } | { error: string }>`（第一次调用时 `import('node-datachannel/polyfill')`，结果缓存；失败返回 `{error}` 不抛）

- [ ] **Step 1: 装依赖**：`npm i node-datachannel@^0.33.4 -w server` 并在根 package.json dependencies 加同一行（electron-builder 只打根依赖）。
- [ ] **Step 2: 写失败的测试** `rtc.test.ts`：
  - `loadRtc()` 返回带 `RTCPeerConnection` 的对象；
  - 两个 `RTCPeerConnection({iceServers: []})` 在本机互换 offer / answer / 候选，`createDataChannel('t')` 在 10 000 ms 内 `open`，发 `'ping'` 对面收到 `'ping'`；两边 `close()` 后进程能退出（测试结束不挂）。
- [ ] **Step 3: 运行** `npm test -w server -- rtc` → 失败（模块不存在）。
- [ ] **Step 4: 实现 `loadRtc()`**。
- [ ] **Step 5: 运行通过**。
- [ ] **Step 6: 打包验证**：`smoke-packaged.mjs` 增加一项——在打包产物里用 `ELECTRON_RUN_AS_NODE=1` 执行 `require(<app.asar.unpacked>/node_modules/node-datachannel)` 并创建、关闭一个 `PeerConnection`，退出码 0。运行 `npm run build:desktop` 后 `node scripts/smoke-packaged.mjs`，期望新增项通过。
- [ ] **Step 7: 提交** `feat(anywhere): node-datachannel dependency, lazy loader, packaged smoke check`

### Task 2: 密钥派生与牵线信封

**Files:**
- Create: `core/keys.ts`、`core/envelope.ts`、`core/keys.test.ts`、`core/envelope.test.ts`（目录均指 `server/src/remote/anywhere/core/`）

**Interfaces:**
- Produces:
  - `b64u(bytes: Uint8Array): string`、`unb64u(s: string): Uint8Array`
  - `interface Room { topic: string; key: CryptoKey; ikm: Uint8Array }`
  - `deviceRoom(token: string): Promise<Room>`（ikm = sha256(UTF-8 令牌)）、`deviceRoomFromHash(hashHex: string): Promise<Room>`（电脑侧：meta 里存的就是 hex 哈希）、`pairRoom(p: Uint8Array): Promise<Room>`
  - `relayKey(room: Room, phoneNonce: Uint8Array, pcNonce: Uint8Array): Promise<CryptoKey>`
  - `type Side = 'phone' | 'pc'`
  - `interface SignalMsg { v: 1; t: 'hello' | 'ack' | 'offer' | 'answer' | 'cand' | 'relay' | 'bye'; s: string; n: string; ts: number; from: Side; [k: string]: unknown }`
  - `seal(room: Room, msg: Omit<SignalMsg, 'v' | 'n' | 'ts'>): Promise<string>`
  - `class ReplayGuard { constructor(cap = 2048); seen(n: string): boolean }`
  - `openEnvelope(room: Room, raw: string, self: Side, guard: ReplayGuard, now = Date.now()): Promise<SignalMsg | null>`

- [ ] **Step 1: 失败的测试**：
  - `deviceRoom('tok')` 与 `deviceRoomFromHash(sha256hex('tok'))` 的 `topic` 相同，且匹配 `/^cw1\/[0-9a-f]{32}$/`；
  - 固定向量：`pairRoom(new Uint8Array(16))` 的 topic 等于测试里第一次跑出来后写死的值（防止以后改坏派生）；
  - `seal` → `openEnvelope` 往返得到原消息；改一个字节 → `null`；用别的 Room 打开 → `null`；`ts` 偏 300 001 ms → `null`；同一密文打开两次第二次 `null`；`from` 等于 `self` → `null`；
  - `relayKey` 两边用同样的随机数得到能互相解密的密钥，随机数不同则不能。
- [ ] **Step 2: 运行失败** `npm test -w server -- core/keys core/envelope`
- [ ] **Step 3: 实现**（HKDF 用 `crypto.subtle.deriveBits`；`seal` 自动填 `v:1`、16 字节随机 `n`（b64u）、`ts`）。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: 提交** `feat(anywhere): room derivation and sealed signaling envelope`

### Task 3: 帧

**Files:**
- Create: `core/frames.ts`、`core/frames.test.ts`

**Interfaces:**
- Produces:
  - `enum F { WS_OPEN = 1, WS_MSG = 2, WS_CLOSE = 3, HTTP_REQ = 0x10, BODY = 0x11, END = 0x12, HTTP_RES = 0x20, PING = 0x30, PONG = 0x31, ERR = 0x40 }`
  - `encodeFrame(type: F, stream: number, payload?: Uint8Array | string): Uint8Array`
  - `decodeFrame(buf: Uint8Array): { type: F; stream: number; payload: Uint8Array }`（不足 5 字节抛错）
  - `chunks(data: Uint8Array, size = 16384): Uint8Array[]`
  - `json(payload: Uint8Array): any`、`text(payload: Uint8Array): string`

- [ ] **Step 1: 失败的测试**：往返（空负载、UTF-8 中文、流 id `0xffffffff`）；`chunks` 对 40 000 字节给出 16384 / 16384 / 7232；4 字节输入抛错。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 提交** `feat(anywhere): channel frame codec`

### Task 4: MQTT 客户端与多 broker

**Files:**
- Create: `core/mqtt.ts`、`core/mqtt.test.ts`、`server/src/remote/anywhere/__mocks__/mqtt-broker.mjs`

**Interfaces:**
- Produces:
  - `interface BrokerDef { name: string; url: string; username?: string; password?: string; relay?: boolean }`
  - `class MqttClient { constructor(def: BrokerDef); connect(timeoutMs = 10000): Promise<void>; subscribe(topic: string): Promise<void>; unsubscribe(topic: string): void; publish(topic: string, payload: string | Uint8Array): boolean; close(): void; onmessage: (topic: string, payload: Uint8Array) => void; onclose: () => void }`（QoS 0；keepalive 60 s，每 30 s PINGREQ；WS 子协议 `mqtt`）
  - `class Brokers { constructor(defs: BrokerDef[], opts?: { redialMs?: number /* 15000 */ }); start(): void; stop(): void; subscribe(topic: string, cb: (payload: Uint8Array, broker: string) => void): Promise<void>; unsubscribe(topic: string): void; publish(topic: string, payload: string | Uint8Array, opts?: { relayOnly?: boolean }): number /* 发出去的 broker 数 */; status(): { name: string; ok: boolean; error?: string }[]; onchange?: () => void }`（断线后 `redialMs` 重连并重新订阅；**不在这里去重**，去重在信封 / 转发层）
  - mock：`startBroker({ port?: number, dropEvery?: number }): Promise<{ url: string; close(): Promise<void>; published: number }>`（基于 `ws`，实现 CONNECT / SUBSCRIBE / UNSUBSCRIBE / PUBLISH QoS0 / PINGREQ，`dropEvery: n` = 每 n 条转发丢 1 条）

- [ ] **Step 1: 失败的测试**（对 mock broker）：
  - 连接、订阅、自发自收，负载字节不变（含 70 000 字节，跨多个 WS 帧，剩余长度 3 字节编码）；
  - 一个 WS 帧里粘着两个 PUBLISH 时两条都收到；
  - `Brokers` 两个 mock broker：`publish` 返回 2；关掉其中一个 broker 后 `status()` 那个变 `ok:false`，用新端口重启同 url 不变的 broker（mock 支持 `port` 复用）后 `redialMs: 200` 内重连且旧订阅照收；
  - `relayOnly: true` 只发到 `relay: true` 的 broker。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**（客户端照 `scratchpad/p2p-probe/mqtt-lite.js` 的解析器写 TS 版）
- [ ] **Step 5: 提交** `feat(anywhere): minimal MQTT client, multi-broker pool and test broker`

### Task 5: 牵线频道

**Files:**
- Create: `core/signal.ts`、`core/signal.test.ts`

**Interfaces:**
- Consumes: Task 2 `Room / seal / openEnvelope / ReplayGuard / SignalMsg / Side`，Task 4 `Brokers`
- Produces: `class SignalChannel { constructor(brokers: Brokers, room: Room, self: Side); open(): Promise<void>; send(msg: Omit<SignalMsg, 'v'|'n'|'ts'|'from'>): Promise<void>; on(cb: (m: SignalMsg) => void): () => void; close(): void }`（`send` 发到全部 broker；收到后 `openEnvelope` 过滤，同一条经两个 broker 到达只回调一次）

- [ ] **Step 1: 失败的测试**：两个 mock broker、手机侧和电脑侧各一个 `SignalChannel`（同一 Room，`self` 不同）：电脑 `send({t:'ack', s:'x'})` → 手机回调恰好 1 次；自己发的不回调自己；另一个 Room 的频道收不到；原样重放 broker 上截到的密文 → 不回调。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 提交** `feat(anywhere): sealed signaling channel over the broker pool`

### Task 6: 慢速转发 Link

**Files:**
- Create: `core/link.ts`（只放接口）、`core/relay-link.ts`、`core/relay-link.test.ts`

**Interfaces:**
- Produces:
  - `type LinkKind = 'p2p-v6' | 'p2p-v4' | 'relay'`
  - `interface Link { kind: LinkKind; send(frame: Uint8Array): void; onframe: (f: Uint8Array) => void; onclose: (why: string) => void; close(): void; buffered(): number }`
  - `openRelayLink(opts: { brokers: Brokers; room: Room; session: string; side: Side; key: CryptoKey; maxPerSec?: number /* 20 */; window?: number /* 32 */; retransmitMs?: number /* 1500 */ }): Promise<Link>`
  - 频道：`<room.topic>/r/<session>/up`（手机 → 电脑）、`/down`（电脑 → 手机）；包 = AES-GCM(iv = 方向 1 字节 ‖ 0 ‖ 0 ‖ 0 ‖ 序号 8 字节，AAD = 频道名)，明文 `[seq u32][ack u32][kind u8 (0 数据 / 1 纯确认 / 2 关闭)][数据]`；只经 `relayOnly` broker 发，每个包同时发到所有转发 broker，按 seq 去重。
  - 超过 12 288 字节的帧由 Link 自己切开、按序重组（调用方只见整帧）。

- [ ] **Step 1: 失败的测试**（mock broker）：
  - 发 200 帧（大小 1–30 000 字节随机）全部按顺序收到、内容不变；
  - `dropEvery: 5` 时同样全部按序收到；
  - 两个转发 broker 同时送达 → 每帧只回调 1 次；
  - 限速：2 秒内发出的 MQTT 包数 ≤ 41（按 mock 的 `published` 计数，含确认包）；
  - 一方 `close()` → 另一方 `onclose` 在 3 000 ms 内触发；
  - 拿错 `key` 的一方收不到任何帧。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 提交** `feat(anywhere): encrypted, ordered, rate-limited relay link over MQTT`

### Task 7: 直连 Link、`dial()` 与 `Acceptor`

**Files:**
- Create: `core/p2p-link.ts`、`core/dial.ts`、`core/accept.ts`、`core/p2p.test.ts`、`core/index.ts`

**Interfaces:**
- Consumes: Task 2、4、5、6
- Produces:
  - `type RtcCtor = typeof globalThis.RTCPeerConnection`
  - `class DialError extends Error { code: 'pc-silent' | 'no-broker' | 'unreachable' }`
  - `dial(opts: { brokers: Brokers; room: Room; stun: string[]; rtc: RtcCtor; forceRelay?: boolean; helloTimeoutMs?: number /* 15000 */; iceTimeoutMs?: number /* 20000 */; onstate?: (s: 'finding' | 'connecting' | 'relay') => void }): Promise<{ link: Link; pcName: string }>`
    - 流程：`hello{s, pn:手机随机数}` → 等 `ack{s, cn:电脑随机数, pc:电脑名}`（超时 `pc-silent`；一个 broker 都没连上 `no-broker`）→ `forceRelay` 或 ICE 超时 / failed → 发 `relay{s}` 并 `openRelayLink`；否则 `offer` / `answer` / `cand` 逐个交换，数据通道 `cw` 打开即成功。`kind` 由选中候选对的本地地址族决定（含 `:` → `p2p-v6`）。转发也失败 → `unreachable`。
  - `class Acceptor { constructor(opts: { brokers: Brokers; rtc: RtcCtor; stun: string[]; pcName: string; onLink: (link: Link, roomId: string) => void; maxHellosPerMin?: number /* 30 */ }); addRoom(id: string, room: Room): Promise<void>; removeRoom(id: string): void /* 退订并关闭这个 room 的所有 Link */; close(): void }`
  - `core/index.ts` 导出以上全部 + `DEFAULT_BROKERS: BrokerDef[]`、`DEFAULT_STUN: string[]`（值见 Global Constraints）+ Task 8 的 `Mux`。

- [ ] **Step 1: 失败的测试**（Node 里两边都用 `loadRtc()` 的 polyfill，mock broker，`stun: []`）：
  - `dial` 连上 `Acceptor`，`kind` 是 `p2p-v4` 或 `p2p-v6`，`pcName` 正确，双向发帧收到；
  - 电脑不在 → 15 000 ms（测试里传 300）后 `DialError('pc-silent')`；
  - `forceRelay: true` → `kind === 'relay'`，帧双向可达；
  - ICE 不通（测试里在 `Acceptor` 的选项里注入 `dropCandidates: true`，只给测试用，不进默认路径）→ `iceTimeoutMs` 后自动成为 `relay`；
  - `removeRoom` 后已建立的 Link `onclose` 触发，再 `dial` → `pc-silent`；
  - 一分钟内第 31 个 `hello` 不回 `ack`；
  - **直连断开后重拨**：关掉电脑侧那条 RTCPeerConnection → 手机侧 `onclose`；再次 `dial` 成功（给 Task 12 的自动重连用）。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 提交** `feat(anywhere): direct link with ICE, dial/accept and relay fallback`

### Task 8: 电脑端桥接与 `AnywhereService`

**Files:**
- Create: `core/mux.ts`、`server/src/remote/anywhere/bridge.ts`、`server/src/remote/anywhere/service.ts`、`server/src/remote/anywhere/service.test.ts`
- Modify: `server/src/remote/service.ts`（事件 `paired(deviceId)` / `revoked(deviceId)`；`newPairCode()` 多返回 `anywhereUrl`；`revoke()` 同时让 Anywhere 断开该设备）、`server/src/protocol.ts`、`server/src/ws/hub.ts`（`remote.set` 接受 `anywhere` / `keepAwake`；`remote.status` 带 `anywhere`）、`server/src/index.ts`（创建并启动服务）、`server/src/diag/service.ts`（`maskSecrets` 打码 `"tokenHash"`）

**Interfaces:**
- Consumes: Task 7 `Acceptor / Link / dial`，Task 3 帧
- Produces:
  - `class Mux { constructor(link: Link); openWs(token: string): { send(text: string): void; close(): void; onmessage: (text: string) => void; onopen: () => void; onclose: () => void }; request(req: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>; close(): void }`（手机侧用；按 `link.buffered()` 背压）
  - `serveBridge(link: Link, opts: { port: number; relay: boolean; deviceId?: string; pairing?: boolean }): () => void`（电脑侧：`WS_OPEN` → `ws://127.0.0.1:<port>/ws?token=<负载>`，不带 Origin；`HTTP_REQ` → `http.request` 到同一端口；`relay` 时 `/api/file`、`/api/attachments` 回 413 + Global Constraints 里的正文，其余响应 > 2 097 152 字节回 413；`pairing` 时只放行 `POST /api/pair`，其余 403）
  - `interface AnywhereStatus { on: boolean; brokers: { name: string; ok: boolean; error?: string }[]; sessions: { deviceId: string; kind: LinkKind; since: number }[]; recent: { at: number; deviceId?: string; ok: boolean; kind?: LinkKind; error?: string }[]; shellUrl: string; keepAwake: boolean }`；`RemoteStatus.anywhere?: AnywhereStatus`
  - `class AnywhereService extends EventEmitter { constructor(meta: MetaStore, remote: RemoteService); start(): Promise<void>; stop(): Promise<void>; status(): AnywhereStatus; refresh(): Promise<void> /* 设置变化后重读 */; pairUrl(code: string): Promise<string | null> /* 生成 P、订阅配对频道直到配对码过期，返回二维码地址 */ }`；事件 `changed`（hub 转成 `remote.changed`）
  - `recent` 最多 20 条；`sessions` 只列活着的。

- [ ] **Step 1: 失败的测试**（临时 `CLAUDE_WEB_DIR`，真起 `startServer({port:0})` 并开远程访问在随机端口，设置 `remote.anywhere.brokers` 指向 mock broker、`remote.anywhere.stun: []`；手机侧用 `dial` + `Mux`）：
  - 配对：`remote.pairCode` 返回的 `anywhereUrl` 解出 `ps` / `code`；`pairRoom` + `dial` + `Mux.request POST /api/pair` 拿到令牌；随后 `deviceRoom(令牌)` 能 `dial` 成功；
  - 经 `Mux.openWs(令牌)` 发 `{type:'request', request:{id:'1', req:{kind:'sessions.list'}}}` 收到 `reply`；
  - 错令牌的 `openWs` 立刻 `onclose`；配对频道里 `GET /` 得 403；
  - `GET /api/file?path=<临时文件>` 带 `range: bytes=2-5` 得 206 和对应 4 字节；
  - `forceRelay` 下 `GET /api/file` 得 413 且正文是 `慢速转发时不能预览 / 上传文件`，`openWs` 照常可用；
  - `remote.devices.revoke` 后已打开的 WS 流在 2 000 ms 内关闭，再 `dial` 得 `pc-silent`；
  - `maskSecrets('{"tokenHash":"abcdef1234"}')` 不含 `abcdef1234`。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 提交** `feat(anywhere): PC-side acceptor bridged to the remote-access listener`

### Task 9: 不让电脑睡眠

**Files:**
- Modify: `server/src/index.ts`（远程访问 / `remote.keepAwake` 变化时 `parentPort?.postMessage({ type: 'keepAwake', on })`，启动时发一次）、`desktop/src/server-host.ts`（`message` 里 `keepAwake` → `this.emit('keepAwake', on)`）、`desktop/src/main.ts`（`powerSaveBlocker.start('prevent-app-suspension')` / `stop`）
- Create: `desktop/src/keep-awake.ts`、`desktop/src/keep-awake.test.ts`

**Interfaces:**
- Produces: `keepAwakeWanted(s: { remoteEnabled: boolean; keepAwake: boolean | undefined }): boolean`（远程访问开 且 `keepAwake !== false`）；`class KeepAwake { constructor(api: { start(type: string): number; stop(id: number): void; isStarted(id: number): boolean }); set(on: boolean): void }`（重复 `set(true)` 只 start 一次）

- [ ] **Step 1: 失败的测试**：`keepAwakeWanted` 四种组合；`KeepAwake` 用假 api：`set(true)` ×2 → start 1 次，`set(false)` → stop 1 次。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**（`npm test -w desktop`）
- [ ] **Step 5: 提交** `feat(desktop): keep the PC awake while remote access is on`

### Task 10: 网页改成相对路径

**Files:**
- Create: `web/src/util/app-url.ts`、`web/src/util/app-url.test.ts`
- Modify: `web/vite.config.ts`（`base: './'`）、`web/index.html`（`href="manifest.webmanifest"`）、`web/src/main.tsx`（`register('sw.js')`）、`web/src/features/editor/preview.ts`、`web/src/model/attachments.ts`，以及 `grep -rn "'/api/\|\`/api/" web/src` 找到的其它地方

**Interfaces:**
- Produces: `appUrl(path: string): string`（去掉开头的 `/` 返回相对路径：`appUrl('/api/file?x=1') === 'api/file?x=1'`）

- [ ] **Step 1: 失败的测试**：`appUrl` 两种输入；再加一条源码扫描测试：`web/src` 非测试文件里没有以 `'/api/` 或 `` `/api/ `` 开头的字面量。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 回归**：`npm run build:all`；`node scripts/ui-smoke.cjs` 全部通过（桌面风格页面、`?win=` 第二窗口、附件上传、图片预览都在里面）；`curl http://127.0.0.1:<port>/` 返回的 HTML 里资源路径是 `./assets/…`。
- [ ] **Step 6: 提交** `refactor(web): relative asset and API paths (base './')`

### Task 11: 界面在通道里跑

**Files:**
- Modify: `web/src/ws/client.ts`
- Create: `web/src/ws/tunnel.ts`、`web/src/ws/client.test.ts`

**Interfaces:**
- Produces:
  - `interface TunnelSocket { readyState: number; send(text: string): void; close(): void; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((ev: { data: string }) => void) | null }`
  - `interface CwTunnel { connect(): TunnelSocket; kind(): LinkKind | null }`，挂在壳窗口的 `window.__cwTunnel`
  - `tunnelHost(): CwTunnel | null`（`window.parent !== window` 且同源且 `parent.__cwTunnel` 存在）
  - `WsClient` 的构造参数 `open?: () => WebSocketLike`；`ws` 单例在 `tunnelHost()` 存在时用 `() => tunnel.connect()`，否则照旧 `new WebSocket(...)`

- [ ] **Step 1: 失败的测试**：给 `WsClient` 注入假 socket：`request` 在 open 前排队、open 后发出；`onclose` 后按退避重连（再次调用 `open`）且未发出的请求不被拒绝；回复正确路由到 promise。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 提交** `feat(web): WsClient can run over a tunnel socket provided by the shell`

### Task 12: 手机壳

**Files:**
- Create: `web/shell.html`、`web/vite.shell.config.ts`、`web/src/shell/main.ts`、`web/src/shell/devices.ts`、`web/src/shell/pair-link.ts`、`web/src/shell/sw.ts`、`web/src/shell/route.ts`、`web/src/shell/assets.ts`、`web/src/shell/ui.ts`、`web/src/shell/*.test.ts`
- Modify: `web/package.json`（`build:shell` = `vite build -c vite.shell.config.ts`，`build` 后接它）、`web/tsconfig.json` 与 `web/vite.config.ts`（`@anywhere` → `../server/src/remote/anywhere/core/index.ts`）

**Interfaces:**
- Consumes: Task 7 `dial / DEFAULT_*`，Task 8 `Mux`，Task 11 `CwTunnel / TunnelSocket`
- Produces:
  - `parsePairLink(hash: string): { ps: Uint8Array; code: string; pc: string } | null`（`#p=` 解不出、`v !== 1`、`code` 不是 6 位数字 → `null`）
  - `interface DeviceRec { id: string; pcName: string; token: string; pairedAt: number; lastAt?: number }`；`interface DeviceStore { list(): Promise<DeviceRec[]>; put(d: DeviceRec): Promise<void>; remove(id: string): Promise<void> }`；`idbDevices(): DeviceStore`、`memoryDevices(): DeviceStore`（测试用）
  - `route(url: URL, scope: string): { kind: 'shell' } | { kind: 'asset'; path: string } | { kind: 'api'; path: string } | { kind: 'pass' }`（`<scope>app/api/…` → api，`<scope>app/…` → asset，`<scope>` 下其它 → shell，范围外 → pass）
  - `cacheName(deviceId: string, version: string): string` = `cw-app-${deviceId}-${version}`；`entryAssets(indexHtml: string): string[]`（解析 index.html 里 `./assets/...` 的 script / modulepreload / stylesheet）
  - 壳页面行为：
    - 打开 `#p=` → 配对（Task 8 的流程）→ 存设备 → 去掉 hash；
    - 否则列出设备，点一下 `dial`；连上后 `GET /api/health` 拿版本 → 若缓存 `cacheName` 不存在则取 `/index.html` + `entryAssets` 存入并删掉同设备的旧缓存 → 设 `window.__cwTunnel` → 全屏 iframe `app/index.html`；
    - SW：`asset` 先查当前缓存，缺的 `postMessage` 给壳窗口去取（壳经 `Mux.request` 取后回 `{status, headers, body}`）；`api` 一律转给壳，壳给路径补 `token=`；转发时壳收到 413 就原样回给 iframe（预览处显示该正文）；
    - 状态与报错文案用 spec 第 10 节的原句；`navigator.storage.persist()`；iOS 显示「添加到主屏幕」提示；
    - Link 断开 → 自动 `dial`（先直连，不行转发），iframe 不重载（`WsClient` 自己重连）。
- [ ] **Step 1: 失败的测试**：
  - `parsePairLink` 正常 / 坏 base64 / `v:2` / `code:'12a456'`；
  - `route` 四种结果（scope `/claude-web/`）；
  - `entryAssets` 对 `npm run build -w web` 产出的 `web/dist/index.html` 给出 ≥ 2 个以 `./assets/` 开头的路径；
  - `cacheName('d1','0.1.5') !== cacheName('d1','0.1.6')`（Review Focus 5）；
  - `memoryDevices` 增删查。
- [ ] **Step 2–4: 运行失败 → 实现 → 通过**
- [ ] **Step 5: 构建**：`npm run build -w web` 产出 `web/dist-shell/index.html`、`sw.js`，壳总大小（gzip 前）< 300 KB。
- [ ] **Step 6: 提交** `feat(shell): phone shell — pairing, device list, tunnel, service worker, app in iframe`

### Task 13: 设置页

**Files:**
- Modify: `web/src/features/settings/RemoteSection.tsx`、`web/src/features/settings/catalog.ts`（新条目进「手机与其它电脑」页，broker / STUN / 壳地址 / 最近连接进「更多选项」）、`web/src/features/settings/wording.test.ts`（如需白名单）、`scripts/ui-smoke.cjs`

**Interfaces:**
- Consumes: Task 8 `AnywhereStatus`、`remote.set {anywhere, keepAwake}`、`remote.pairCode → anywhereUrl`
- Produces: 页面内容（spec 第 10 节）：
  - 「在外面也能用」开关 + 状态行：全部 broker 不通 →「连不上牵线服务器，检查网络」，否则「可以从外面连」；
  - 二维码默认用 `anywhereUrl`，切换「只在局域网（不用联网）」用原 `url`；
  - 设备行最近一次：`直连 · IPv6 · 3 分钟前` / `直连 · 3 分钟前` / `慢速转发 · 3 分钟前` / `没连上：<原因>`；
  - 「不让电脑睡眠」开关 + 说明「屏幕照样会关；笔记本合盖照样会睡」；网页版说明「网页版做不到，去系统电源设置里关掉睡眠」；
  - 「更多选项」：broker 列表（每行 名称 · 地址 · 通 / 不通 · 用于转发）、STUN 列表、壳页面地址，都可编辑并 `settings.set`；最近 20 次连接。
- [ ] **Step 1: ui-smoke 先加断言**（会失败）：设置 → 手机与其它电脑 有「在外面也能用」开关、打开远程访问后二维码 `img` 存在且切换按钮在；「更多选项」里有牵线服务器列表；页面默认可见文字不含 `MQTT|WebRTC|STUN|ICE`。
- [ ] **Step 2: 实现** → `npm test -w web`（`wording.test.ts`、`catalog.test.ts` 通过）→ `npm run build:all && node scripts/ui-smoke.cjs` 通过。
- [ ] **Step 3: 提交** `feat(settings): 在外面也能用 — toggle, anywhere QR, last link per device, keep-awake`

### Task 14: 端到端 + 部署 + 文档

**Files:**
- Create: `server/ws-phase21.mjs`、`.github/workflows/pages.yml`
- Modify: `scripts/e2e.mjs`（默认列表加 `21`）、`CLAUDE.md`（新增一节「手机在外面也能连（2026-10-01）」：结构、密钥、默认列表、限制、调试方法）、`CHANGELOG.md`（未发布一节）、`README.md`（手机访问一段 + 风险说明）

**Interfaces:**
- Consumes: 以上全部

- [ ] **Step 1: 写 phase21**：自己起 mock broker（`dropEvery: 7`）和 server（临时 HOME，远程访问开在随机端口），手机侧用 `server/dist/remote/anywhere/core` + node-datachannel polyfill：配对 → `sessions.list` → `/api/file` Range → 附件上传 → 强制转发下 `sessions.list` 照常、`/api/file` 413 → 吊销后断开。打印每项 PASS / FAIL，失败退出码 1。
- [ ] **Step 2: 运行** `npm run build:all && node scripts/e2e.mjs 21` → 全部 PASS；再跑一次完整 `npm test`、`npm run typecheck`、`node scripts/e2e.mjs` 全绿。
- [ ] **Step 3: pages.yml**：`on: push: tags: ['v*']` + `workflow_dispatch`；`npm ci` → `npm run build:shell -w web` → `actions/upload-pages-artifact`（`web/dist-shell`）→ `actions/deploy-pages`。**第一次启用 GitHub Pages（仓库设置）和第一次部署前先问用户**——这是对外发布。
- [ ] **Step 4: 文档**（CLAUDE.md / CHANGELOG / README）。
- [ ] **Step 5: 提交** `test(anywhere): phase 21 end-to-end; docs; GitHub Pages workflow for the phone shell`
- [ ] **Step 6: 真机验证**（用户）：打包桌面版装上 → 扫码配对（家里 Wi-Fi）→ 切 Yes 5G 打开主屏幕图标 → 状态显示「慢速转发」→ 发一条消息、点允许一次、打开图片看到「慢速转发时不能预览 / 上传文件」。记录结果到 spec 的「实测」一节。
