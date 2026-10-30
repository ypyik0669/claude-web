import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { dutyPlan, dutyOn, DutyCharError, restartDutyAfterApp } from './duty.js';

const o = { nodeBin: '/usr/bin/node', serverEntry: '/app/server/dist/index.js', dataDir: '/home/me/.claude-web', port: 3090, home: '/home/me' };
const win = {
  ...o,
  platform: 'win32' as const,
  nodeBin: 'C:\\Program Files\\Claude Web\\Claude Web.exe',
  serverEntry: 'C:\\app\\index.js',
  dataDir: 'C:\\Users\\Jo Smith\\.claude-web',
  home: 'C:\\Users\\Jo Smith',
  user: 'PC\\Jo Smith',
};

describe('dutyPlan', () => {
  it('windows: a hidden logon task (wscript loops duty.vbs → duty.cmd sets the env and runs the server)', () => {
    const p = dutyPlan({ ...win, env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_WEB_TOKEN: 'secret' } });
    const cmd = p.files.find((f) => f.path.endsWith('duty.cmd'))!;
    const vbs = p.files.find((f) => f.path.endsWith('duty.vbs'))!;
    const xml = p.files.find((f) => f.path.endsWith('duty.xml'))!;
    expect(cmd.path).toBe('C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.cmd');
    expect(vbs.path).toBe('C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.vbs');
    expect(p.stopFile).toBe('C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.stop');
    expect(p.pidFile).toBe('C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.pid');
    expect(cmd.content).toContain('set "CLAUDE_WEB_DIR=C:\\Users\\Jo Smith\\.claude-web"');
    expect(cmd.content).toContain('set "PORT=3090"');
    expect(cmd.content).toContain('set "CLAUDE_WEB_STANDALONE=1"');
    expect(cmd.content).toContain('set "CLAUDE_WEB_DUTY=1"');
    expect(cmd.content).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    // the server line is the last one and ends the batch, so rewriting the file under a running server is safe
    expect(cmd.content.trimEnd().split('\r\n').at(-1)).toBe(
      '"C:\\Program Files\\Claude Web\\Claude Web.exe" "C:\\app\\index.js" >> "C:\\Users\\Jo Smith\\.claude-web\\duty.log" 2>&1 & exit /b',
    );
    expect(cmd.content).not.toContain('CLAUDE_WEB_TOKEN');
    expect(cmd.content).not.toContain('secret');
    // the vbs loops: hidden + wait, 30 s between rounds (a duty server that steps aside exits at once), ends on the stop marker or a missing duty.cmd, consumes the marker
    expect(vbs.content).toContain('cmdFile = "C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.cmd"');
    expect(vbs.content).toContain('stopFile = "C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.stop"');
    expect(vbs.content).toContain('sh.Run "cmd.exe /d /s /c """"" & cmdFile & """""", 0, True');
    expect(vbs.content).toContain('If fso.FileExists(stopFile) Or Not fso.FileExists(cmdFile) Then Exit Do');
    expect(vbs.content).toContain('WScript.Sleep 30000');
    expect(vbs.content).not.toContain('WScript.Sleep 5000');
    expect(vbs.content).toContain('If fso.FileExists(stopFile) Then fso.DeleteFile stopFile, True');
    // a plain /SC ONLOGON needs admin; an XML task whose logon trigger is for this user doesn't
    expect(p.commands).toEqual([
      'schtasks /Create /TN "ClaudeWebDuty" /XML "C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.xml" /F',
      'schtasks /Run /TN "ClaudeWebDuty"',
    ]);
    expect(xml.content).toContain('<LogonTrigger><Enabled>true</Enabled><UserId>PC\\Jo Smith</UserId></LogonTrigger>');
    expect(xml.content).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml.content).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml.content).toContain('<Command>wscript.exe</Command><Arguments>&quot;C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.vbs&quot;</Arguments>');
    expect(p.uninstall).toEqual(['schtasks /Delete /TN "ClaudeWebDuty" /F']);
  });

  it('windows escaping: % doubled in the .cmd, & safe inside set "…", & < in the user escaped in the XML', () => {
    const p = dutyPlan({ ...win, nodeBin: 'C:\\50%\\node.exe', env: { X: 'a%b&c' }, user: 'PC\\A&B<' });
    const cmd = p.files[0].content;
    expect(cmd).toContain('set "X=a%%b&c"');
    expect(cmd).toContain('"C:\\50%%\\node.exe"');
    expect(p.files[2].content).toContain('<UserId>PC\\A&amp;B&lt;</UserId>');
  });

  it('windows refuses a data dir with % (Run / cmd /c / Task Scheduler expand it) and any value with "', () => {
    expect(() => dutyPlan({ ...win, dataDir: 'C:\\%USERNAME%\\.claude-web' })).toThrow(DutyCharError);
    expect(() => dutyPlan({ ...win, env: { X: 'a"b' } })).toThrow(DutyCharError);
  });

  it('macos: a LaunchAgent plist loaded with launchctl', () => {
    const p = dutyPlan({ ...o, platform: 'darwin', env: { CLAUDE_WEB_DIST: '/app/web/dist', PATH: '/usr/bin:/bin' } });
    expect(p.files[0].path).toBe('/home/me/Library/LaunchAgents/app.claude-web.duty.plist');
    expect(p.files[0].content).toContain('<string>/app/server/dist/index.js</string>');
    expect(p.files[0].content).toContain('<key>KeepAlive</key>');
    expect(p.files[0].content).toContain('<key>ThrottleInterval</key><integer>30</integer>');
    expect(p.files[0].content).toContain('<key>CLAUDE_WEB_DIR</key><string>/home/me/.claude-web</string>');
    expect(p.files[0].content).toContain('<key>PORT</key><string>3090</string>');
    expect(p.files[0].content).toContain('<key>CLAUDE_WEB_DUTY</key><string>1</string>');
    expect(p.files[0].content).toContain('<key>CLAUDE_WEB_DIST</key><string>/app/web/dist</string>');
    expect(p.files[0].content).toContain('<key>PATH</key><string>/usr/bin:/bin</string>');
    expect(p.files[0].content).toContain('<string>/home/me/.claude-web/duty.log</string>');
    expect(p.commands).toEqual(["launchctl load -w '/home/me/Library/LaunchAgents/app.claude-web.duty.plist'"]);
    expect(p.uninstall).toEqual(["launchctl unload -w '/home/me/Library/LaunchAgents/app.claude-web.duty.plist'"]);
    // from inside the service: the file goes only after the unload worked
    expect(p.selfStop).toBe("launchctl unload -w '/home/me/Library/LaunchAgents/app.claude-web.duty.plist' && rm -f '/home/me/Library/LaunchAgents/app.claude-web.duty.plist'");
    expect(p.selfRestart).toMatch(/^launchctl unload -w .*; launchctl load -w /);
  });

  it("macos escaping: XML entities in the plist, ' in the shell commands", () => {
    const p = dutyPlan({ ...o, platform: 'darwin', home: "/Users/o'neil", serverEntry: '/a&b/<x>/index.js' });
    expect(p.files[0].content).toContain('<string>/a&amp;b/&lt;x&gt;/index.js</string>');
    expect(p.commands[0]).toBe("launchctl load -w '/Users/o'\\''neil/Library/LaunchAgents/app.claude-web.duty.plist'");
  });

  it('linux: a systemd user unit', () => {
    const p = dutyPlan({ ...o, platform: 'linux', env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(p.files[0].path).toBe('/home/me/.config/systemd/user/claude-web-duty.service');
    expect(p.files[0].content).toContain('ExecStart="/usr/bin/node" "/app/server/dist/index.js"');
    expect(p.files[0].content).toContain('Restart=always');
    expect(p.files[0].content).toContain('RestartSec=30');
    expect(p.files[0].content).toContain('StartLimitIntervalSec=0');
    expect(p.files[0].content).not.toContain('After=');
    expect(p.files[0].content).toContain('Environment="CLAUDE_WEB_DIR=/home/me/.claude-web"');
    expect(p.files[0].content).toContain('Environment="PORT=3090"');
    expect(p.files[0].content).toContain('Environment="ELECTRON_RUN_AS_NODE=1"');
    expect(p.commands).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now claude-web-duty']);
    expect(p.uninstall).toEqual(['systemctl --user disable --now claude-web-duty']);
    // from inside the service: systemd kills the cgroup, so the stop / restart is the last command
    expect(p.selfStop).toBe(
      "systemctl --user disable claude-web-duty && rm -f '/home/me/.config/systemd/user/claude-web-duty.service' && systemctl --user daemon-reload && systemctl --user stop claude-web-duty",
    );
    expect(p.selfRestart.endsWith('systemctl --user restart claude-web-duty')).toBe(true);
  });

  it('linux escaping: % doubled and \\ escaped inside the quoted unit values', () => {
    const p = dutyPlan({ ...o, platform: 'linux', serverEntry: '/opt/50%/index.js', env: { X: 'a\\b' } });
    expect(p.files[0].content).toContain('ExecStart="/usr/bin/node" "/opt/50%%/index.js"');
    expect(p.files[0].content).toContain('Environment="X=a\\\\b"');
    expect(() => dutyPlan({ ...o, platform: 'linux', env: { X: 'a"b' } })).toThrow(DutyCharError);
    expect(() => dutyPlan({ ...o, platform: 'linux', env: { X: 'a\nb' } })).toThrow(DutyCharError);
  });

  it('never lets the port be 0 (the phone has to find it)', () => {
    const p = dutyPlan({ ...o, platform: 'linux', port: 0 });
    expect(p.files[0].content).toContain('Environment="PORT=3090"');
  });
});

describe('dutyOn: a failed file write', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-duty-'));
    const plan = dutyPlan({ ...win, dataDir: dir });
    const ran: string[] = [];
    const io = (uninstallCode: number) => ({
      run: async (c: string) => { ran.push(c); return { code: c.includes('/Delete') ? uninstallCode : 0, out: '' }; },
      // duty.cmd lands, duty.vbs fails (disk full, a locked file)
      writeFile: async (f: string, content: string) => { if (f.endsWith('.vbs')) throw new Error('disk full'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); },
    });
    return { dir, plan, ran, io };
  };
  it('windows: the logon task is unregistered before its files are deleted', async () => {
    const { dir, plan, ran, io } = setup();
    try {
      const r = await dutyOn(plan, false, io(0));
      expect(r.ok).toBe(false);
      expect(ran).toContain('schtasks /Delete /TN "ClaudeWebDuty" /F');
      expect(fs.existsSync(plan.files[0].path)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('windows: if the task cannot be unregistered, the files it points at stay', async () => {
    const { dir, plan, io } = setup();
    try {
      expect((await dutyOn(plan, false, io(1))).ok).toBe(false);
      expect(fs.existsSync(plan.files[0].path)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('restartDutyAfterApp: the app quitting hands the dir back to the duty service', () => {
  it('does nothing when duty mode is not on for this data dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-duty-'));
    const prev = process.env.CLAUDE_WEB_DIR; process.env.CLAUDE_WEB_DIR = dir;
    const ran: string[] = [];
    try {
      expect(await restartDutyAfterApp({ run: async (c) => { ran.push(c); return { code: 0, out: '' }; }, writeFile: async () => {} })).toBe(false);
      expect(ran).toEqual([]);
    } finally { if (prev === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prev; fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.runIf(process.platform === 'win32')('windows: duty.cmd for this dir and the task registered → the task is run now', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-duty-'));
    const prev = process.env.CLAUDE_WEB_DIR; process.env.CLAUDE_WEB_DIR = dir;
    const ran: string[] = [];
    try {
      fs.mkdirSync(path.join(dir, 'duty'));
      fs.writeFileSync(path.join(dir, 'duty', 'duty.cmd'), `@echo off\r\nset "CLAUDE_WEB_DIR=${dir}"\r\n`);
      expect(await restartDutyAfterApp({ run: async (c) => { ran.push(c); return { code: 0, out: '' }; }, writeFile: async () => {} })).toBe(true);
      expect(ran).toEqual(['schtasks /Query /TN "ClaudeWebDuty"', 'schtasks /Run /TN "ClaudeWebDuty"']);
    } finally { if (prev === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prev; fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
