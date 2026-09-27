import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AndroidDevice, AndroidStatus } from '../protocol.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

/** `adb shell` joins its argv into a device-side sh command line, so anything interpolated there must be a plain token. */
function assertPkg(pkg: string) { if (!/^[A-Za-z0-9_.]+$/.test(pkg)) throw new Error(`无效包名：${pkg}`); }

/** Android emulator / device preview through adb: screenshots, input, apk install, logcat. Optional feature; degrades to "adb 未安装". */
export class AndroidService {
  private adbPath: string | null | undefined;
  private emulatorPath: string | null | undefined;

  private sdkRoots(): string[] {
    const out = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
    if (isWin) out.push(path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'));
    else if (process.platform === 'darwin') out.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
    else out.push(path.join(os.homedir(), 'Android', 'Sdk'));
    return out.filter((x): x is string => !!x);
  }

  private find(tool: 'adb' | 'emulator'): string | null {
    const exe = isWin ? `${tool}.exe` : tool;
    for (const root of this.sdkRoots()) {
      const p = path.join(root, tool === 'adb' ? 'platform-tools' : 'emulator', exe);
      if (fs.existsSync(p)) return p;
    }
    for (const d of (process.env.PATH ?? '').split(path.delimiter)) { const p = path.join(d, exe); if (d && fs.existsSync(p)) return p; }
    return null;
  }

  adb(): string | null { if (this.adbPath === undefined) this.adbPath = this.find('adb'); return this.adbPath; }
  emulator(): string | null { if (this.emulatorPath === undefined) this.emulatorPath = this.find('emulator'); return this.emulatorPath; }
  private async run(args: string[], opts: { serial?: string; timeout?: number; maxBuffer?: number } = {}) {
    const adb = this.adb();
    if (!adb) throw new Error('未找到 adb：安装 Android SDK Platform-Tools，或设置 ANDROID_HOME');
    const full = opts.serial ? ['-s', opts.serial, ...args] : args;
    const { stdout } = await execFileAsync(adb, full, { windowsHide: true, timeout: opts.timeout ?? 15_000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024 });
    return String(stdout);
  }

  async status(): Promise<AndroidStatus> {
    const adb = this.adb();
    const emulator = this.emulator();
    let avds: string[] = [];
    if (emulator) { try { const { stdout } = await execFileAsync(emulator, ['-list-avds'], { windowsHide: true, timeout: 10_000 }); avds = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('INFO')); } catch { /* ignore */ } }
    return { adb: adb ?? '', emulator: emulator ?? '', avds, devices: adb ? await this.devices().catch(() => []) : [] };
  }

  async devices(): Promise<AndroidDevice[]> {
    const out = await this.run(['devices', '-l']);
    const list: AndroidDevice[] = [];
    for (const line of out.split(/\r?\n/).slice(1)) {
      const m = /^(\S+)\s+(device|offline|unauthorized|emulator)\b(.*)$/.exec(line.trim());
      if (!m) continue;
      const props: Record<string, string> = {};
      for (const kv of m[3].trim().split(/\s+/)) { const [k, v] = kv.split(':'); if (k && v) props[k] = v; }
      list.push({ serial: m[1], state: m[2] as any, model: props.model ?? '', product: props.product ?? '', emulator: m[1].startsWith('emulator-') });
    }
    return list;
  }

  /** PNG screenshot as base64. */
  async screenshot(serial: string): Promise<{ png: string; width: number; height: number }> {
    const adb = this.adb();
    if (!adb) throw new Error('未找到 adb');
    const buf = await new Promise<Buffer>((res, rej) => {
      const chunks: Buffer[] = [];
      const p = spawn(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { windowsHide: true });
      // cleared on exit: the panel polls every 0.9s, so a dangling 15s timer per shot piled up
      const timer = setTimeout(() => { p.kill(); rej(new Error('screencap 超时')); }, 15_000);
      p.stdout.on('data', (d: Buffer) => chunks.push(d));
      p.on('error', (e) => { clearTimeout(timer); rej(e); });
      p.on('close', (code) => { clearTimeout(timer); if (code === 0) res(Buffer.concat(chunks)); else rej(new Error(`screencap 退出 ${code}`)); });
    });
    // PNG IHDR: width/height at bytes 16..24
    const width = buf.length > 24 ? buf.readUInt32BE(16) : 0;
    const height = buf.length > 24 ? buf.readUInt32BE(20) : 0;
    return { png: buf.toString('base64'), width, height };
  }

  async input(serial: string, i: { kind: 'tap'; x: number; y: number } | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms?: number } | { kind: 'key'; code: string | number } | { kind: 'text'; text: string }) {
    switch (i.kind) {
      case 'tap': await this.run(['shell', 'input', 'tap', String(Math.round(i.x)), String(Math.round(i.y))], { serial }); break;
      case 'swipe': await this.run(['shell', 'input', 'swipe', String(Math.round(i.x1)), String(Math.round(i.y1)), String(Math.round(i.x2)), String(Math.round(i.y2)), String(i.ms ?? 300)], { serial }); break;
      case 'key': if (!/^\w+$/.test(String(i.code))) throw new Error('无效按键'); await this.run(['shell', 'input', 'keyevent', String(i.code)], { serial }); break;
      case 'text': await this.run(['shell', 'input', 'text', i.text.replace(/ /g, '%s').replace(/([()<>|;&*~"'\\$])/g, '\\$1')], { serial }); break;
    }
  }

  async install(serial: string, apk: string) { return this.run(['install', '-r', apk], { serial, timeout: 180_000 }); }
  async logcat(serial: string, lines = 200, filter?: string) {
    const out = await this.run(['logcat', '-d', '-t', String(lines), '-v', 'time', ...(filter ? [filter] : [])], { serial, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    return out.split(/\r?\n/).slice(-lines).join('\n');
  }
  async clearLogcat(serial: string) { await this.run(['logcat', '-c'], { serial }); }
  async launchApp(serial: string, pkg: string) { assertPkg(pkg); return this.run(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { serial }); }
  async packages(serial: string) { const out = await this.run(['shell', 'pm', 'list', 'packages', '-3'], { serial }); return out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort(); }
  startEmulator(avd: string) {
    const emu = this.emulator();
    if (!emu) throw new Error('未找到 emulator（Android SDK 的 emulator 目录）');
    const p = spawn(emu, ['-avd', avd, '-netdelay', 'none', '-netspeed', 'full'], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', (e) => console.error('[android] emulator:', e.message)); // EACCES etc. arrive async; unhandled 'error' crashes the server
    p.unref();
    return { pid: p.pid ?? 0 };
  }
}
