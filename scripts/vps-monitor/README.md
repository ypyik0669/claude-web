# VPS 监控（本机自用）

实时看 VPS（198.44.111.28）上 mosquitto 在干什么，排查「手机连不上电脑」。对 VPS 只读：两条 ssh 长连接，
一条 `tail -F` mosquitto 日志，一条每 3 秒采一次系统数据；不装东西、不改配置、不写文件。

```
node scripts/vps-monitor/server.mjs          # 然后打开 http://127.0.0.1:3197/
node scripts/vps-monitor/server.mjs --port 3198 --replay 5000
node --test scripts/vps-monitor/             # 解析器的测试
```

要求：本机有 `ssh`，`~/.ssh/cw_oracle` 能免密登录（`--key` / `--host` / `--log` 可改）。没有 npm 依赖。
启动时先回放日志最近 2000 行重建状态（`--replay`），之后实时跟。ssh 断了自己重连（1s、2s … 最多 30s），每次重连重新回放。

## 每块看什么

- **顶部**：两条 ssh 的状态（正常 / 重连中）、负载、内存、磁盘、上下行速率、caddy / mosquitto / coturn 是否在跑、
  TCP 连接数（:443、:9001）、MQTT 在线数、**没人收到的 PUBLISH** 总数。
- **在线客户端**：client id（前 8 位，悬停看全）、IP、连上多久、在哪些房间、发 / 收的 PUBLISH 条数和字节、最后活动时间。
  IP 显示「未知」的是回放窗口之前就连着的（日志里只剩它的心跳）。
- **房间**：一个 `cw1/<hash>` 是一对设备的房间；牵线消息发在它上面，走 broker 中转的数据发在 `…/r/<会话>/up|down` 上，
  都归在这个房间里。点一行展开时间线：谁进来 / 离开、谁发了多少字节、broker 转给了谁。
  **红底 = 这条 PUBLISH 过了 2 秒也没转发给任何别的客户端**（回给发布者自己的不算），行尾的红色数字是这个房间里这种消息的条数。
- **事件流**：实时滚动。PING 默认不显示；「中转数据」关掉后只留牵线消息和没人收到的；可按 IP 前缀 / client id / topic 筛选，
  点任何一个 client、IP、房间就按它筛。断开分三种颜色：绿 = 发了 DISCONNECT，黄 = 直接关了，红 = 超时 / 出错，后面是这条连接活了多久。
- **最近断开的连接**：最近 200 条，活了不到 30 秒的时长标红，「只看短命的」只留这些。
- **IP 备注**（最下面一行）：给 IP 前缀起名字，如 `223.104.` = `某用户的手机 移动 5G`，最长前缀优先。
  存在本目录的 `labels.json`（不进 git）。不查任何外部 IP 归属地服务。

## 限制

- 「有没有别人收到」是把 `Sending PUBLISH` 按同一个 topic、同样字节数、5 秒内归到 `Received PUBLISH` 上算的，日志里没有消息 id。
- 回放窗口之前的事看不到：老连接的 IP、连上时间、订阅都是未知，所以「当时有几个别的订阅者」可能少算；红底本身只看有没有转发，不受影响。
- 没发 CONNECT 就关掉的连接（`Client <unknown> closed`）日志里没有 IP，只计数。
- 时间显示本机时区；日志时间戳是 VPS 的钟。HTTP 只监听 127.0.0.1。

文件：`server.mjs`（ssh + HTTP/SSE）、`parse.mjs`（纯函数：日志行 → 事件 → 状态；系统采样）、`parse.test.mjs`、`index.html`（页面）、
`package.json`（只为了让 `node --test scripts/vps-monitor/` 在 Node 22 上能按目录跑）。
