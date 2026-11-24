#!/usr/bin/env node
// VPS 实时监控（本机自用）：两条 ssh 长连接（跟日志 / 采系统数据）→ 状态 → SSE 推给页面。
// 对 VPS 只读。HTTP 只听 127.0.0.1。
//   node scripts/vps-monitor/server.mjs [--port 3197] [--host root@198.44.111.28] [--key ~/.ssh/cw_oracle]
//                                       [--log /var/log/mosquitto/mosquitto.log] [--replay 2000]
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLine, createState, applyEvent, snapshot, parseSysBlock, sysView, SYS_SCRIPT, logScript } from './parse.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const LABELS_FILE = path.join(DIR, 'labels.json')
const FEED_KEEP = 4000

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const PORT = Number(arg('port', 3197))
const HOST = arg('host', 'root@198.44.111.28')
const KEY = arg('key', path.join(os.homedir(), '.ssh', 'cw_oracle')).replace(/^~(?=[\\/])/, os.homedir())
const LOG = arg('log', '/var/log/mosquitto/mosquitto.log')
const REPLAY = Math.max(0, Number(arg('replay', 2000)) || 0)
if (!/^[\w./-]+$/.test(LOG)) { console.error('--log 只能是普通路径'); process.exit(1) }

const SSH_ARGS = [
  '-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-T', HOST,
]

// ───────── 状态 ─────────
let state = createState()
let feed = [] // 事件流的最近 FEED_KEEP 条
let sys = null
let labels = loadLabels()
const link = {
  log: { state: 'connecting', since: Date.now(), err: null, tries: 0 },
  sys: { state: 'connecting', since: Date.now(), err: null, tries: 0 },
}
let skew = 0 // VPS 时钟 − 本机时钟（秒），由系统采样里的 date 得到
const vpsNow = () => Date.now() / 1000 + skew

const pages = new Set()
function send(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
}
function broadcast(event, data) {
  if (!pages.size) return
  const chunk = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
  for (const res of pages) res.write(chunk)
}
const snap = () => ({ ...snapshot(state, Math.max(state.now, Math.floor(vpsNow()))), link, skew, host: HOST, replay: REPLAY })
const initPayload = () => ({ snapshot: snap(), feed, sys, labels })

setInterval(() => {
  // 每秒一份状态，没有新日志也推（「没人收到」要等 2 秒才判定）。
  if (!replaying) broadcast('snapshot', snap())
}, 1000).unref()

function setLink(which, st, err) {
  const l = link[which]
  if (l.state !== st) l.since = Date.now()
  l.state = st
  if (err !== undefined) l.err = err
  if (st === 'ok') { l.tries = 0; l.err = null }
  if (!replaying) broadcast('snapshot', snap())
}

// ───────── ssh 长连接（断了退避重连）─────────
function lineSplitter(onLine) {
  let buf = ''
  return (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  }
}

const children = new Set()
let stopping = false

function longSsh(which, remoteArgs, { stdin, onStart, onLine }) {
  const l = link[which]
  const start = () => {
    if (stopping) return
    onStart()
    const child = spawn('ssh', [...SSH_ARGS, ...remoteArgs], { windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    children.add(child)
    let lastErr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', lineSplitter(onLine))
    child.stderr.on('data', lineSplitter((s) => { if (s.trim() && !/^tail: /.test(s)) lastErr = s.trim().slice(0, 200) }))
    if (stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
    let done = false
    const finish = (why) => {
      if (done) return
      done = true
      children.delete(child)
      if (stopping) return
      l.tries++
      const wait = Math.min(30000, 1000 * 2 ** Math.min(l.tries - 1, 5))
      setLink(which, 'retry', lastErr || why)
      console.error(`[${which}] ssh 断了（${lastErr || why}），${wait / 1000}s 后重连`)
      setTimeout(start, wait)
    }
    child.on('error', (e) => finish(e.message))
    child.on('close', (code, sig) => finish(sig ? '信号 ' + sig : '退出码 ' + code))
  }
  start()
}

// 日志：先回放最近 N 行重建状态（不逐条推），之后实时。
// 远端先报「@@LOG <文件行数>」，收够 min(行数, N) 行就算回放完；10 秒没收够也算。
let replaying = true
let replayLeft = Infinity
let replayTimer = null
function endReplay() {
  if (!replaying) return
  replaying = false
  clearTimeout(replayTimer)
  setLink('log', 'ok')
  broadcast('init', initPayload())
  console.error(`[log] 回放完：在线 ${state.clients.size}，房间 ${state.rooms.size}，事件 ${feed.length}`)
}

longSsh('log', ['sh'], {
  stdin: logScript(LOG, REPLAY),
  onStart() {
    // 每次重连都会再回放一遍，所以从空状态开始，免得数重。
    state = createState()
    feed = []
    replaying = true
    replayLeft = Infinity
    clearTimeout(replayTimer)
  },
  onLine(line) {
    if (replaying && replayLeft === Infinity) {
      const m = /^@@LOG (\d+)/.exec(line)
      if (!m) return
      replayLeft = Math.min(Number(m[1]), REPLAY)
      replayTimer = setTimeout(endReplay, 10000)
      if (replayLeft <= 0) endReplay()
      return
    }
    const items = applyEvent(state, parseLine(line))
    if (items.length) {
      feed.push(...items)
      if (feed.length > FEED_KEEP + 500) feed.splice(0, feed.length - FEED_KEEP)
    }
    if (replaying) {
      if (--replayLeft <= 0) endReplay()
    } else {
      for (const it of items) broadcast('ev', it)
    }
  },
})

// 系统数据：远端 sh 跑一个每 3 秒输出一块的循环（脚本走 stdin，免得被 Windows 的引号规则弄坏）。
let block = null
let prevSample = null
let lastSysAt = 0
longSsh('sys', ['sh'], {
  stdin: SYS_SCRIPT,
  onStart() { block = null; prevSample = null },
  onLine(line) {
    if (line.startsWith('@@B')) block = [line]
    else if (line.startsWith('@@E') && block) {
      const cur = parseSysBlock(block)
      block = null
      if (cur.t) skew = cur.t - Date.now() / 1000
      sys = sysView(cur, prevSample)
      prevSample = cur
      lastSysAt = Date.now()
      if (link.sys.state !== 'ok') setLink('sys', 'ok')
      broadcast('sys', sys)
    } else if (block) block.push(line)
  },
})

// ───────── IP 备注 ─────────
function loadLabels() {
  try {
    const j = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}
function setLabel(prefix, name) {
  if (typeof prefix !== 'string' || !/^[0-9a-fA-F.:]{1,45}$/.test(prefix)) throw new Error('IP 前缀只能是数字、点、冒号、a-f')
  if (typeof name !== 'string') throw new Error('name 要是字符串')
  name = name.trim().slice(0, 60)
  const next = { ...labels }
  if (name) next[prefix] = name
  else delete next[prefix]
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)))
  fs.writeFileSync(LABELS_FILE, JSON.stringify(sorted, null, 2) + '\n')
  labels = sorted
  broadcast('labels', labels)
}

// ───────── HTTP ─────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  // 只认本机的 Host，挡掉 DNS 重绑定；POST 再要求同源。
  const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')
  if (!hostOk) { res.writeHead(403).end('forbidden'); return }

  if (req.method === 'GET' && url.pathname === '/') {
    fs.readFile(path.join(DIR, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500).end(String(err)); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(buf)
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write('retry: 2000\n\n')
    send(res, 'init', initPayload())
    pages.add(res)
    req.on('close', () => pages.delete(res))
    return
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(initPayload()))
    return
  }
  if (req.method === 'POST' && url.pathname === '/labels') {
    const origin = req.headers.origin
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { res.writeHead(403).end('forbidden'); return }
    if (!/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415).end('要 application/json'); return }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
    req.on('end', () => {
      try {
        const j = JSON.parse(body)
        setLabel(j.prefix, j.name ?? '')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(labels))
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(e.message)
      }
    })
    return
  }
  res.writeHead(404).end('not found')
})

// 系统采样断流（ssh 还活着但没数据）也算不正常。
setInterval(() => {
  if (link.sys.state === 'ok' && Date.now() - lastSysAt > 15000) setLink('sys', 'retry', '15 秒没有采样')
}, 5000).unref()

server.on('error', (e) => { console.error('HTTP 起不来：' + e.message); shutdown(1) })
server.listen(PORT, '127.0.0.1', () => {
  console.error(`VPS 监控：http://127.0.0.1:${PORT}/  （${HOST}，回放 ${REPLAY} 行）`)
})

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) { try { c.kill() } catch {} }
  for (const res of pages) { try { res.end() } catch {} }
  server.close()
  setTimeout(() => process.exit(code), 300).unref()
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('SIGHUP', () => shutdown(0))
