// Headless duty mode: register the claude-web server as a per-user service so bots keep running with no window.
// Windows: a logon task (Task Scheduler) → wscript runs duty.vbs hidden; the vbs loops (restart 30 s after the server
//   ends, stop when duty.stop appears or duty.cmd is gone) and each round runs duty.cmd, which sets the env and starts the server.
//   The server writes its pid to duty/duty.pid so "off" can kill its tree (the task doesn't track it).
// macOS: a LaunchAgent (KeepAlive, ThrottleInterval 30). Linux: a systemd user unit (Restart=always, RestartSec=30).
// Every loop waits 30 s between starts: the duty server exits at once (BUSY_EXIT, server-lock.ts) while the app serves
// the same dir, and when an app asks it to step down.
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
  /** darwin / linux: run detached by the duty server itself — reload with the new files (stops the caller, so it is the last step) */
  selfRestart: string;
  /** darwin / linux: run detached by the duty server itself — unregister, delete the file, stop (the stop comes last) */
  selfStop: string;
  /** win32: the pid the server writes, and the marker that ends the vbs loop */
  pidFile?: string;
  stopFile?: string;
}

export interface DutyPlanOptions {
  platform: NodeJS.Platform;
  nodeBin: string;
  serverEntry: string;
  dataDir: string;
  port: number;
  home: string;
  /** extra service environment (ELECTRON_RUN_AS_NODE, CLAUDE_WEB_DIST, PATH, …) */
  env?: Record<string, string>;
  /** win32: DOMAIN\user the logon trigger fires for (a trigger for any user needs admin) */
  user?: string;
}

/** a path or env value the service files can't carry safely */
export class DutyCharError extends Error {
  constructor(readonly value: string) {
    super(`unsupported character in ${value}`);
  }
}

const TASK = 'ClaudeWebDuty';
const LABEL = 'app.claude-web.duty';
const UNIT = 'claude-web-duty';
const DEFAULT_PORT = 3090;

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** POSIX shell single quotes */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function check(values: string[], bad: RegExp) {
  for (const v of values) if (bad.test(v)) throw new DutyCharError(v);
}

/** The files to write and the commands to run for this platform. Pure; throws DutyCharError on values it can't quote. */
export function dutyPlan(o: DutyPlanOptions): DutyPlan {
  // the phone / remote has to find the server: never a random port
  const port = o.port > 0 ? o.port : DEFAULT_PORT;
  const env: Record<string, string> = { ...o.env, CLAUDE_WEB_DIR: o.dataDir, PORT: String(port), CLAUDE_WEB_STANDALONE: '1', CLAUDE_WEB_DUTY: '1' };
  delete env.CLAUDE_WEB_TOKEN;
  // " ends a quoted value in every one of these formats; a newline ends the line
  check([o.nodeBin, o.serverEntry, o.dataDir, o.home, ...Object.keys(env), ...Object.values(env)], /["\r\n]/);

  if (o.platform === 'win32') {
    // WScript.Shell.Run, cmd /c and Task Scheduler arguments all expand %VAR% with no way to escape it
    check([o.dataDir], /%/);
    const p = path.win32;
    const dir = p.join(o.dataDir, 'duty');
    const cmdPath = p.join(dir, 'duty.cmd');
    const vbsPath = p.join(dir, 'duty.vbs');
    const xmlPath = p.join(dir, 'duty.xml');
    const stopFile = p.join(dir, 'duty.stop');
    const pidFile = p.join(dir, 'duty.pid');
    const log = p.join(o.dataDir, 'duty.log');
    // inside a .cmd file %% is a literal %
    const pct = (s: string) => s.replace(/%/g, '%%');
    const cmd = [
      '@echo off',
      // read the rest of this file as UTF-8 (user names with non-ASCII letters)
      'chcp 65001 >nul',
      ...Object.entries(env).map(([k, v]) => `set "${k}=${pct(v)}"`),
      // "& exit /b" on the same line: the vbs may rewrite this file while the server runs, and cmd reads the
      // next line by byte offset — so there is no next line
      `"${pct(o.nodeBin)}" "${pct(o.serverEntry)}" >> "${pct(log)}" 2>&1 & exit /b`,
      '',
    ].join('\r\n');
    const vs = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const vbs = [
      "' Claude Web duty: run duty.cmd hidden, again 30 s after it ends, until duty.stop appears or duty.cmd is gone",
      'Option Explicit',
      'Dim sh, fso, cmdFile, stopFile, logFile',
      'Set sh = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `cmdFile = ${vs(cmdPath)}`,
      `stopFile = ${vs(stopFile)}`,
      `logFile = ${vs(log)}`,
      'Do',
      '  If fso.FileExists(stopFile) Or Not fso.FileExists(cmdFile) Then Exit Do',
      // duty.log stays under 1 MB (one old copy): rotated here, between runs, while nothing holds it open — a BUSY
      // line every 30 s while the app is open, and the duty server's whole output, would otherwise grow it for good
      '  On Error Resume Next',
      '  If fso.FileExists(logFile) Then',
      '    If fso.GetFile(logFile).Size > 1048576 Then fso.CopyFile logFile, logFile & ".1", True: fso.DeleteFile logFile, True',
      '  End If',
      '  On Error GoTo 0',
      // window style 0 = hidden, True = wait
      '  sh.Run "cmd.exe /d /s /c """"" & cmdFile & """""", 0, True',
      '  If fso.FileExists(stopFile) Or Not fso.FileExists(cmdFile) Then Exit Do',
      '  WScript.Sleep 30000',
      'Loop',
      // tell whoever asked us to stop that we did
      'If fso.FileExists(stopFile) Then fso.DeleteFile stopFile, True',
      '',
    ].join('\r\n');
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
      commands: [`schtasks /Create /TN "${TASK}" /XML "${xmlPath}" /F`, `schtasks /Run /TN "${TASK}"`],
      uninstall: [`schtasks /Delete /TN "${TASK}" /F`],
      selfRestart: '',
      selfStop: '',
      pidFile,
      stopFile,
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
      // launchd's default is 10 s; a duty server that steps aside exits at once
      '  <key>ThrottleInterval</key><integer>30</integer>',
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
      commands: [`launchctl load -w ${sq(plist)}`],
      uninstall: [`launchctl unload -w ${sq(plist)}`],
      // the detached shell has its own session, so it outlives the unload that kills the server
      selfRestart: `launchctl unload -w ${sq(plist)}; launchctl load -w ${sq(plist)}`,
      selfStop: `launchctl unload -w ${sq(plist)} && rm -f ${sq(plist)}`,
    };
  }

  const p = path.posix;
  const unit = p.join(o.home, '.config', 'systemd', 'user', `${UNIT}.service`);
  // systemd: % starts a specifier; inside "…" backslash is an escape (" was rejected above)
  const q = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`;
  // …and ExecStart expands $VAR / ${VAR} (Environment= doesn't): $$ is a literal $ there
  const qx = (v: string) => q(v).replace(/\$/g, '$$$$');
  const content = [
    '[Unit]',
    'Description=Claude Web duty (bots keep running with no window)',
    // it exits at once while the app serves the dir: never give up restarting it
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    `ExecStart=${qx(o.nodeBin)} ${qx(o.serverEntry)}`,
    'Restart=always',
    'RestartSec=30',
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
    // systemd kills the whole cgroup (the detached shell too), so the stop / restart is the last command
    selfRestart: `systemctl --user daemon-reload && systemctl --user enable ${UNIT} && systemctl --user restart ${UNIT}`,
    selfStop: `systemctl --user disable ${UNIT} && rm -f ${sq(unit)} && systemctl --user daemon-reload && systemctl --user stop ${UNIT}`,
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

/** fire and forget: keeps going after this process is gone */
function runDetached(command: string) {
  spawn(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * where dist's bots/duty.js finds the duty entry (dist/bots/duty-entry.js): it checks server.lock before loading the
 * whole server, so a duty server that has to step aside (every 30 s while the app is open) costs almost nothing
 */
function serverEntry() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'duty-entry.js');
}

function currentPlan(): DutyPlan {
  const env: Record<string, string> = {};
  // in the desktop app process.execPath is Electron: run it as plain node (it can still read app.asar, node can't)
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  for (const k of ['CLAUDE_WEB_DIST', 'CLAUDE_WEB_SIDECARS', 'CLAUDE_WEB_ENGINES', 'CLAUDE_WEB_SYSTEM_LANG']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  // a LaunchAgent / user unit starts with a bare PATH (no node, git, claude); quotes in PATH entries do nothing useful
  if (process.env.PATH) env.PATH = process.env.PATH.replace(/"/g, '');
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

/** Called by the server at startup: under the Windows duty task, note our pid so "off" can stop us. */
export function noteDutyPid() {
  if (process.env.CLAUDE_WEB_DUTY !== '1' || process.platform !== 'win32') return;
  try {
    const file = path.join(dataDir(), 'duty', 'duty.pid');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(process.pid));
  } catch {
    /* best effort */
  }
}

async function writeFile(file: string, content: string) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Task Scheduler XML says UTF-16; wscript reads a .vbs as ANSI unless it is UTF-16 with a BOM
  if (/\.(xml|vbs)$/i.test(file)) await fs.promises.writeFile(file, Buffer.from('\ufeff' + content, 'utf16le'));
  else await fs.promises.writeFile(file, content, 'utf8');
}

async function removeFiles(plan: DutyPlan, io: DutyIo = IO) {
  const all = [...plan.files.map((f) => f.path), ...(plan.pidFile ? [plan.pidFile] : [])];
  for (const f of all) await fs.promises.rm(f, { force: true }).catch(() => {});
  if (plan.platform === 'win32') await fs.promises.rmdir(path.dirname(plan.files[0].path)).catch(() => {});
  if (plan.platform === 'linux') await io.run('systemctl --user daemon-reload');
}

/** win32: the duty server's pid if it is alive and still the program we registered (not a reused pid) */
async function winDutyPid(plan: DutyPlan, io: DutyIo): Promise<number | null> {
  const pid = Number(await fs.promises.readFile(plan.pidFile!, 'utf8').catch(() => ''));
  if (!pid || pid === process.pid) return null;
  const r = await io.run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
  const image = /^"([^"]+)","(\d+)"/m.exec(r.out);
  return image && Number(image[2]) === pid && image[1].toLowerCase() === path.basename(process.execPath).toLowerCase() ? pid : null;
}

/** win32: stop a running duty server (not this process) and wait for its loop to end */
async function winStop(plan: DutyPlan, io: DutyIo = IO) {
  const pid = await winDutyPid(plan, io);
  if (pid) {
    await fs.promises.writeFile(plan.stopFile!, '');
    await io.run(`taskkill /T /F /PID ${pid}`);
    // the vbs deletes the marker when it sees it and ends
    for (let i = 0; i < 40 && fs.existsSync(plan.stopFile!); i++) await sleep(250);
  }
  await fs.promises.rm(plan.stopFile!, { force: true }).catch(() => {});
  await fs.promises.rm(plan.pidFile!, { force: true }).catch(() => {});
}

/** the side effects dutyOn has, so a test can fake them */
export interface DutyIo { run(command: string): Promise<{ code: number; out: string }>; writeFile(file: string, content: string): Promise<void> }
const IO: DutyIo = { run, writeFile };

const failed = (c: string, out: string) => `${c}\n${out}`;

/** Turn the duty service on (write files, register, start) or off (unregister, stop, delete files). */
export async function installDuty(on: boolean): Promise<{ ok: boolean; detail: string }> {
  if (on && (process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE)) {
    return { ok: false, detail: tr('便携版不能注册值班服务：它的文件在程序退出后就不在了。请先安装正式版') };
  }
  let plan: DutyPlan;
  try {
    plan = currentPlan();
  } catch (e) {
    if (e instanceof DutyCharError) return { ok: false, detail: tr('路径或环境变量里有值班服务没法处理的字符（" 或 %）：{value}', { value: e.value }) };
    throw e;
  }
  // called from inside the duty server: stopping the service stops us, so that step runs last and detached
  const self = process.env.CLAUDE_WEB_DUTY === '1';
  if (on && !fs.existsSync(serverEntry())) {
    return { ok: false, detail: tr('找不到服务端入口 {path}（开发模式下先 npm run build）', { path: serverEntry() }) };
  }
  return on ? dutyOn(plan, self) : dutyOff(plan, self);
}

/** exported for tests (io faked); installDuty is the way in */
export async function dutyOn(plan: DutyPlan, self: boolean, io: DutyIo = IO): Promise<{ ok: boolean; detail: string }> {
  const win = plan.platform === 'win32';
  // stop the old one first so the new files take effect
  if (!self) {
    if (win) await winStop(plan, io);
    else if (await dutyInstalled(io)) for (const c of plan.uninstall) await io.run(c);
  }
  if (win) await fs.promises.rm(plan.stopFile!, { force: true }).catch(() => {});
  try {
    for (const f of plan.files) await io.writeFile(f.path, f.content);
  } catch (e) {
    if (!self) {
      // Windows: winStop stopped the server but the logon task is still registered — it must not outlive its files
      // (a wscript error box at every logon). Unregister it first; if that fails, keep the files it points at.
      let unregistered = true;
      if (win) for (const u of plan.uninstall) if ((await io.run(u)).code !== 0) unregistered = false;
      if (unregistered) await removeFiles(plan, io);
    }
    return { ok: false, detail: tr('写入值班文件失败：{error}', { error: (e as Error).message }) };
  }
  const ok = { ok: true, detail: tr('已注册值班服务，登录后自动在后台运行（日志：{log}）', { log: path.join(dataDir(), 'duty.log') }) };
  if (self) {
    if (win) {
      // re-register (the task may have been deleted by hand), then end this server: the loop starts the new duty.cmd in 30 s
      const r = await io.run(plan.commands[0]);
      if (r.code !== 0) return { ok: false, detail: tr('注册值班服务失败：{detail}', { detail: failed(plan.commands[0], r.out) }) };
      runDetached(`taskkill /T /F /PID ${process.pid}`);
    } else runDetached(plan.selfRestart);
    return ok;
  }
  for (const c of plan.commands) {
    const r = await io.run(c);
    if (r.code !== 0) {
      // leave nothing half-done
      for (const u of plan.uninstall) await io.run(u);
      if (win) await winStop(plan, io);
      await removeFiles(plan, io);
      return { ok: false, detail: tr('注册值班服务失败：{detail}', { detail: failed(c, r.out) }) };
    }
  }
  return ok;
}

async function dutyOff(plan: DutyPlan, self: boolean): Promise<{ ok: boolean; detail: string }> {
  const win = plan.platform === 'win32';
  if (self && !win) {
    // the detached chain deletes the file only after the unregister worked
    runDetached(plan.selfStop);
    return { ok: true, detail: tr('已取消值班服务') };
  }
  if (await dutyInstalled()) {
    for (const c of plan.uninstall) {
      const r = await run(c);
      // keep the files: a registered task must never point at a deleted script
      if (r.code !== 0) return { ok: false, detail: tr('取消值班服务时出错：{detail}', { detail: failed(c, r.out) }) };
    }
  }
  if (self) {
    // win32, from inside: the loop ends on the marker; the kill is the very last step (taskkill /T takes its own shell with it)
    await fs.promises.writeFile(plan.stopFile!, '').catch(() => {});
    for (const f of [...plan.files.map((x) => x.path), plan.pidFile!]) await fs.promises.rm(f, { force: true }).catch(() => {});
    runDetached(`taskkill /T /F /PID ${process.pid}`);
    return { ok: true, detail: tr('已取消值班服务') };
  }
  if (win) await winStop(plan);
  await removeFiles(plan);
  return { ok: true, detail: tr('已取消值班服务') };
}

/** the command that starts the registered duty service now (the app quitting hands the dir back to it) */
export function dutyStartCommand(platform: NodeJS.Platform, uid?: number): string {
  if (platform === 'win32') return `schtasks /Run /TN "${TASK}"`;
  if (platform === 'darwin') return `launchctl kickstart -k gui/${uid ?? 0}/${LABEL}`;
  return `systemctl --user start ${UNIT}`;
}

/** the service file registered for duty mode serves this data dir (not another one's — a test's temporary HOME) */
function servesThisDir(plan: DutyPlan): boolean {
  const f = plan.files[0];
  const marker = f.content.split(/\r?\n/).find((l) => l.includes('CLAUDE_WEB_DIR'));
  try { return !!marker && fs.readFileSync(f.path, 'utf8').includes(marker.trim()); } catch { return false; }
}

/**
 * An app / dev server that quit cleanly: if duty mode is on for this data dir, start the duty service again now
 * (best effort; the loop would also start it within 30 s on Windows, and launchd / systemd keep it alive).
 */
export async function restartDutyAfterApp(io: DutyIo = IO): Promise<boolean> {
  if (process.env.CLAUDE_WEB_DUTY === '1') return false;
  let plan: DutyPlan;
  try { plan = currentPlan(); } catch { return false; }
  if (!servesThisDir(plan) || !(await dutyInstalled(io))) return false;
  return (await io.run(dutyStartCommand(plan.platform, process.getuid?.()))).code === 0;
}

/** a service file as text (the .vbs / .xml are UTF-16 with a BOM) */
function readServiceFile(file: string): string | undefined {
  let b: Buffer;
  try { b = fs.readFileSync(file); } catch { return undefined; }
  return b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b.toString('utf8');
}

/**
 * The service files of a registered duty mode for this data dir, brought up to this version (a new back-off, the
 * duty entry): each one that is there and differs is written again. Only files that exist — nothing is registered
 * here. Linux reloads the unit definitions (no restart); launchd and Task Scheduler read theirs at the next start.
 * Exported for tests; refreshDutyFiles is the way in.
 */
export async function refreshDutyFilesFor(plan: DutyPlan, io: DutyIo = IO): Promise<string[]> {
  if (!servesThisDir(plan)) return [];
  const changed: string[] = [];
  for (const f of plan.files) {
    const cur = readServiceFile(f.path);
    if (cur === undefined || cur === f.content) continue;
    await io.writeFile(f.path, f.content);
    changed.push(f.path);
  }
  if (changed.length && plan.platform === 'linux') await io.run('systemctl --user daemon-reload');
  return changed;
}
/** the duty server at startup: its own service files, written by an older version, rewritten (best effort) */
export async function refreshDutyFiles(): Promise<string[]> {
  if (process.env.CLAUDE_WEB_DUTY !== '1' || !fs.existsSync(serverEntry())) return [];
  let plan: DutyPlan;
  try { plan = currentPlan(); } catch { return []; }
  return refreshDutyFilesFor(plan);
}

/** Is the duty service registered? */
export async function dutyInstalled(io: DutyIo = IO): Promise<boolean> {
  if (process.platform === 'win32') return (await io.run(`schtasks /Query /TN "${TASK}"`)).code === 0;
  if (process.platform === 'darwin') return (await io.run(`launchctl list ${LABEL}`)).code === 0;
  return (await io.run(`systemctl --user is-enabled ${UNIT}`)).code === 0;
}
