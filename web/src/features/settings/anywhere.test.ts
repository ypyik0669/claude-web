import { describe, expect, it } from 'vitest';
import type { AnywhereRecent, AnywhereStatus } from '@shared';
import {
  anywhereLine, brokerProblem, cleanBrokers, deviceLastLink, lastLinkText, linkKindText, recentRows, shellUrlProblem,
  shownIp, stunProblem,
} from './anywhere';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const min = 60_000;

function st(brokers: AnywhereStatus['brokers'], on = true): AnywhereStatus {
  return { on, brokers, sessions: [], recent: [], shellUrl: 'https://ypyik0669.github.io/claude-web/', keepAwake: true };
}

describe('the last link of a device, in words', () => {
  it('each link kind', () => {
    expect(linkKindText('p2p-v6')).toBe('直连 · IPv6');
    expect(linkKindText('p2p-v4')).toBe('直连');
    expect(linkKindText('relay')).toBe('慢速转发');
  });

  it('直连 · IPv6 · 3 分钟前 / 直连 · 3 分钟前 / 慢速转发 · 3 分钟前 / 没连上：<原因>', () => {
    const at = NOW - 3 * min;
    expect(lastLinkText({ at, deviceId: 'a', ok: true, kind: 'p2p-v6' }, NOW)).toBe('直连 · IPv6 · 3 分钟前');
    expect(lastLinkText({ at, deviceId: 'a', ok: true, kind: 'p2p-v4' }, NOW)).toBe('直连 · 3 分钟前');
    expect(lastLinkText({ at, deviceId: 'a', ok: true, kind: 'relay' }, NOW)).toBe('慢速转发 · 3 分钟前');
    expect(lastLinkText({ at, deviceId: 'a', ok: false, error: '手机打了招呼，但通道没有建立起来' }, NOW)).toBe('没连上：手机打了招呼，但通道没有建立起来');
    expect(lastLinkText({ at, deviceId: 'a', ok: false }, NOW)).toBe('没连上');
    expect(lastLinkText({ at: NOW - 10_000, ok: true, kind: 'relay' }, NOW)).toBe('慢速转发 · 刚刚');
  });

  it('the newest entry of that device (recent is newest first)', () => {
    const recent: AnywhereRecent[] = [
      { at: 3, ok: true, kind: 'relay' },
      { at: 2, deviceId: 'b', ok: true, kind: 'p2p-v4' },
      { at: 1, deviceId: 'a', ok: false, error: 'x' },
      { at: 0, deviceId: 'b', ok: false, error: 'y' },
    ];
    expect(deviceLastLink('b', recent)).toEqual(recent[1]);
    expect(deviceLastLink('a', recent)).toEqual(recent[2]);
    expect(deviceLastLink('c', recent)).toBeUndefined();
    expect(deviceLastLink('a', undefined)).toBeUndefined();
  });

  it('no loopback address in a device row: through the bridge every phone comes from 127.0.0.1', () => {
    expect(shownIp('127.0.0.1')).toBe('');
    expect(shownIp('127.3.4.5')).toBe('');
    expect(shownIp('::1')).toBe('');
    expect(shownIp('::ffff:127.0.0.1')).toBe('');
    expect(shownIp(undefined)).toBe('');
    expect(shownIp('')).toBe('');
    expect(shownIp('192.168.1.23')).toBe('192.168.1.23');
    expect(shownIp('fe80::1')).toBe('fe80::1');
  });
});

describe('the status line under 在外面也能用', () => {
  const on = { enabled: true, running: true, settingOn: true };
  it('none when remote access is off (the switch says to turn that on first)', () => {
    expect(anywhereLine({ ...on, enabled: false, anywhere: st([], false) })).toBeNull();
  });
  it('switched off: phones only on the same Wi-Fi', () => {
    expect(anywhereLine({ ...on, settingOn: false, anywhere: st([], false) })).toEqual({ text: '关着：手机只能在同一个 Wi-Fi 里连这台电脑', tone: 'off' });
  });
  it('remote access on but not running', () => {
    expect(anywhereLine({ ...on, running: false, anywhere: st([], false) })?.tone).toBe('err');
  });
  it('one broker up is enough: 可以从外面连', () => {
    expect(anywhereLine({ ...on, anywhere: st([{ name: 'a', ok: false, error: 'x' }, { name: 'b', ok: true }]) })).toEqual({ text: '可以从外面连', tone: 'ok' });
  });
  it('every broker failed: 连不上牵线服务器，检查网络', () => {
    expect(anywhereLine({ ...on, anywhere: st([{ name: 'a', ok: false, error: 'ECONNREFUSED' }, { name: 'b', ok: false, error: 'timeout' }]) })).toEqual({ text: '连不上牵线服务器，检查网络', tone: 'err' });
  });
  it('still connecting (no error yet), or starting: says so instead of either', () => {
    expect(anywhereLine({ ...on, anywhere: st([{ name: 'a', ok: false, error: 'x' }, { name: 'b', ok: false }]) })).toEqual({ text: '正在连接牵线服务器…', tone: 'wait' });
    expect(anywhereLine({ ...on, anywhere: st([], false) })).toEqual({ text: '正在连接牵线服务器…', tone: 'wait' });
    expect(anywhereLine({ ...on, anywhere: undefined })).toEqual({ text: '正在连接牵线服务器…', tone: 'wait' });
  });
  it('no broker in the list', () => {
    expect(anywhereLine({ ...on, anywhere: st([]) })?.text).toMatch(/^没有牵线服务器/);
  });
});

describe('recent connections (更多选项)', () => {
  it('newest first, at most 20: the device (配对中 without one), the link, the time, the reason', () => {
    const recent: AnywhereRecent[] = [
      { at: NOW - 1 * min, deviceId: 'a', ok: true, kind: 'p2p-v6' },
      { at: NOW - 5 * min, ok: true, kind: 'relay' },
      { at: NOW - 2 * min, deviceId: 'gone', ok: false, error: '同时连进来的太多，较早的一次被放弃了' },
      { at: NOW - 9 * min, deviceId: 'a', ok: false, kind: 'p2p-v4', error: '版本不一致' },
    ];
    const rows = recentRows(recent, [{ id: 'a', name: 'iPhone', createdAt: 0, lastSeenAt: 0 }], NOW);
    expect(rows.map((r) => [r.who, r.link, r.time, r.why])).toEqual([
      ['iPhone', '直连 · IPv6', '1 分钟前', undefined],
      ['已删除的设备', '没连上', '2 分钟前', '同时连进来的太多，较早的一次被放弃了'],
      ['配对中', '慢速转发', '5 分钟前', undefined],
      ['iPhone', '直连', '9 分钟前', '版本不一致'],
    ]);
    expect(recentRows([{ at: NOW, ok: true }], [], NOW)[0].link).toBe('已连上');
    const many = Array.from({ length: 25 }, (_, i): AnywhereRecent => ({ at: NOW - i * min, ok: true, kind: 'relay' }));
    expect(recentRows(many, [], NOW)).toHaveLength(20);
    expect(recentRows(undefined, [], NOW)).toEqual([]);
  });
});

describe('editing the lists in 更多选项: a bad value is a sentence, not saved', () => {
  it('brokers: wss:// only, a name each, no name twice, at least one; blank rows are dropped', () => {
    const good = { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt', relay: false };
    expect(brokerProblem([good])).toBeNull();
    expect(brokerProblem([good, { name: '', url: '', relay: false }])).toBeNull();
    expect(brokerProblem([])).toMatch(/至少/);
    expect(brokerProblem([{ name: ' ', url: ' ', relay: true }])).toMatch(/至少/);
    expect(brokerProblem([good, { name: 'x', url: 'ws://a/mqtt', relay: false }])).toMatch(/第 2 行.*wss:\/\//);
    expect(brokerProblem([good, { name: 'x', url: 'http://a/mqtt', relay: false }])).toMatch(/wss:\/\//);
    expect(brokerProblem([good, { name: 'x', url: 'wss://a b', relay: false }])).toMatch(/第 2 行/);
    expect(brokerProblem([good, { name: '', url: 'wss://a/mqtt', relay: false }])).toMatch(/第 2 行.*名称/);
    expect(brokerProblem([good, { ...good, url: 'wss://other/mqtt' }])).toMatch(/emqx.*重复/);
  });

  it('cleanBrokers: trimmed, blank rows out, relay only when ticked, the sign-in kept', () => {
    expect(cleanBrokers([
      { name: ' shiftr ', url: ' wss://public.cloud.shiftr.io ', relay: true, username: 'public', password: 'public' },
      { name: '', url: '', relay: false },
      { name: 'b', url: 'wss://b/mqtt', relay: false },
    ])).toEqual([
      { name: 'shiftr', url: 'wss://public.cloud.shiftr.io', relay: true, username: 'public', password: 'public' },
      { name: 'b', url: 'wss://b/mqtt' },
    ]);
  });

  it('STUN: stun: / stuns: addresses only (the PC drops anything else); blank rows are dropped', () => {
    expect(stunProblem(['stun:stun.cloudflare.com:3478', 'stuns:x.example:5349', ''])).toBeNull();
    expect(stunProblem([])).toBeNull();
    expect(stunProblem(['stun:a:3478', 'turn:a:3478'])).toMatch(/第 2 行.*stun:/);
    expect(stunProblem(['stun.cloudflare.com:3478'])).toMatch(/第 1 行/);
    expect(stunProblem(['stun:a b'])).toMatch(/第 1 行/);
  });

  it('at most 16 rows each: the PC reads no more (blank rows do not count)', () => {
    const brokers = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, url: `wss://b${i}/mqtt`, relay: false }));
    expect(brokerProblem([...brokers(16), { name: '', url: '', relay: false }])).toBeNull();
    expect(brokerProblem(brokers(17))).toMatch(/最多填 16 行/);
    const stun = (n: number) => Array.from({ length: n }, (_, i) => `stun:s${i}:3478`);
    expect(stunProblem([...stun(16), ''])).toBeNull();
    expect(stunProblem(stun(17))).toMatch(/最多填 16 行/);
  });

  it('the phone page: https://, ending in /', () => {
    expect(shellUrlProblem('https://ypyik0669.github.io/claude-web/')).toBeNull();
    expect(shellUrlProblem(' https://me.example/shell/ ')).toBeNull();
    expect(shellUrlProblem('http://me.example/shell/')).toMatch(/https:\/\//);
    expect(shellUrlProblem('https://me.example/shell')).toMatch(/\/ 结尾/);
    expect(shellUrlProblem('https://me.example/shell/#x/')).toMatch(/网址/);
    expect(shellUrlProblem('https://me.example/a b/')).toMatch(/网址/);
    expect(shellUrlProblem('')).toMatch(/https:\/\//);
  });
});
