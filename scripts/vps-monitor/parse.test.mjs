import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLine, createState, applyEvent, snapshot, isLost, parseSysBlock, sysView, labelFor, splitTopic, logScript, LIMITS } from './parse.mjs'

// 连接 / 订阅 / 退订 / PUBLISH / 断开 / PING 这些行的样子是从 VPS 的真实日志里抄的（2026-11-24），
// IP 换成了文档保留地址。超时、协议出错、同名顶掉这几种日志里当时没有，按 mosquitto 2.0.18 的格式写的。
const A = 'cwd239a5f3a880abbc9cb6'
const B = 'cw899a73b317bf94ba8feb'
const T1 = 'cw1/60fc350f2d8c60b1a684200f3733ac5e'
const T2 = 'cw1/9c6bb378b637552bce37ecdce96b09eb'

function run(lines, state = createState()) {
  const feed = []
  for (const l of lines) feed.push(...applyEvent(state, parseLine(l)))
  return { state, feed }
}

test('parseLine：真实日志里的行', () => {
  assert.deepEqual(parseLine(`1795506805: New client connected from 203.0.113.197:0 as ${A} (p2, c1, k60).`), {
    t: 1795506805, type: 'connect', ip: '203.0.113.197', port: 0, cid: A, proto: 2, clean: true, keepalive: 60,
  })
  assert.equal(parseLine('1795506805: No will message specified.').type, 'proto')
  assert.equal(parseLine(`1795506805: Sending CONNACK to ${A} (0, 0)`).type, 'proto')
  assert.deepEqual(parseLine(`1795506805: Received SUBSCRIBE from ${A}`), { t: 1795506805, type: 'sub_begin', cid: A })
  assert.deepEqual(parseLine(`1795506805: \t${T1} (QoS 0)`), { t: 1795506805, type: 'sub_topic', topic: T1, qos: 0 })
  assert.deepEqual(parseLine(`1795506805: ${A} 0 ${T1}`), { t: 1795506805, type: 'sub_reg', cid: A, qos: 0, topic: T1 })
  assert.equal(parseLine(`1795506805: Sending SUBACK to ${A}`).type, 'proto')
  assert.deepEqual(parseLine(`1795507080: Received PINGREQ from ${B}`), { t: 1795507080, type: 'ping', dir: 'req', cid: B })
  assert.deepEqual(parseLine(`1795507080: Sending PINGRESP to ${B}`), { t: 1795507080, type: 'ping', dir: 'resp', cid: B })
  assert.deepEqual(parseLine(`1795507133: Client ${A} closed its connection.`), { t: 1795507133, type: 'disconnect', cid: A, how: 'closed' })
  assert.deepEqual(parseLine(`1795507133: Client ${A} disconnected.`), { t: 1795507133, type: 'disconnect', cid: A, how: 'clean' })
  assert.deepEqual(parseLine('1795507133: Client <unknown> closed its connection.'), { t: 1795507133, type: 'anon_close' })
  assert.equal(parseLine('1795507133: Reloading config.').type, 'broker')
  assert.equal(parseLine('1795507133: mosquitto version 2.0.18 starting').type, 'broker_reset')
  assert.equal(parseLine('tail: /var/log/mosquitto/mosquitto.log: file truncated'), null)
  assert.equal(parseLine(''), null)
})

test('parseLine：PUBLISH / 退订 / 超时 / 出错 / IPv6', () => {
  assert.deepEqual(parseLine(`1795507200: Received PUBLISH from ${A} (d0, q0, r0, m0, '${T1}', ... (412 bytes))`), {
    t: 1795507200, type: 'pub_in', cid: A, dup: false, qos: 0, retain: false, mid: 0, topic: T1, bytes: 412,
  })
  assert.equal(parseLine(`1795507200: Sending PUBLISH to ${B} (d0, q0, r0, m0, '${T1}', ... (412 bytes))`).type, 'pub_out')
  assert.deepEqual(parseLine(`1795507200: Client ${A} has exceeded timeout, disconnecting.`), { t: 1795507200, type: 'disconnect', cid: A, how: 'timeout' })
  assert.deepEqual(parseLine(`1795507200: Client ${A} disconnected due to protocol error.`), {
    t: 1795507200, type: 'disconnect', cid: A, how: 'error', detail: 'protocol error',
  })
  assert.equal(parseLine(`1795507200: Received UNSUBSCRIBE from ${A}`).type, 'unsub_begin')
  assert.deepEqual(parseLine(`1795507200: \t${T1}`), { t: 1795507200, type: 'unsub_topic', topic: T1 })
  const v6 = parseLine(`1795507200: New client connected from 2001:db8::1:0 as ${A} (p2, c1, k60).`)
  assert.equal(v6.ip, '2001:db8::1')
  assert.equal(parseLine(`1795507200: Received DISCONNECT from ${A}`).type, 'proto')
})

test('连上 → 订阅两个房间 → 关掉：状态和事件流', () => {
  const { state, feed } = run([
    `1795507028: New client connected from 198.51.100.209:0 as ${B} (p2, c1, k60).`,
    '1795507028: No will message specified.',
    `1795507028: Sending CONNACK to ${B} (0, 0)`,
    `1795507028: Received SUBSCRIBE from ${B}`,
    `1795507028: \t${T1} (QoS 0)`,
    `1795507028: ${B} 0 ${T1}`,
    `1795507028: Sending SUBACK to ${B}`,
    `1795507028: Received SUBSCRIBE from ${B}`,
    `1795507028: \t${T2} (QoS 0)`,
    `1795507028: ${B} 0 ${T2}`,
    `1795507028: Sending SUBACK to ${B}`,
    `1795507058: Received PINGREQ from ${B}`,
    `1795507058: Sending PINGRESP to ${B}`,
  ])
  // 缩进行和登记行说的是同一次订阅，只算一次
  assert.deepEqual(feed.map((f) => f.k), ['connect', 'sub', 'sub', 'ping'])
  const s = snapshot(state)
  assert.equal(s.clients.length, 1)
  assert.deepEqual(s.clients[0].topics, [T1, T2])
  assert.equal(s.clients[0].ip, '198.51.100.209')
  assert.equal(s.clients[0].last, 1795507058)
  assert.equal(s.rooms.length, 2)
  assert.equal(s.rooms[0].members[0].cid, B)

  const { feed: f2 } = run([`1795507043: Client ${B} closed its connection.`], state)
  assert.equal(f2[0].k, 'disconnect')
  assert.equal(f2[0].how, 'closed')
  assert.equal(f2[0].dur, 15)
  assert.equal(f2[0].ip, '198.51.100.209')
  const s2 = snapshot(state)
  assert.equal(s2.clients.length, 0)
  assert.equal(s2.closed.length, 1)
  assert.equal(s2.closed[0].dur, 15)
  assert.equal(s2.rooms.find((r) => r.topic === T1).members.length, 0)
  assert.deepEqual(s2.rooms.find((r) => r.topic === T1).timeline.map((x) => x.k), ['join', 'leave'])
})

test('PUBLISH 转发给了别人：不算丢；只回给发布者自己：算丢', () => {
  const pub = (t, n) => `${t}: Received PUBLISH from ${A} (d0, q0, r0, m0, '${T1}', ... (${n} bytes))`
  const send = (t, to, n) => `${t}: Sending PUBLISH to ${to} (d0, q0, r0, m0, '${T1}', ... (${n} bytes))`
  const { state, feed } = run([
    `100000000: New client connected from 192.0.2.1:0 as ${A} (p2, c1, k60).`,
    `100000000: ${A} 0 ${T1}`,
    `100000001: New client connected from 192.0.2.2:0 as ${B} (p2, c1, k60).`,
    `100000001: ${B} 0 ${T1}`,
    pub(100000010, 300),
    send(100000010, B, 300),
    send(100000010, A, 300),
    `100000020: Client ${B} closed its connection.`,
    pub(100000030, 300),
    send(100000030, A, 300),
  ])
  const pubs = state.rooms.get(T1).timeline.filter((x) => x.k === 'pub')
  assert.equal(pubs.length, 2)
  assert.deepEqual(pubs[0].to.map((x) => x.cid), [B, A])
  assert.equal(pubs[0].othersThen, 1)
  assert.equal(isLost(pubs[0], 100000100), false)
  assert.deepEqual(pubs[1].to.map((x) => x.cid), [A])
  assert.equal(pubs[1].othersThen, 0)
  assert.equal(isLost(pubs[1], 100000030), false) // 刚到，还没到判定时间
  assert.equal(isLost(pubs[1], 100000030 + LIMITS.lostAfter), true)

  const outs = feed.filter((f) => f.k === 'pub_out')
  assert.deepEqual(outs.map((f) => f.self), [false, true, true])
  assert.equal(outs[0].from, A)

  const s = snapshot(state, 100000100)
  const room = s.rooms.find((r) => r.topic === T1)
  assert.equal(room.lost, 1)
  assert.equal(s.counts.lost, 1)
  assert.equal(room.pubs, 2)
  const a = s.clients.find((c) => c.cid === A)
  assert.deepEqual([a.sent, a.sentBytes, a.recv, a.recvBytes], [2, 600, 2, 600])
  assert.deepEqual([s.closed[0].sent, s.closed[0].recv, s.closed[0].recvBytes], [0, 1, 300])
})

test('连着两条一样大的 PUBLISH：转发按先后各归各的', () => {
  const { state } = run([
    `100000000: ${A} 0 ${T1}`,
    `100000000: ${B} 0 ${T1}`,
    `100000010: Received PUBLISH from ${A} (d0, q0, r0, m0, '${T1}', ... (50 bytes))`,
    `100000010: Received PUBLISH from ${A} (d0, q0, r0, m0, '${T1}', ... (50 bytes))`,
    `100000010: Sending PUBLISH to ${B} (d0, q0, r0, m0, '${T1}', ... (50 bytes))`,
    `100000010: Sending PUBLISH to ${B} (d0, q0, r0, m0, '${T1}', ... (50 bytes))`,
  ])
  const pubs = state.rooms.get(T1).timeline.filter((x) => x.k === 'pub')
  assert.deepEqual(pubs.map((p) => p.to.length), [1, 1])
})

test('中转数据的 topic（房间/r/<会话>/up|down）归到同一个房间，收没收到按各自的 topic 算', () => {
  const R = 'cw1/dd38af02f891e09e098cbbf304a99c5c'
  const UP = R + '/r/F9g3EY22FKbbCcmduRO-yw/up'
  const DOWN = R + '/r/F9g3EY22FKbbCcmduRO-yw/down'
  assert.deepEqual(splitTopic(UP), { room: R, ch: 'r/F9g3EY22FKbbCcmduRO-yw/up' })
  assert.deepEqual(splitTopic(R), { room: R, ch: '' })
  assert.deepEqual(splitTopic('other/topic'), { room: 'other/topic', ch: '' })
  const { state, feed } = run([
    `1795507244: New client connected from 192.0.2.91:0 as ${A} (p2, c1, k60).`,
    `1795507244: ${A} 0 ${R}`,
    `1795507244: New client connected from 203.0.113.22:0 as ${B} (p2, c1, k60).`,
    `1795507244: Received SUBSCRIBE from ${B}`,
    `1795507244: \t${R} (QoS 0)`,
    `1795507244: ${B} 0 ${R}`,
    `1795507244: Sending SUBACK to ${B}`,
    `1795507244: Received PUBLISH from ${B} (d0, q0, r0, m0, '${R}', ... (478 bytes))`,
    `1795507244: Sending PUBLISH to ${A} (d0, q0, r0, m0, '${R}', ... (478 bytes))`,
    `1795507244: Sending PUBLISH to ${B} (d0, q0, r0, m0, '${R}', ... (478 bytes))`,
    `1795507245: ${A} 0 ${UP}`,
    `1795507245: ${B} 0 ${DOWN}`,
    `1795507262: Received PUBLISH from ${B} (d0, q0, r0, m0, '${UP}', ... (2927 bytes))`,
    `1795507262: Sending PUBLISH to ${A} (d0, q0, r0, m0, '${UP}', ... (2927 bytes))`,
    `1795507262: Received PUBLISH from ${A} (d0, q0, r0, m0, '${DOWN}', ... (2927 bytes))`,
    `1795507262: Sending PUBLISH to ${B} (d0, q0, r0, m0, '${DOWN}', ... (2927 bytes))`,
    // 手机退订了 down，电脑还在往里发：没人收
    `1795507270: Received UNSUBSCRIBE from ${B}`,
    `1795507270: \t${DOWN}`,
    `1795507270: ${B} ${DOWN}`,
    `1795507270: Sending UNSUBACK to ${B}`,
    `1795507271: Received PUBLISH from ${A} (d0, q0, r0, m0, '${DOWN}', ... (788 bytes))`,
  ])
  assert.equal(state.rooms.size, 1)
  const s = snapshot(state, 1795507280)
  const room = s.rooms[0]
  assert.equal(room.topic, R)
  assert.equal(room.members.length, 2)
  assert.deepEqual(room.channels, ['r/F9g3EY22FKbbCcmduRO-yw/up'])
  const pubs = room.timeline.filter((x) => x.k === 'pub')
  assert.deepEqual(pubs.map((p) => [p.ch.split('/').pop() || '', p.to.map((x) => x.cid).join(','), p.lost, p.othersThen]), [
    ['', `${A},${B}`, false, 1],
    ['up', A, false, 1],
    ['down', B, false, 1], // 同样大小、同一秒，但 topic 不同，不会串到 up 那条上
    ['down', '', true, 0],
  ])
  assert.equal(room.lost, 1)
  assert.equal(feed.at(-1).others, 0)
  assert.deepEqual(feed.filter((f) => f.k === 'unsub').map((f) => f.topic), [DOWN])
  // 断开只在房间时间线里记一次「离开」
  run([`1795507300: Client ${B} closed its connection.`], state)
  assert.equal(state.rooms.get(R).timeline.filter((x) => x.k === 'leave' && x.how === 'closed').length, 1)
})

test('跟日志的远端脚本', () => {
  assert.equal(logScript('/var/log/mosquitto/mosquitto.log', 2000),
    'echo "@@LOG $(wc -l < /var/log/mosquitto/mosquitto.log)"\nexec tail -n 2000 -F /var/log/mosquitto/mosquitto.log\n')
})

test('回放窗口之前就连着的客户端：只见到 PING 也算在线，IP 未知', () => {
  const { state } = run([`1795507080: Received PINGREQ from ${B}`, `1795507080: Sending PINGRESP to ${B}`])
  const s = snapshot(state)
  assert.equal(s.clients.length, 1)
  assert.equal(s.clients[0].ip, null)
  assert.equal(s.clients[0].t0, null)
  const { feed } = run([`1795507090: Client ${B} has exceeded timeout, disconnecting.`], state)
  assert.equal(feed[0].how, 'timeout')
  assert.equal(feed[0].dur, null)
})

test('退订、同名重连、broker 重启、没 CONNECT 就关的连接', () => {
  const { state, feed } = run([
    `100000000: New client connected from 192.0.2.1:0 as ${A} (p2, c1, k60).`,
    `100000000: ${A} 0 ${T1}`,
    `100000005: Received UNSUBSCRIBE from ${A}`,
    `100000005: \t${T1}`,
    `100000005: ${A} ${T1}`,
    `100000006: Client ${A} already connected, closing old connection.`,
    `100000006: New client connected from 192.0.2.9:0 as ${A} (p2, c1, k60).`,
    '100000007: Client <unknown> closed its connection.',
    '100000008: mosquitto version 2.0.18 terminating',
  ])
  assert.deepEqual(feed.map((f) => f.k), ['connect', 'sub', 'unsub', 'disconnect', 'connect', 'anon', 'broker'])
  assert.equal(feed[3].how, 'takeover')
  assert.equal(state.clients.size, 0)
  assert.deepEqual(state.closed.map((c) => c.how), ['takeover', 'broker'])
  assert.equal(state.closed[1].ip, '192.0.2.9')
  assert.equal(state.counts.anonCloses, 1)
})

test('最近断开的连接只留 200 条', () => {
  const state = createState()
  for (let i = 0; i < 260; i++) {
    applyEvent(state, parseLine(`${100000000 + i}: New client connected from 192.0.2.1:0 as cw${i} (p2, c1, k60).`))
    applyEvent(state, parseLine(`${100000001 + i}: Client cw${i} disconnected.`))
  }
  assert.equal(state.closed.length, 200)
  assert.equal(state.closed.at(-1).cid, 'cw259')
  assert.equal(state.closed.at(-1).how, 'clean')
})

test('系统采样：解析和速率', () => {
  const block = (t, rx, tx, idle) => [
    `@@B ${t}`,
    '@@load 0.10 0.05 0.01 1/140 61114',
    '@@cpus 1',
    `@@cpu cpu  ${1000 + (idle - 9000) / 19} 0 500 ${idle} 20 0 5 0 0 0`,
    '@@up 925923.85',
    '@@mem MemTotal:         984564 kB',
    '@@mem MemAvailable:     583160 kB',
    '@@mem SwapTotal:       1048572 kB',
    '@@mem SwapFree:        1048304 kB',
    '@@disk /dev/vda1      10461941760 5216333824 4692156416      53% /',
    '@@net     lo: 98856502 1601845    0    0    0     0          0         0 98856502 1601845    0    0    0     0       0          0',
    `@@net   eth0: ${rx} 6903724    0 486339    0     0          0         0 ${tx} 4421846    0    0    0     0       0          0`,
    '@@svc active active inactive ',
    '@@tcp TCP:   52 (estab 41, closed 4, orphaned 1, timewait 1)',
    '@@c443 17',
    '@@c9001 13',
  ]
  const a = parseSysBlock(block('1000.0', 1000000, 500000, 9000))
  const b = parseSysBlock(block('1003.0', 1003000, 506000, 9285))
  assert.equal(a.rx, 1000000) // lo 不算
  assert.deepEqual(a.svc, { caddy: 'active', mosquitto: 'active', coturn: 'inactive' })
  assert.deepEqual(a.tcp, { total: 52, estab: 41 })
  const first = sysView(a, null)
  assert.equal(first.rxRate, null)
  assert.equal(first.memTotal, 984564 * 1024)
  assert.equal(first.memUsed, (984564 - 583160) * 1024)
  const v = sysView(b, a)
  assert.equal(v.rxRate, 1000)
  assert.equal(v.txRate, 2000)
  assert.equal(Math.round(v.cpuPct), 5) // 300 个 tick 里 285 个闲着
  assert.equal(v.c9001, 13)
  assert.equal(v.disk.used, 5216333824)
})

test('IP 备注：最长前缀优先', () => {
  const labels = { '203.0.': '移动', '203.0.113.': '某人的手机' }
  assert.equal(labelFor('203.0.113.7', labels), '某人的手机')
  assert.equal(labelFor('203.0.1.7', labels), '移动')
  assert.equal(labelFor('198.51.100.1', labels), null)
  assert.equal(labelFor(null, labels), null)
})
