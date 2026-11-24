// 纯函数：mosquitto 日志行 → 事件；事件 → 状态；系统采样文本 → 数字。
// 不碰网络、不碰文件，server.mjs 和 parse.test.mjs 都用它。

const RE_LINE = /^(\d{9,11}): (.*)$/
const RE_CONNECT = /^New client connected from (.+):(\d+) as (\S+) \(p(\d+), c(\d), k(\d+)(?:, u'([^']*)')?\)\.$/
const RE_PUBLISH = /^(Received PUBLISH from|Sending PUBLISH to) (\S+) \(d(\d), q(\d), r(\d), m(\d+), '(.*)', \.\.\. \((\d+) bytes\)\)$/
const RE_SUB_REG = /^(\S+) (\d) (\S+)$/
const RE_UNSUB_REG = /^(\S+) (\S+)$/

/** 一行日志 → 事件（不是日志行就返回 null）。 */
export function parseLine(line) {
  const m = RE_LINE.exec(line.replace(/\r$/, ''))
  if (!m) return null
  const t = Number(m[1])
  const msg = m[2]
  let x

  if ((x = RE_CONNECT.exec(msg))) {
    return { t, type: 'connect', ip: x[1], port: Number(x[2]), cid: x[3], proto: Number(x[4]), clean: x[5] === '1', keepalive: Number(x[6]) }
  }
  if ((x = RE_PUBLISH.exec(msg))) {
    return {
      t, type: x[1].startsWith('Received') ? 'pub_in' : 'pub_out', cid: x[2],
      dup: x[3] === '1', qos: Number(x[4]), retain: x[5] === '1', mid: Number(x[6]), topic: x[7], bytes: Number(x[8]),
    }
  }
  if ((x = /^Received (PINGREQ) from (\S+)$/.exec(msg)) || (x = /^Sending (PINGRESP) to (\S+)$/.exec(msg))) {
    return { t, type: 'ping', dir: x[1] === 'PINGREQ' ? 'req' : 'resp', cid: x[2] }
  }
  if ((x = /^Received SUBSCRIBE from (\S+)$/.exec(msg))) return { t, type: 'sub_begin', cid: x[1] }
  if ((x = /^Received UNSUBSCRIBE from (\S+)$/.exec(msg))) return { t, type: 'unsub_begin', cid: x[1] }
  if ((x = /^\t(.+) \(QoS (\d)\)$/.exec(msg))) return { t, type: 'sub_topic', topic: x[1], qos: Number(x[2]) }
  if ((x = /^\t(.+)$/.exec(msg))) return { t, type: 'unsub_topic', topic: x[1] }

  if ((x = /^Client (\S+) disconnected\.$/.exec(msg))) return { t, type: 'disconnect', cid: x[1], how: 'clean' }
  if ((x = /^Client (\S+) closed its connection\.$/.exec(msg))) {
    return x[1] === '<unknown>' ? { t, type: 'anon_close' } : { t, type: 'disconnect', cid: x[1], how: 'closed' }
  }
  if ((x = /^Client (\S+) has exceeded timeout, disconnecting\.$/.exec(msg))) return { t, type: 'disconnect', cid: x[1], how: 'timeout' }
  if ((x = /^Client (\S+) already connected, closing old connection\.$/.exec(msg))) return { t, type: 'takeover', cid: x[1] }
  if ((x = /^Client (\S+) disconnected(?: due to |: |, )(.+?)\.?$/.exec(msg))) return { t, type: 'disconnect', cid: x[1], how: 'error', detail: x[2] }
  if ((x = /^Socket error on client (\S+), disconnecting\.$/.exec(msg))) {
    return x[1] === '<unknown>' ? { t, type: 'anon_close' } : { t, type: 'disconnect', cid: x[1], how: 'error', detail: 'socket error' }
  }
  if ((x = /^Bad socket (?:read|write)\/(?:read|write) on client (\S+): (.+)$/.exec(msg))) return { t, type: 'disconnect', cid: x[1], how: 'error', detail: x[2] }

  if (/^mosquitto version \S+ (starting|terminating)$/.test(msg)) return { t, type: 'broker_reset', msg }
  if (/^(mosquitto version|Reloading config|Loading config|Config loaded|Opening |Note: |Saving in-memory|Starting in local|Create a configuration|For more details)/.test(msg)) {
    return { t, type: 'broker', msg }
  }
  if (/^(Sending (CONNACK|SUBACK|UNSUBACK|PUBACK|PUBREC|PUBREL|PUBCOMP) to |Received (PUBACK|PUBREC|PUBREL|PUBCOMP|DISCONNECT) from |No will message specified|Will message specified)/.test(msg)) {
    return { t, type: 'proto', msg }
  }
  // 订阅登记行「<client> <qos> <topic>」/ 退订登记行「<client> <topic>」，放最后以免吃掉别的行。
  if ((x = RE_SUB_REG.exec(msg))) return { t, type: 'sub_reg', cid: x[1], qos: Number(x[2]), topic: x[3] }
  if ((x = RE_UNSUB_REG.exec(msg))) return { t, type: 'unsub_reg', cid: x[1], topic: x[2] }
  return { t, type: 'other', msg }
}

export const LIMITS = { closed: 200, timeline: 400, relayKeep: 200, rooms: 400, matchWindow: 5, matchDepth: 120, lostAfter: 2 }

/**
 * topic → 房间。一对设备的房间是 cw1/<32hex>：牵线消息发在它上面，
 * 走 broker 中转的数据发在它下面的 /r/<会话>/up|down 上。都归到同一个房间，ch 是后面那段。
 */
export function splitTopic(topic) {
  const m = /^(cw1\/[0-9a-f]{32})(?:\/(.*))?$/.exec(topic)
  return m ? { room: m[1], ch: m[2] || '' } : { room: topic, ch: '' }
}

export function createState() {
  return {
    now: 0,
    seq: 0,
    clients: new Map(), // cid → 在线客户端
    rooms: new Map(), // topic → 房间
    closed: [], // 最近结束的连接，新的在后
    counts: { connects: 0, disconnects: 0, anonCloses: 0, pubs: 0 },
    pending: null, // 上一条 SUBSCRIBE / UNSUBSCRIBE 是谁发的（话题在下一行）
  }
}

function newClient(cid, t, known) {
  return { cid, ip: null, t0: known ? t : null, proto: null, keepalive: null, topics: new Set(), sent: 0, sentBytes: 0, recv: 0, recvBytes: 0, last: t }
}

function getClient(state, cid, t) {
  let c = state.clients.get(cid)
  if (!c) {
    // 没见过它连上（在回放窗口之前就连着）：IP 和连上时间未知。
    c = newClient(cid, t, false)
    state.clients.set(cid, c)
  }
  c.last = t
  return c
}

function getRoom(state, topic, t) {
  const key = splitTopic(topic).room
  let r = state.rooms.get(key)
  if (!r) {
    // subs：这个房间下每个 topic 现在有谁订阅着
    r = { topic: key, subs: new Map(), timeline: [], pubs: 0, last: t }
    state.rooms.set(key, r)
    if (state.rooms.size > LIMITS.rooms) {
      for (const [k, v] of state.rooms) {
        if (state.rooms.size <= LIMITS.rooms) break
        if (v.subs.size === 0 && v !== r) state.rooms.delete(k)
      }
    }
  }
  r.last = t
  return r
}

function pushTimeline(room, item) {
  const tl = room.timeline
  tl.push(item)
  if (tl.length <= LIMITS.timeline) return
  // 中转数据一多会把牵线消息挤出去：中转的超过 relayKeep 条就先丢最老的中转。
  let relay = 0
  for (const x of tl) if (x.ch) relay++
  const i = relay > LIMITS.relayKeep ? tl.findIndex((x) => x.ch) : 0
  tl.splice(i < 0 ? 0 : i, 1)
}

function othersOn(room, topic, cid) {
  const set = room.subs.get(topic)
  if (!set) return 0
  return set.size - (set.has(cid) ? 1 : 0)
}

function dropSub(room, topic, cid) {
  const set = room.subs.get(topic)
  if (!set) return
  set.delete(cid)
  if (!set.size) room.subs.delete(topic)
}

function endClient(state, cid, t, how, detail) {
  const c = state.clients.get(cid)
  if (!c) return null
  state.clients.delete(cid)
  const left = new Set()
  for (const topic of c.topics) {
    const r = state.rooms.get(splitTopic(topic).room)
    if (!r) continue
    dropSub(r, topic, cid)
    if (left.has(r)) continue
    left.add(r)
    r.last = t
    pushTimeline(r, { k: 'leave', t, cid, ip: c.ip, how })
  }
  const rec = {
    cid, ip: c.ip, t0: c.t0, t1: t, dur: c.t0 == null ? null : t - c.t0, how, detail: detail || null,
    sent: c.sent, sentBytes: c.sentBytes, recv: c.recv, recvBytes: c.recvBytes, topics: [...c.topics],
  }
  state.closed.push(rec)
  if (state.closed.length > LIMITS.closed) state.closed.splice(0, state.closed.length - LIMITS.closed)
  state.counts.disconnects++
  return rec
}

function subscribe(state, cid, topic, t) {
  const c = getClient(state, cid, t)
  if (c.topics.has(topic)) return null
  c.topics.add(topic)
  const r = getRoom(state, topic, t)
  if (!r.subs.has(topic)) r.subs.set(topic, new Set())
  r.subs.get(topic).add(cid)
  pushTimeline(r, { k: 'join', t, cid, ip: c.ip, ch: splitTopic(topic).ch })
  return { t, k: 'sub', cid, ip: c.ip, topic, others: othersOn(r, topic, cid) }
}

function unsubscribe(state, cid, topic, t) {
  const c = getClient(state, cid, t)
  if (!c.topics.delete(topic)) return null
  const r = getRoom(state, topic, t)
  dropSub(r, topic, cid)
  pushTimeline(r, { k: 'leave', t, cid, ip: c.ip, how: 'unsub', ch: splitTopic(topic).ch })
  return { t, k: 'unsub', cid, ip: c.ip, topic }
}

/**
 * 把一个事件并进状态（原地改），返回要进「事件流」的条目（0 条或多条）。
 * 条目形状：{ i, t, k, cid?, ip?, topic?, bytes?, how?, dur?, text? … }
 */
export function applyEvent(state, ev) {
  if (!ev) return []
  if (ev.t > state.now) state.now = ev.t
  const out = []
  const emit = (o) => { o.i = ++state.seq; out.push(o) }
  const keepPending = ev.type === 'sub_topic' || ev.type === 'unsub_topic' || ev.type === 'sub_reg' || ev.type === 'unsub_reg'
  const pending = state.pending
  if (!keepPending) state.pending = null

  switch (ev.type) {
    case 'connect': {
      const old = state.clients.get(ev.cid)
      if (old) {
        const rec = endClient(state, ev.cid, ev.t, 'takeover')
        emit({ t: ev.t, k: 'disconnect', cid: ev.cid, ip: rec.ip, how: 'takeover', dur: rec.dur, sent: rec.sent, recv: rec.recv })
      }
      const c = newClient(ev.cid, ev.t, true)
      c.ip = ev.ip; c.proto = ev.proto; c.keepalive = ev.keepalive
      state.clients.set(ev.cid, c)
      state.counts.connects++
      emit({ t: ev.t, k: 'connect', cid: ev.cid, ip: ev.ip, keepalive: ev.keepalive })
      break
    }
    case 'disconnect': {
      const rec = endClient(state, ev.cid, ev.t, ev.how, ev.detail)
      if (rec) emit({ t: ev.t, k: 'disconnect', cid: ev.cid, ip: rec.ip, how: ev.how, detail: rec.detail, dur: rec.dur, sent: rec.sent, recv: rec.recv })
      else emit({ t: ev.t, k: 'disconnect', cid: ev.cid, ip: null, how: ev.how, detail: ev.detail || null, dur: null, sent: 0, recv: 0 })
      break
    }
    case 'anon_close':
      state.counts.anonCloses++
      emit({ t: ev.t, k: 'anon' })
      break
    case 'takeover':
      break // 紧跟着的 connect 会把旧连接收掉
    case 'sub_begin':
      getClient(state, ev.cid, ev.t)
      state.pending = { kind: 'sub', cid: ev.cid }
      break
    case 'unsub_begin':
      getClient(state, ev.cid, ev.t)
      state.pending = { kind: 'unsub', cid: ev.cid }
      break
    case 'sub_topic':
    case 'unsub_topic': {
      if (!pending) break
      // 缩进行本身不带 (QoS n) 时 parseLine 认成 unsub_topic；以上一条是谁为准。
      const f = pending.kind === 'sub' ? subscribe(state, pending.cid, ev.topic, ev.t) : unsubscribe(state, pending.cid, ev.topic, ev.t)
      if (f) emit(f)
      break
    }
    case 'sub_reg': {
      const f = subscribe(state, ev.cid, ev.topic, ev.t)
      if (f) emit(f)
      break
    }
    case 'unsub_reg': {
      // 只有紧跟在同一个客户端的 UNSUBSCRIBE 后面才当退订，免得把别的两段式消息认错。
      if (pending && pending.kind === 'unsub' && pending.cid === ev.cid) {
        const f = unsubscribe(state, ev.cid, ev.topic, ev.t)
        if (f) emit(f)
      } else emit({ t: ev.t, k: 'other', text: ev.cid + ' ' + ev.topic })
      break
    }
    case 'pub_in': {
      const c = getClient(state, ev.cid, ev.t)
      c.sent++; c.sentBytes += ev.bytes
      const r = getRoom(state, ev.topic, ev.t)
      r.pubs++
      state.counts.pubs++
      // 当时这个 topic 上除了它自己还有几个订阅者（0 = 注定没人收）
      const others = othersOn(r, ev.topic, ev.cid)
      const id = ++state.seq
      pushTimeline(r, { k: 'pub', id, t: ev.t, from: ev.cid, fromIp: c.ip, bytes: ev.bytes, to: [], othersThen: others, ch: splitTopic(ev.topic).ch })
      out.push({ i: id, t: ev.t, k: 'pub_in', cid: ev.cid, ip: c.ip, topic: ev.topic, bytes: ev.bytes, others })
      break
    }
    case 'pub_out': {
      const c = getClient(state, ev.cid, ev.t)
      c.recv++; c.recvBytes += ev.bytes
      const r = getRoom(state, ev.topic, ev.t)
      // 归到最早一条「同一个 topic、同样大小、还没发给过它、5 秒内」的 PUBLISH 上。
      const ch = splitTopic(ev.topic).ch
      let hit = null
      for (let i = r.timeline.length - 1, n = 0; i >= 0 && n < LIMITS.matchDepth; i--, n++) {
        const p = r.timeline[i]
        if (p.k !== 'pub') continue
        if (ev.t - p.t > LIMITS.matchWindow) break
        if (p.ch === ch && p.bytes === ev.bytes && !p.to.some((x) => x.cid === ev.cid)) hit = p
      }
      if (hit) hit.to.push({ cid: ev.cid, ip: c.ip, t: ev.t })
      else pushTimeline(r, { k: 'stray', t: ev.t, cid: ev.cid, ip: c.ip, bytes: ev.bytes, ch })
      emit({ t: ev.t, k: 'pub_out', cid: ev.cid, ip: c.ip, topic: ev.topic, bytes: ev.bytes, from: hit ? hit.from : null, self: hit ? hit.from === ev.cid : false, pub: hit ? hit.id : null })
      break
    }
    case 'ping': {
      const c = getClient(state, ev.cid, ev.t)
      if (ev.dir === 'req') emit({ t: ev.t, k: 'ping', cid: ev.cid, ip: c.ip })
      break
    }
    case 'broker_reset': {
      for (const cid of [...state.clients.keys()]) endClient(state, cid, ev.t, 'broker')
      emit({ t: ev.t, k: 'broker', text: ev.msg })
      break
    }
    case 'broker':
      emit({ t: ev.t, k: 'broker', text: ev.msg })
      break
    case 'proto':
      break
    default:
      emit({ t: ev.t, k: 'other', text: ev.msg })
  }
  return out
}

/** 一条 PUBLISH 有没有被别人收到（发布者自己收到的回显不算）。 */
export function deliveredToOthers(pub) {
  return pub.to.filter((x) => x.cid !== pub.from).length
}

/** 「没人收到」：过了 lostAfter 秒还没有转发给任何别的客户端。 */
export function isLost(pub, now) {
  return deliveredToOthers(pub) === 0 && now - pub.t >= LIMITS.lostAfter
}

/** 状态 → 可以 JSON 化的快照（给页面）。now 用来判定「没人收到」，默认取日志里最新的时间。 */
export function snapshot(state, now = state.now) {
  const clients = [...state.clients.values()].map((c) => ({ ...c, topics: [...c.topics] }))
  clients.sort((a, b) => (b.t0 ?? 0) - (a.t0 ?? 0))
  let lostTotal = 0
  const rooms = [...state.rooms.values()].map((r) => {
    let lost = 0
    const timeline = r.timeline.map((it) => {
      if (it.k !== 'pub') return it
      const l = isLost(it, now)
      if (l) lost++
      return { ...it, lost: l }
    })
    lostTotal += lost
    const members = new Set()
    for (const set of r.subs.values()) for (const cid of set) members.add(cid)
    return {
      topic: r.topic,
      members: [...members].map((cid) => ({ cid, ip: state.clients.get(cid)?.ip ?? null })),
      channels: [...r.subs.keys()].map((t) => splitTopic(t).ch).filter(Boolean),
      pubs: r.pubs, lost, last: r.last, timeline,
    }
  })
  rooms.sort((a, b) => b.members.length - a.members.length || b.last - a.last)
  return { now, clients, rooms, closed: state.closed, counts: { ...state.counts, lost: lostTotal } }
}

// ───────── 系统采样 ─────────

/** 远端循环脚本（经 ssh 的 stdin 交给 sh；只读，不写任何东西）。 */
export const SYS_SCRIPT = [
  'while true; do',
  'echo "@@B $(date +%s.%N)"',
  'echo "@@load $(cat /proc/loadavg)"',
  'echo "@@cpus $(nproc)"',
  'echo "@@cpu $(head -n 1 /proc/stat)"',
  'echo "@@up $(cut -d" " -f1 /proc/uptime)"',
  'grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo | sed "s/^/@@mem /"',
  'echo "@@disk $(df -B1 -P / | tail -n 1)"',
  'grep ":" /proc/net/dev | sed "s/^/@@net /"',
  'echo "@@svc $(systemctl is-active caddy mosquitto coturn | tr "\\n" " ")"',
  'echo "@@tcp $(ss -s | grep "^TCP:")"',
  'echo "@@c443 $(ss -Htn state established "( sport = :443 )" | wc -l)"',
  'echo "@@c9001 $(ss -Htn state established "( sport = :9001 )" | wc -l)"',
  'echo "@@E"',
  'sleep 3',
  'done',
  '',
].join('\n')

/** 跟日志的远端脚本：先报文件现在有几行（回放到哪算完），再 tail -F。 */
export function logScript(file, replay) {
  return 'echo "@@LOG $(wc -l < ' + file + ')"\nexec tail -n ' + replay + ' -F ' + file + '\n'
}

export const SERVICES = ['caddy', 'mosquitto', 'coturn']

/** 一个采样块（@@B … @@E 之间的行）→ 原始数字。 */
export function parseSysBlock(lines) {
  const s = { t: 0, load: [0, 0, 0], cpus: 1, cpu: null, uptime: 0, mem: {}, disk: null, rx: 0, tx: 0, svc: {}, tcp: null, c443: null, c9001: null }
  for (const raw of lines) {
    const m = /^@@(\w+) ?(.*)$/.exec(raw.replace(/\r$/, ''))
    if (!m) continue
    const [, tag, rest] = m
    const f = rest.trim().split(/\s+/)
    if (tag === 'B') s.t = Number(rest)
    else if (tag === 'load') s.load = f.slice(0, 3).map(Number)
    else if (tag === 'cpus') s.cpus = Number(rest) || 1
    else if (tag === 'up') s.uptime = Number(rest)
    else if (tag === 'cpu') {
      const n = f.slice(1).map(Number)
      const idle = (n[3] || 0) + (n[4] || 0)
      s.cpu = { idle, total: n.slice(0, 8).reduce((a, b) => a + (b || 0), 0) }
    } else if (tag === 'mem') s.mem[f[0].replace(':', '')] = Number(f[1]) * 1024
    else if (tag === 'disk') s.disk = { total: Number(f[1]), used: Number(f[2]), avail: Number(f[3]) }
    else if (tag === 'net') {
      const x = /^\s*([^:\s]+):\s*(.*)$/.exec(rest)
      if (x && x[1] !== 'lo') {
        const n = x[2].trim().split(/\s+/).map(Number)
        s.rx += n[0] || 0
        s.tx += n[8] || 0
      }
    } else if (tag === 'svc') SERVICES.forEach((name, i) => { s.svc[name] = f[i] || 'unknown' })
    else if (tag === 'tcp') {
      const x = /TCP:\s+(\d+) \(estab (\d+)/.exec(rest)
      if (x) s.tcp = { total: Number(x[1]), estab: Number(x[2]) }
    } else if (tag === 'c443') s.c443 = Number(rest)
    else if (tag === 'c9001') s.c9001 = Number(rest)
  }
  return s
}

/** 两次采样 → 给页面的数字（速率、CPU 占用要靠前一次算）。 */
export function sysView(cur, prev) {
  const v = {
    t: cur.t, load: cur.load, cpus: cur.cpus, uptime: cur.uptime,
    memTotal: cur.mem.MemTotal ?? 0, memUsed: (cur.mem.MemTotal ?? 0) - (cur.mem.MemAvailable ?? 0),
    swapTotal: cur.mem.SwapTotal ?? 0, swapUsed: (cur.mem.SwapTotal ?? 0) - (cur.mem.SwapFree ?? 0),
    disk: cur.disk, svc: cur.svc, tcp: cur.tcp, c443: cur.c443, c9001: cur.c9001,
    rxTotal: cur.rx, txTotal: cur.tx, rxRate: null, txRate: null, cpuPct: null,
  }
  if (prev && cur.t > prev.t) {
    const dt = cur.t - prev.t
    if (cur.rx >= prev.rx) v.rxRate = (cur.rx - prev.rx) / dt
    if (cur.tx >= prev.tx) v.txRate = (cur.tx - prev.tx) / dt
    if (cur.cpu && prev.cpu && cur.cpu.total > prev.cpu.total) {
      v.cpuPct = 100 * (1 - (cur.cpu.idle - prev.cpu.idle) / (cur.cpu.total - prev.cpu.total))
    }
  }
  return v
}

/** IP 备注：最长前缀优先。 */
export function labelFor(ip, labels) {
  if (!ip) return null
  let best = null
  for (const p of Object.keys(labels)) if (ip.startsWith(p) && (!best || p.length > best.length)) best = p
  return best ? labels[best] : null
}
