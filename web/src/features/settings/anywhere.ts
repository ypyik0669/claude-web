// 设置 → 手机与其它电脑 → 在外面也能用 (spec 2026-10-01 §10): the words for a link and for the brokers' state, the
// recent connections, and the checks of the lists edited under 更多选项. Pure; RemoteSection.tsx / AnywhereMore.tsx draw it.
import type { AnywhereRecent, AnywhereStatus, DeviceInfo, LinkKind } from '@shared';
import { MAX_LIST_ENTRIES, isStunUrl, type BrokerDef } from '@anywhere';
import { agoText } from '@/features/home/model';

const KIND_TEXT: Record<LinkKind, string> = { 'p2p-v6': '直连 · IPv6', 'p2p-v4': '直连', relay: '慢速转发' };

export function linkKindText(kind: LinkKind): string {
  return KIND_TEXT[kind] ?? kind;
}

/** A device row's 最近一次: 「直连 · IPv6 · 3 分钟前」 / 「慢速转发 · 3 分钟前」 / 「没连上：<原因>」. */
export function lastLinkText(e: AnywhereRecent, now = Date.now()): string {
  if (!e.ok) return e.error ? `没连上：${e.error}` : '没连上';
  const time = agoText(e.at, now);
  return e.kind ? `${linkKindText(e.kind)} · ${time}` : time;
}

/** The newest connection of this device (`recent` is newest first). */
export function deviceLastLink(deviceId: string, recent: readonly AnywhereRecent[] | undefined): AnywhereRecent | undefined {
  return recent?.find((e) => e.deviceId === deviceId);
}

/**
 * A device's address as shown in its row: none for loopback. Every phone that comes in through 在外面也能用 reaches
 * the listener from 127.0.0.1 (the bridge is on this machine), so that address says nothing about the phone; its row
 * shows how it last connected instead.
 */
export function shownIp(ip: string | undefined): string {
  const a = (ip ?? '').trim().replace(/^::ffff:/i, '');
  if (!a || /^127\./.test(a) || a === '::1' || a === 'localhost') return '';
  return a;
}

export type LineTone = 'ok' | 'err' | 'wait' | 'off';

/** The one line under the 在外面也能用 switch; none while remote access is off (the switch says to turn it on). */
export function anywhereLine(o: { enabled: boolean; running: boolean; settingOn: boolean; anywhere: AnywhereStatus | undefined }): { text: string; tone: LineTone } | null {
  if (!o.enabled) return null;
  if (!o.settingOn) return { text: '关着：手机只能在同一个 Wi-Fi 里连这台电脑', tone: 'off' };
  if (!o.running) return { text: '远程访问没在运行，在外面也连不上', tone: 'err' };
  const a = o.anywhere;
  if (!a?.on) return { text: '正在连接牵线服务器…', tone: 'wait' };
  if (!a.brokers.length) return { text: '没有牵线服务器：在下面「更多选项」里添加，或恢复默认', tone: 'err' };
  if (a.brokers.some((b) => b.ok)) return { text: '可以从外面连', tone: 'ok' };
  if (a.brokers.every((b) => b.error)) return { text: '连不上牵线服务器，检查网络', tone: 'err' };
  return { text: '正在连接牵线服务器…', tone: 'wait' };
}

export interface RecentRow { key: string; who: string; link: string; time: string; why?: string }

export const RECENT_MAX = 20;

/** 最近 20 次连接, newest first: who (配对中 for a phone still pairing), how, when, and why it did not work. */
export function recentRows(recent: readonly AnywhereRecent[] | undefined, devices: readonly DeviceInfo[], now = Date.now()): RecentRow[] {
  const names = new Map(devices.map((d) => [d.id, d.name]));
  return [...(recent ?? [])]
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_MAX)
    .map((e, i) => ({
      key: `${e.at}:${i}`,
      who: e.deviceId ? names.get(e.deviceId) ?? '已删除的设备' : '配对中',
      link: e.kind ? linkKindText(e.kind) : e.ok ? '已连上' : '没连上',
      time: agoText(e.at, now),
      ...(e.ok ? {} : { why: e.error ?? '没连上' }),
    }));
}

/** One broker row being edited; username / password come from the entry it was (the editor does not show them). */
export interface BrokerDraft { name: string; url: string; relay: boolean; username?: string; password?: string }

const isBlank = (r: BrokerDraft) => !r.name.trim() && !r.url.trim();

/** A sentence for the first bad row, or null. Rows left wholly empty are not counted (an added row never filled in). */
export function brokerProblem(rows: readonly BrokerDraft[]): string | null {
  const seen = new Set<string>();
  let n = 0;
  for (const [i, r] of rows.entries()) {
    if (isBlank(r)) continue;
    n++;
    const name = r.name.trim();
    if (!name) return `第 ${i + 1} 行没有名称`;
    const url = r.url.trim();
    if (!/^wss:\/\//i.test(url)) return `第 ${i + 1} 行的地址要以 wss:// 开头（比如 wss://broker.emqx.io:8084/mqtt）`;
    if (!/^wss:\/\/[^\s/]+\S*$/i.test(url)) return `第 ${i + 1} 行的地址不对：wss:// 后面要紧跟服务器名，不能有空格`;
    if (seen.has(name)) return `名称「${name}」重复了`;
    seen.add(name);
  }
  // the PC reads at most this many (core's lists.ts): the rest would be kept here and never used
  if (n > MAX_LIST_ENTRIES) return `最多填 ${MAX_LIST_ENTRIES} 行`;
  return n ? null : '至少要留一个牵线服务器';
}

/** What is saved: trimmed, empty rows out, `relay` only when ticked. */
export function cleanBrokers(rows: readonly BrokerDraft[]): BrokerDef[] {
  return rows.filter((r) => !isBlank(r)).map((r) => {
    const d: BrokerDef = { name: r.name.trim(), url: r.url.trim() };
    if (r.username !== undefined) d.username = r.username;
    if (r.password !== undefined) d.password = r.password;
    if (r.relay) d.relay = true;
    return d;
  });
}

/** STUN rows: stun: / stuns: only (the PC drops anything else, and has no TURN sign-in); empty rows are not counted. */
export function stunProblem(rows: readonly string[]): string | null {
  let n = 0;
  for (const [i, r] of rows.entries()) {
    const s = r.trim();
    if (!s) continue;
    n++;
    if (!isStunUrl(s)) return `第 ${i + 1} 行要以 stun: 开头（比如 stun:stun.cloudflare.com:3478）`;
  }
  return n > MAX_LIST_ENTRIES ? `最多填 ${MAX_LIST_ENTRIES} 行` : null;
}

export function cleanStun(rows: readonly string[]): string[] {
  return rows.map((r) => r.trim()).filter(Boolean);
}

/** The phone page's address: https:// and a folder (ends in /); the QR adds `#p=…` after it. */
export function shellUrlProblem(s: string): string | null {
  const v = s.trim();
  if (!/^https:\/\//i.test(v)) return '手机页面地址要以 https:// 开头';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return '这不是一个能打开的网址';
  }
  if (/\s/.test(v) || u.hash || u.search || v.includes('#')) return '这不是一个能打开的网址：不要带空格、# 或 ?';
  if (!v.endsWith('/')) return '手机页面地址要以 / 结尾';
  return null;
}
