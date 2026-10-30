// Headless duty mode: register the claude-web server as a per-user service so bots keep running with no window.
// Windows: a logon task (Task Scheduler) → wscript runs duty.vbs hidden → duty.cmd sets the env and starts the server.
// macOS: a LaunchAgent. Linux: a systemd user unit.
// No secret (CLAUDE_WEB_TOKEN etc.) ever goes into these files.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../files/service.js';
import { tr } from '../i18n/index.js';

export interface DutyPlan {
  platform: 'win32' | 'darwin' | 'linux';
  files: { path: string; content: string }[];
  commands: string[];
  uninstall: string[];
}

export interface DutyPlanOptions {
  platform: NodeJS.Platform;
  nodeBin: string;
  serverEntry: string;
  dataDir: string;
  port: number;
  home: string;
  /** extra service environment (ELECTRON_RUN_AS_NODE, CLAUDE_WEB_DIST, …) */
  env?: Record<string, string>;
  /** win32: DOMAIN\user the logon trigger fires for (a trigger for any user needs admin) */
  user?: string;
}

const TASK = 'ClaudeWebDuty';
const LABEL = 'app.claude-web.duty';
const UNIT = 'claude-web-duty';
const DEFAULT_PORT = 3090;

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The files to write and the commands to run for this platform. Pure. */
export function dutyPlan(o: DutyPlanOptions): DutyPlan {
  // the phone / remote has to find the server: never a random port
  const port = o.port > 0 ? o.port : DEFAULT_PORT;
  const env: Record<string, string> = { CLAUDE_WEB_DIR: o.dataDir, PORT: String(port), CLAUDE_WEB_STANDALONE: '1', ...o.env };
  delete env.CLAUDE_WEB_TOKEN;

  if (o.platform === 'win32') {
    const p = path.win32;
    const dir = p.join(o.dataDir, 'duty');
    const cmdPath = p.join(dir, 'duty.cmd');
    const vbsPath = p.join(dir, 'duty.vbs');
    const xmlPath = p.join(dir, 'duty.xml');
    const log = p.join(o.dataDir, 'duty.log');
    const pct = (s: string) => s.replace(/%/g, '%%');
    const cmd = [
      '@echo off',
      // read the rest of this file as UTF-8 (user names with non-ASCII letters)
      'chcp 65001 >nul',
      ...Object.entries(env).map(([k, v]) => `set "${k}=${pct(v)}"`),
      `"${pct(o.nodeBin)}" "${pct(o.serverEntry)}" >> "${pct(log)}" 2>&1`,
      '',
    ].join('\r\n');
    // window style 0 = hidden, False = don't wait
    const vbs = `CreateObject("WScript.Shell").Run """${cmdPath}""", 0, False\r\n`;
    const user = o.user ? `<UserId>${xmlEsc(o.user)}</UserId>` : '';
    const xml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo><Description>Claude Web duty: runs the server in the background so bots keep working</Description></RegistrationInfo>',
      `  <Triggers><LogonTrigger><Enabled>true</Enabled>${user}</LogonTrigger></Triggers>`,
      `  <Principals><Principal id="Author">${user}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <Enabled>true</Enabled>',
      '  </Settings>',
      `  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>${xmlEsc(`"${vbsPath}"`)}</Arguments></Exec></Actions>`,
      '</Task>',
      '',
    ].join('\r\n');
    return {
      platform: 'win32',
      files: [
        { path: cmdPath, content: cmd },
        { path: vbsPath, content: vbs },
        { path: xmlPath, content: xml },
      ],
      // /XML rather than /SC ONLOGON /TR: a plain ONLOGON trigger is for every user and needs admin ("Access is denied")
      commands: [`schtasks /Create /TN "${TASK}" /XML "${xmlPath}" /F`],
      uninstall: [`schtasks /Delete /TN "${TASK}" /F`],
    };
  }

  if (o.platform === 'darwin') {
    const p = path.posix;
    const plist = p.join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const log = p.join(o.dataDir, 'duty.log');
    const s = (v: string) => `<string>${xmlEsc(v)}</string>`;
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key>${s(LABEL)}`,
      `  <key>ProgramArguments</key><array>${s(o.nodeBin)}${s(o.serverEntry)}</array>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      ...Object.entries(env).map(([k, v]) => `    <key>${xmlEsc(k)}</key>${s(v)}`),
      '  </dict>',
      `  <key>StandardOutPath</key>${s(log)}`,
      `  <key>StandardErrorPath</key>${s(log)}`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return {
      platform: 'darwin',
      files: [{ path: plist, content }],
      commands: [`launchctl load -w "${plist}"`],
      uninstall: [`launchctl unload -w "${plist}"`],
    };
  }

  const p = path.posix;
  const unit = p.join(o.home, '.config', 'systemd', 'user', `${UNIT}.service`);
  // systemd: % starts a specifier; inside "…" backslash and quote are escapes
  const q = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  const content = [
    '[Unit]',
    'Description=Claude Web duty (bots keep running with no window)',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${q(o.nodeBin)} ${q(o.serverEntry)}`,
    'Restart=always',
    'RestartSec=5',
    ...Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  return {
    platform: 'linux',
    files: [{ path: unit, content }],
    commands: ['systemctl --user daemon-reload', `systemctl --user enable --now ${UNIT}`],
    uninstall: [`systemctl --user disable --now ${UNIT}`],
  };
}

function run(command: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, { shell: true, windowsHide: true });
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: out + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out: out.trim() }));
  });
}

/** where dist's bots/duty.js finds the server entry (dist/index.js) */
function serverEntry() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
}

function currentPlan(): DutyPlan {
  const env: Record<string, string> = {};
  // in the desktop app process.execPath is Electron: run it as plain node (it can still read app.asar, node can't)
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  for (const k of ['CLAUDE_WEB_DIST', 'CLAUDE_WEB_SIDECARS', 'CLAUDE_WEB_ENGINES']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  const user = process.platform === 'win32' ? [process.env.USERDOMAIN, os.userInfo().username].filter(Boolean).join('\\') : undefined;
  return dutyPlan({
    platform: process.platform,
    nodeBin: process.execPath,
    serverEntry: serverEntry(),
    dataDir: dataDir(),
    port: Number(process.env.PORT) || DEFAULT_PORT,
    home: os.homedir(),
    env,
    user,
  });
}

async function writeFile(file: string, content: string) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Task Scheduler XML says UTF-16; wscript reads a .vbs as ANSI unless it is UTF-16 with a BOM
  if (/\.(xml|vbs)$/i.test(file)) await fs.promises.writeFile(file, Buffer.from('\ufeff' + content, 'utf16le'));
  else await fs.promises.writeFile(file, content, 'utf8');
}

/** Turn the duty service on (write files, register) or off (unregister, delete files). */
export async function installDuty(on: boolean): Promise<{ ok: boolean; detail: string }> {
  const plan = currentPlan();
  const lines: string[] = [];
  if (on) {
    if (!fs.existsSync(serverEntry())) {
      return { ok: false, detail: tr('找不到服务端入口 {path}（开发模式下先 npm run build）', { path: serverEntry() }) };
    }
    // already registered: take the old one down first so the new files take effect
    if (await dutyInstalled()) for (const c of plan.uninstall) await run(c);
    try {
      for (const f of plan.files) await writeFile(f.path, f.content);
    } catch (e) {
      return { ok: false, detail: tr('写入值班文件失败：{error}', { error: (e as Error).message }) };
    }
    for (const c of plan.commands) {
      const r = await run(c);
      if (r.code !== 0) {
        lines.push(`${c}\n${r.out}`);
        return { ok: false, detail: tr('注册值班服务失败：{detail}', { detail: lines.join('\n') }) };
      }
    }
    return { ok: true, detail: tr('已注册值班服务，登录后自动在后台运行（日志：{log}）', { log: path.join(dataDir(), 'duty.log') }) };
  }
  let ok = true;
  const registered = await dutyInstalled();
  for (const c of registered ? plan.uninstall : []) {
    const r = await run(c);
    if (r.code !== 0) {
      ok = false;
      lines.push(`${c}\n${r.out}`);
    }
  }
  for (const f of plan.files) await fs.promises.rm(f.path, { force: true }).catch(() => {});
  if (plan.platform === 'linux') await run('systemctl --user daemon-reload');
  return ok
    ? { ok: true, detail: tr('已取消值班服务') }
    : { ok: false, detail: tr('取消值班服务时出错：{detail}', { detail: lines.join('\n') }) };
}

/** Is the duty service registered? */
export async function dutyInstalled(): Promise<boolean> {
  if (process.platform === 'win32') return (await run(`schtasks /Query /TN "${TASK}"`)).code === 0;
  const plan = currentPlan();
  return fs.existsSync(plan.files[0].path);
}
